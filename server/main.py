from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from paddleocr import PaddleOCR
import base64
import numpy as np
import cv2
import uvicorn
import os
import requests
import asyncio
import json
from collections import deque, defaultdict
from typing import Optional, List, Dict

# Fix PaddleOCR Crash (Disable PIR and oneDNN)
os.environ["FLAGS_enable_pir_api"] = "0"
os.environ["FLAGS_allocator_strategy"] = 'naive_best_fit'
os.environ["CUSTOM_DEVICE_BLACK_LIST"] = "true"
# FORCE ORC TO CPU ONLY (Hide GPU from Paddle)
os.environ["CUDA_VISIBLE_DEVICES"] = "" 

app = FastAPI()

# Add CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- 1. Resource Optimization (CPU for OCR, GPU for LLM) ---
common_params = {
    # 'use_gpu': False, # REMOVED: Incompatible with new PaddleX
    'device': 'cpu',    # Supported by some versions, but env var above is safer
    'use_textline_orientation': False,
    'use_doc_orientation_classify': False, 
    'use_doc_unwarping': False,
    'enable_mkldnn': False, # Keep off for stability
    'ocr_version': 'PP-OCRv3',
    'cls_model_dir': None, 
}

print("👉 Initializing PaddleOCR on CPU (to save GPU for Ollama)...")
ocr_engines = {
    'korean': PaddleOCR(lang='korean', **common_params),
    'japan': PaddleOCR(lang='japan', **common_params),
    'chinese': PaddleOCR(lang='ch', **common_params),
    'en': PaddleOCR(lang='en', **common_params)
}

# --- 2. API Models (Must be defined before usage) ---
class OCRRequest(BaseModel):
    image_base64: str
    lang: str = 'korean'

class OCRResponse(BaseModel):
    text: str
    confidence: float

class TranslateRequest(BaseModel):
    text: str
    session_id: str = "default"
    target_lang: str = 'zh'

# --- 3. Translation Manager ---
class TranslationManager:
    def __init__(self):
        self.sessions: Dict[str, deque] = defaultdict(lambda: deque(maxlen=10))
        # Store user corrections as few-shot examples (per session)
        self.user_corrections: Dict[str, List[tuple]] = defaultdict(list)
        # Store the very last translation for context continuity (session_id -> (orig, translated))
        self.last_context: Dict[str, tuple] = {} 
        
        self.lock = asyncio.Lock() # Global lock for LLM sequential access
        
        self.DATA_FILE = "user_data.json"
        self.load_data()

    def load_data(self):
        """Load corrections from disk."""
        if os.path.exists(self.DATA_FILE):
            try:
                with open(self.DATA_FILE, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    
                    # Fix: Handle both structures (nested under "user_corrections" or flat)
                    if "user_corrections" in data:
                        # Old/Nested Structure
                        for sid, items in data["user_corrections"].items():
                            self.user_corrections[sid] = items
                    else:
                        # Flat Structure (Current user_data.json)
                        # We assume top-level keys are session_ids if they contain lists
                        for sid, items in data.items():
                            if isinstance(items, list):
                                self.user_corrections[sid] = items
                                
                print(f"📂 Loaded corrections for sessions: {list(self.user_corrections.keys())}")
            except Exception as e:
                print(f"⚠️ Failed to load user data: {e}")

    def save_data(self):
        try:
            with open(self.DATA_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.user_corrections, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"⚠️ Failed to save user data: {e}")

    def is_valid_chinese_translation(self, text: str) -> bool:
        # Relaxed filter: Allow everything (Chinese, English, Numbers, Punctuation)
        # BUT strictly ban Korean characters (to prevent raw OCR pass-through)
        if not text or not text.strip():
            return False
            
        import re
        # Range for Hangul Jamo and Syllables
        has_korean = bool(re.search(r'[\uac00-\ud7af]', text))
        
        return not has_korean

    def update_history(self, session_id: str, original: str, translated: str):
        # Update Runtime Context (For next prompt)
        # Only update if translation seems valid
        if self.is_valid_chinese_translation(translated):
            self.last_context[session_id] = (original, translated)
            print(f"🧠 Context Updated: '{translated}'")
    
    def record_correction(self, session_id: str, original: str, corrected: str):
        # Validation: Don't learn if correction is not Chinese
        if not self.is_valid_chinese_translation(corrected):
            print(f"⚠️ Ignoring correction: '{corrected}' (Not valid Chinese)")
            return

        # 1. Update Persistent History (Few-Shot data)
        updated = False
        def normalize(t): return t.replace('\n', '').replace(' ', '').strip()
        normalized_original = normalize(original)
        
        for i, (existing_orig, existing_corr) in enumerate(self.user_corrections[session_id]):
            if normalize(existing_orig) == normalized_original:
                # Update existing entry
                self.user_corrections[session_id][i] = (original, corrected)
                print(f"📝 Few-Shot Updated: '{original}' -> '{corrected}'")
                updated = True
                break
        
        if not updated:
            # Add new entry
            self.user_corrections[session_id].append((original, corrected))
            print(f"📝 Few-Shot Added: '{original}' -> '{corrected}'")
        
        self.save_data()
        
        # 2. Update Runtime Context
        self.last_context[session_id] = (original, corrected)
        print(f"🧠 Context Updated: Previous line is now '{corrected}'")

    def build_prompt(self, text: str, session_id: str) -> str:
        # Minimalist Prompt (Example-Driven) - Reverted to Stable Version
        has_linebreaks = '\n' in text
        if has_linebreaks:
            prompt = "你是韩漫翻译助手。请根据历史修正，精准、口语化地翻译。**重要：保持原文的换行格式**。\n\n"
        else:
            prompt = "你是韩漫翻译助手。请根据历史修正，精准、口语化地翻译：\n\n"
        
        # User Corrections (Few-Shot Style Guide)
        corrections = self.user_corrections.get(session_id, [])
        
        if corrections:
            # Smart Sampling: Hybrid Strategy (Text Similarity + Recency)
            import difflib
            def get_similarity(item): return difflib.SequenceMatcher(None, item[0], text).ratio()
            
            # Sort by similarity
            scored = sorted(corrections, key=get_similarity, reverse=True)
            similar_candidates = [item for item in scored if get_similarity(item) > 0.2]
            
            # Selection Set 1: Top 5 Similar
            selection = []
            seen_originals = set()
            for item in similar_candidates[:5]:
                selection.append(item)
                seen_originals.add(item[0])
            
            # Selection Set 2: Recent Corrections (Fill remaining slots)
            recent_candidates = reversed(corrections)
            for item in recent_candidates:
                if len(selection) >= 15: break
                if item[0] not in seen_originals:
                    selection.append(item)
                    seen_originals.add(item[0])
            
            # Re-rank final selection: Least similar -> Most similar
            selected = sorted(selection, key=get_similarity) 

            prompt += "### 参考历史修正（你的翻译风格指南）：\n"
            for orig, corrected in selected:
                # Truncate very long examples to save context
                s_orig = (orig[:30] + '..') if len(orig) > 30 else orig
                s_corr = (corrected[:30] + '..') if len(corrected) > 30 else corrected
                # Clean up newlines for prompt compactness
                s_orig = s_orig.replace('\n', ' ')
                s_corr = s_corr.replace('\n', ' ')
                prompt += f"原文：{s_orig} -> 译文：{s_corr}\n"
            prompt += "\n"
 
        # Context Injection (Simpler, just the last line)
        if session_id in self.last_context:
            prev_orig, prev_trans = self.last_context[session_id]
            if len(prev_orig) < 100:
                prompt += f"### 前情提要（上一句）：\n原文：{prev_orig}\n译文：{prev_trans}\n\n"

        # Target
        prompt += f"待译原文：{text}\n翻译结果："
        return prompt


translation_manager = TranslationManager()


# --- 4. Endpoints ---

@app.get("/")
def health_check():
    return {"status": "running", "engines": list(ocr_engines.keys())}

@app.post("/ocr", response_model=OCRResponse)
async def perform_ocr(request: OCRRequest):
    try:
        # Decode base64
        img_str = request.image_base64
        if "," in img_str:
            img_str = img_str.split(",")[1]
        
        img_bytes = base64.b64decode(img_str)
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img is None:
            raise HTTPException(status_code=400, detail="Failed to decode image")

        # --- PRE-PROCESSING FOR BETTER OCR ---
        # 1. Padding: Add 10px white border (Helps PaddleOCR with edge characters)
        pad = 10
        img = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=[255, 255, 255])
        
        # NO OTHER PRE-PROCESSING (Raw image is best for varied art styles)
        # Filters removed as per user request.

        # Select Engine
        lang = request.lang.lower()
        engine = ocr_engines.get(lang)
        if not engine:
            if 'kor' in lang: engine = ocr_engines['korean']
            elif 'jap' in lang: engine = ocr_engines['japan']
            else: engine = ocr_engines['en']

        # Run OCR
        print(f"👉 OCR Request ({lang}) after pre-process: {img.shape}")
        
        if hasattr(engine, 'use_angle_cls'): engine.use_angle_cls = False
            
        result = engine.ocr(img)
        print(f"✅ Raw Result: {result}")

        full_text = []
        scores = []
        
        # Parse PaddleOCR result safely (Handles both Dict and List formats)
        if result and isinstance(result, list) and len(result) > 0:
            first_item = result[0]
            # Case 1: Legacy [[box, [text, score]], ...]
            if isinstance(first_item, list): 
                for line in first_item:
                    if len(line) >= 2:
                        full_text.append(line[1][0])
                        scores.append(line[1][1])
            # Case 2: New {'rec_texts': []} 
            elif isinstance(first_item, dict): 
                 full_text = first_item.get('rec_texts', [])
                 scores = first_item.get('rec_scores', [])
            # Case 3: Flat list [ [[box], [text, score]] ] sometimes happens
            # But the loop above usually covers it.

        final_text = "\n".join(full_text)
        avg_conf = sum(scores) / len(scores) if scores else 0.0
        
        return {"text": final_text, "confidence": avg_conf}

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/translate")
async def perform_translation(request: TranslateRequest):
    OLLAMA_URL = "http://localhost:11434/api/generate"
    MODEL_NAME = "qwen2.5:7b" 

    async with translation_manager.lock:
        try:
            import difflib
            # Keep original text with line breaks for translation
            original_text = request.text.strip()
            
            # 🎯 FUZZY MATCH CACHE: Hit historical corrections if similarity is high
            def get_similarity(s1, s2):
                """Calculate string similarity ratio"""
                return difflib.SequenceMatcher(None, s1, s2).ratio()

            def normalize(text):
                """Remove all whitespace for comparison"""
                return text.replace('\n', '').replace(' ', '').strip()
            
            normalized_current = normalize(original_text)
            
            if request.session_id in translation_manager.user_corrections:
                best_match = None
                highest_ratio = 0.0
                
                for orig, corrected in translation_manager.user_corrections[request.session_id]:
                    # Check exact match first (Fast)
                    norm_orig = normalize(orig)
                    if norm_orig == normalized_current:
                        print(f"✅ Exact Cache Hit: '{original_text[:20]}...'")
                        return {"translatedText": corrected, "is_learned": True}
                    
                    # Then check fuzzy match (Slower but smart)
                    ratio = get_similarity(norm_orig, normalized_current)
                    if ratio > highest_ratio:
                        highest_ratio = ratio
                        best_match = corrected

                # If similarity > 0.75, assume it's the same intention (skip LLM)
                if highest_ratio > 0.75:
                    print(f"✨ Fuzzy Cache Hit ({highest_ratio:.2f}): '{original_text[:20]}...'")
                    return {"translatedText": best_match, "is_learned": True}
                else:
                    print(f"💨 Cache Miss. Best Ratio: {highest_ratio:.2f}")
            
            # Pass original text (with line breaks) to LLM for better context
            full_prompt = translation_manager.build_prompt(
                original_text, 
                request.session_id
            )
            
            response = requests.post(OLLAMA_URL, json={
                "model": MODEL_NAME,
                "prompt": full_prompt,
                "stream": False,
                "options": {
                    "temperature": 0.6,
                    "repeat_penalty": 1.1,
                    "num_predict": 50, # Optimized: Manga/H-Manga lines are short
                    "stop": ["原文", "翻译", "\n\n", "：", "意思", "表示", "这里"] 
                }
            }, timeout=30)

            if response.status_code == 200:
                result = response.json()
                translated = result.get('response', '').strip()
                
                # Smart Line Break Matching: If original has multiple lines, split translation accordingly
                original_lines = [l for l in original_text.split('\n') if l.strip()]
                if len(original_lines) > 1 and '\n' not in translated:
                    # Split translation at punctuation marks
                    import re
                    segments = re.split(r'([，。！？；])', translated)
                    # Recombine punctuation with preceding text
                    parts = []
                    for i in range(0, len(segments)-1, 2):
                        if i+1 < len(segments):
                            parts.append(segments[i] + segments[i+1])
                        else:
                            parts.append(segments[i])
                    
                    # Distribute parts across lines (simple strategy: evenly distribute)
                    if parts:
                        lines_per_part = max(1, len(parts) // len(original_lines))
                        result_lines = []
                        for i in range(0, len(parts), lines_per_part):
                            result_lines.append(''.join(parts[i:i+lines_per_part]))
                        translated = '\n'.join(result_lines[:len(original_lines)])
                
                # Update history
                translation_manager.update_history(request.session_id, original_text, translated)
                
                print(f"🤖 Trans: {translated}")
                return {"translatedText": translated}
            else:
                print(f"❌ Ollama Error: {response.text}")
                return {"translatedText": request.text + " [LLM Err]"}

        except Exception as e:
            print(f"❌ Translation Failed: {e}")
            return {"translatedText": request.text + " [Fail]"}

class FeedbackRequest(BaseModel):
    original_text: str
    corrected_translation: str
    session_id: str = "default"

@app.post("/feedback")
async def receive_feedback(request: FeedbackRequest):
    """Receive user's corrected translation and store it as a learning sample."""
    try:
        translation_manager.record_correction(
            request.session_id,
            request.original_text,
            request.corrected_translation
        )
        return {"status": "success", "message": "Feedback received"}
    except Exception as e:
        print(f"❌ Feedback Error: {e}")
        return {"status": "error", "message": str(e)}

if __name__ == "__main__":
    print("🚀 Local Server Running (CPU OCR + GPU LLM)")
    uvicorn.run(app, host="127.0.0.1", port=8000)
