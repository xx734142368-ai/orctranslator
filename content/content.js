// Global variables
let isSelecting = false;
let startX, startY;
let selectionDiv = null;
let overlayDiv = null;
let statusBadge = null;

// Settings
let currentSourceLang = 'eng';
let currentTargetLang = 'zh-CN';
let isVerticalMode = false;
let debugModeActive = false;
let continuousMode = false; // F key: continuous translation mode

// Implicit Feedback Support
let pendingApprovals = []; // [{original, translated, timestamp, element}]

// SFX Mapping
const SFX_MAP = {
    '흐': '嗯', '으': '额', '하': '哈', '아': '啊', '후': '呼',
    '흐읏': '唔...', '하아': '哈啊...', '으읏': '呜唔...',
    '학': '呼...', '헙': '唔!', '윽': '呃!',
    '히익': '噫嘻!', '헤에': '嘿耶...', '호오': '嗬噢...',
    '철퍽': '啪嗒', '질척': '滋溜', '찌릿': '刺啦', '쿵': '咚',
    '팍': '啪', '촥': '唰', '툭': '秃',
    '흐응': '嗯...', '으응': '嗯...', '응': '嗯'
};

// Common Manga OCR Typos (Visual confusables - Manhwa specific)
const KOREAN_FIXES = [
    { from: /촘만/g, to: '좀만' },     // 'Wait a sec' (ㅊ -> ㅈ)
    { from: /잘못/g, to: '잘못' },
    { from: /웅/g, to: '응' },         // Cute 'Yes'
    { from: /그레/g, to: '그래' },
    { from: /머/g, to: '뭐' },
    { from: /%/g, to: '응' },
    { from: /\|/g, to: 'I' },
    { from: /하아/g, to: '하아..' },   // Fix breath inputs
    { from: /흐윽/g, to: '흐윽..' },
    // Aggressive Action Font Fixes
    { from: /OF/g, to: '야' },         // '야' recognized as 'OF'
    { from: /of/g, to: '야' },
    { from: /0F/g, to: '야' },
    { from: /\*!고/g, to: '최고' },    // '*!고' -> '최고' (Best)
    { from: /cl/g, to: '다' }          // 'da' confusion
];

// Domain-Specific Dictionary (Spicy/Manhwa Context)
// Overrides generic translation API with genre-appropriate terms
const GENRE_GLOSSARY = {
    // Basic Refusals/Pleas
    '안돼': '不行...',
    '하지마': '不要...',
    '이러지마': '不要这样...',
    '잠깐': '等一下...',
    '잠깐만': '等一下...',
    '좀만': '稍微再...',

    // Sensations/Feelings
    '기분좋아': '好舒服...',
    '좋아': '好棒...',
    '완전': '好...',      // Context: 'Really/Totally' -> 'So...'
    '최고': '最棒...',
    '최고야': '好舒服...', // Context specific translation
    '아파': '好痛...',
    '뜨거워': '好烫...',
    '이상해': '好奇怪...',
    '미칠것같아': '快疯了...',
    '쌀것같아': '要出来...', // Context specific
    '갈것같아': '要去...', // Context specific
    '가버려': '要去...',

    // Titles/Address
    '오빠': '欧巴', // Keep flavor or change to '哥哥'
    '누나': '姐姐',
    '선배': '前辈',
    '주인님': '主人...',

    // Exclamations
    '대박': '天呐...',
    '미쳤어': '疯了吗...',
    '진짜': '真...',
    '정말': '真的...'
};

// Load settings
chrome.storage.sync.get(['sourceLang', 'targetLang', 'isVertical'], (items) => {
    if (items.sourceLang) currentSourceLang = items.sourceLang;
    if (items.targetLang) currentTargetLang = items.targetLang;
    if (items.isVertical !== undefined) isVerticalMode = items.isVertical;
});

// Listener for commands
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startSelection') {
        if (request.sourceLang) currentSourceLang = request.sourceLang;
        if (request.targetLang) currentTargetLang = request.targetLang;
        if (request.isVertical !== undefined) isVerticalMode = request.isVertical;
        startSelectionMode();
        sendResponse({ status: 'ok' });
    }
    return true;
});

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key.toLowerCase() === 'f') {
        if (!continuousMode) {
            // Enter continuous mode
            continuousMode = true;
            updateStatusBadge(true);
            startSelectionMode();
            console.log('🔄 Continuous translation mode activated (press ESC to exit)');
        }
    } else if (e.key === 'Escape') {
        // Exit continuous mode
        if (continuousMode) {
            continuousMode = false;
            updateStatusBadge(false);
            cancelSelection();
            console.log('⏹️ Continuous translation mode deactivated');
        } else if (isSelecting) {
            cancelSelection();
        }
    }
});

function createOverlay() {
    if (overlayDiv) return;
    overlayDiv = document.createElement('div');
    overlayDiv.className = 'manga-translator-overlay';
    document.body.appendChild(overlayDiv);
    overlayDiv.addEventListener('mousedown', onMouseDown);
}

function startSelectionMode() {
    createOverlay();
    overlayDiv.style.display = 'block';
    document.body.style.cursor = 'crosshair';
}

function updateStatusBadge(show) {
    if (!statusBadge) {
        statusBadge = document.createElement('div');
        statusBadge.className = 'manga-translator-status-badge';
        statusBadge.innerHTML = `
            <svg viewBox="0 0 24 24"><path d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z"/></svg>
            <span>实时翻译模式已开启 (ESC 退出)</span>
        `;
        document.body.appendChild(statusBadge);
    }

    if (show) {
        statusBadge.classList.add('active');
    } else {
        statusBadge.classList.remove('active');
    }
}

function onMouseDown(e) {
    isSelecting = true;
    startX = e.clientX;
    startY = e.clientY;
    debugModeActive = e.ctrlKey;

    // Trigger Implicit Positive Feedback for previous translations
    confirmPendingApprovals();

    if (selectionDiv) selectionDiv.remove();
    selectionDiv = document.createElement('div');
    selectionDiv.className = 'manga-translator-selection';
    selectionDiv.style.left = startX + 'px';
    selectionDiv.style.top = startY + 'px';
    overlayDiv.appendChild(selectionDiv);

    overlayDiv.addEventListener('mousemove', onMouseMove);
    overlayDiv.addEventListener('mouseup', onMouseUp);
}

/**
 * Automatically approves translations that weren't edited.
 * Called when starting a new selection.
 */
async function confirmPendingApprovals() {
    const now = Date.now();
    const stillPending = [];

    for (const item of pendingApprovals) {
        // If it's been active for > 2 seconds and hasn't been removed/edited
        if (now - item.timestamp > 2000) {
            // Check if the element still exists and hasn't been edited
            const currentText = item.element.innerText.trim();
            // If the text matches the original AI translation, it's a positive vote
            if (currentText === item.aiTranslated) {
                console.log(`[Flow] Implicit Approval: "${item.original}" -> "${item.aiTranslated}"`);
                try {
                    chrome.runtime.sendMessage({
                        action: 'sendFeedback',
                        payload: {
                            original_text: item.original,
                            corrected_translation: item.aiTranslated,
                            session_id: sessionId
                        }
                    });
                } catch (err) {
                    console.warn("Implicit approval failed", err);
                }
            }
        } else {
            // Still too fresh, keep it in the queue for the next box
            stillPending.push(item);
        }
    }
    pendingApprovals = stillPending;
}

function onMouseMove(e) {
    if (!isSelecting) return;
    const width = Math.abs(e.clientX - startX);
    const height = Math.abs(e.clientY - startY);
    selectionDiv.style.width = width + 'px';
    selectionDiv.style.height = height + 'px';
    selectionDiv.style.left = Math.min(e.clientX, startX) + 'px';
    selectionDiv.style.top = Math.min(e.clientY, startY) + 'px';
}

async function onMouseUp(e) {
    if (!isSelecting) return;
    isSelecting = false;
    overlayDiv.removeEventListener('mousemove', onMouseMove);
    overlayDiv.removeEventListener('mouseup', onMouseUp);

    const rect = selectionDiv.getBoundingClientRect();

    // In continuous mode, keep overlay active
    if (!continuousMode) {
        overlayDiv.style.display = 'none';
        document.body.style.cursor = 'default';
    }

    if (selectionDiv) {
        selectionDiv.remove();
        selectionDiv = null;
    }

    if (rect.width > 5 && rect.height > 5) {
        processSelection(rect);
    }

    // In continuous mode, immediately prepare for next selection
    if (continuousMode) {
        overlayDiv.addEventListener('mousedown', onMouseDown);
    }
}

function cancelSelection() {
    isSelecting = false;
    if (overlayDiv) overlayDiv.style.display = 'none';
    document.body.style.cursor = 'default';
    if (selectionDiv) selectionDiv.remove();
}

async function processSelection(rect) {
    console.log(`%c[Flow] 1. New Request: ${Math.round(rect.width)}x${Math.round(rect.height)}`, 'color: #3498db; font-weight: bold');

    // 1. CAPTURE FIRST (To avoid UI watermarks)
    let captureResponse;
    try {
        const startTime = Date.now();
        captureResponse = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'captureTab' }, (res) => {
                if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                else resolve(res);
            });
        });
        console.log(`[Flow] 2. Screen captured in ${Date.now() - startTime}ms`);
    } catch (err) {
        console.error("[Flow] Capture failed:", err);
        return;
    }

    if (!captureResponse || !captureResponse.dataUrl) {
        console.error("[Flow] Empty capture response");
        return;
    }

    const dataUrl = captureResponse.dataUrl;

    // 2. NOW show the Loading Bubble
    const resultDiv = document.createElement('div');
    resultDiv.className = 'manga-translator-result';
    resultDiv.style.position = 'absolute';

    // Calculate top-left corner position directly (no transform needed)
    const bubbleWidth = Math.max(rect.width, 50);
    const bubbleHeight = Math.max(rect.height, 20);
    resultDiv.style.left = (window.scrollX + rect.left + (rect.width - bubbleWidth) / 2) + 'px';
    resultDiv.style.top = (window.scrollY + rect.top + (rect.height - bubbleHeight) / 2) + 'px';
    resultDiv.style.width = bubbleWidth + 'px';
    resultDiv.style.height = bubbleHeight + 'px';
    resultDiv.style.display = 'flex';
    resultDiv.style.alignItems = 'center';
    resultDiv.style.justifyContent = 'center';
    resultDiv.style.fontSize = '24px';
    resultDiv.style.color = '#555';
    resultDiv.style.fontWeight = 'bold';
    resultDiv.style.background = 'rgba(255, 255, 255, 0.9)';

    // Auto-Vertical Hint (UI only)
    if (!isVerticalMode && (currentSourceLang === 'kor' || currentSourceLang === 'jpn')) {
        // Just a visual hint, actual processing logic is handled by server params
    }
    resultDiv.innerHTML = `OCR..`;
    document.body.appendChild(resultDiv);

    try {
        const isDebug = debugModeActive;
        debugModeActive = false;

        // 3. CROP RAW IMAGE (Best for PaddleOCR)
        const blob = await cropImage(captureResponse.dataUrl, rect, window.devicePixelRatio);

        if (isDebug) {
            const debugUrl = URL.createObjectURL(blob);
            resultDiv.innerHTML = `<img src="${debugUrl}" style="max-width:100%; max-height:100%; object-fit:contain; background:#fff" />`;
            resultDiv.title = "DEBUG: RAW Image Sent to AI";
            setTimeout(() => resultDiv.remove(), 10000);
            return;
        }

        // 4. PERFORM OCR (Local priority)
        const ocrStart = Date.now();
        const ocrData = await performOCR(blob, currentSourceLang);
        console.log(`[Flow] 4. OCR Finished in ${Date.now() - ocrStart}ms. Confidence: ${ocrData.confidence || 'N/A'}`);
        console.log(`[Flow] 4. Identified Text: "${ocrData.text}"`);
        let text = ocrData.text || '';

        if (!text.trim()) {
            resultDiv.innerText = '?';
            setTimeout(() => resultDiv.remove(), 2000);
            return;
        }

        // 5. TRANSLATE
        let translated = '';
        let isLearned = false;

        // Clean up common OCR noise & Apply Typos Fixes
        let cleanText = text.trim().replace(/^['"%.;,]+|['"%.;,]+$/g, '');

        // Apply dictionary fixes
        KOREAN_FIXES.forEach(fix => {
            cleanText = cleanText.replace(fix.from, fix.to);
        });

        const spacelessText = cleanText.replace(/\s+/g, '');

        // Priority 1: SFX (Sound Effects)
        if (SFX_MAP[spacelessText]) {
            translated = SFX_MAP[spacelessText];
            console.log(`[Flow] 5. SFX Match: ${translated}`);
        }
        // Priority 2: Genre/Spicy Glossary
        else if (GENRE_GLOSSARY[spacelessText]) {
            translated = GENRE_GLOSSARY[spacelessText];
            console.log(`[Flow] 5. Glossary Match: ${translated}`);
        }
        // Priority 3: Translation API
        // Priority 3: Translation API
        else {
            console.log(`[Flow] 5. Sending to Translation API: "${cleanText}"`);
            const translationResult = await translateText(cleanText, currentTargetLang);
            translated = translationResult.text;
            isLearned = translationResult.isLearned;
            console.log(`[Flow] 5. Translated Text: "${translated}" (Learned: ${isLearned})`);
        }

        // 6. RENDER
        let fontSize = Math.max(16, rect.height / 8);
        if (ocrData.lines && ocrData.lines.length > 0) {
            fontSize = Math.max(14, (rect.height / ocrData.lines.length) * 0.7);
        }
        fontSize = Math.min(fontSize, 60);

        resultDiv.style.visibility = 'hidden';
        resultDiv.classList.remove('manga-translator-result');
        resultDiv.classList.add('manga-translator-bubble');
        resultDiv.style.background = '#fff';
        resultDiv.style.display = 'block';
        resultDiv.style.padding = '15px'; // Add padding as a drag handle area
        resultDiv.style.cursor = 'move'; // Bubble itself is for moving

        resultDiv.style.wordWrap = 'break-word';
        resultDiv.style.overflowWrap = 'break-word';
        resultDiv.style.whiteSpace = 'pre-wrap';

        // Sanitize: Remove ANY sparkles from the text (start or middle) to be absolutely sure
        translated = translated.replace(/✨/g, '').trim();

        // Use a separate span for the sparkle indicator (Inline style)
        const sparkle = isLearned ? '<span style="color:#f1c40f;margin-right:5px;cursor:default" title="Learned from history">✨</span>' : '';

        resultDiv.style.position = 'absolute';

        // Flexbox centering for the whole block
        resultDiv.style.display = 'flex';
        resultDiv.style.alignItems = 'center';
        resultDiv.style.justifyContent = 'center';

        resultDiv.innerHTML = `
            <span class="manga-translator-text" contenteditable="false" spellcheck="false" style="cursor:inherit; text-align:center;">${sparkle}${translated}</span>
        `;

        const textSpan = resultDiv.querySelector('.manga-translator-text');
        resultDiv.style.fontSize = fontSize + 'px';
        if (isVerticalMode) {
            resultDiv.style.writingMode = 'vertical-rl';
        }
        resultDiv.style.visibility = 'visible';

        const closeBtn = document.createElement('div');
        closeBtn.className = 'manga-translator-close';
        closeBtn.innerText = '×';
        closeBtn.onclick = () => {
            // Remove from pending queue if closed
            pendingApprovals = pendingApprovals.filter(p => p.element !== textSpan);
            resultDiv.remove();
        };
        resultDiv.appendChild(closeBtn);

        // Initialize View States
        const aiTranslated = translated; // Initial AI output (Reference)
        let userTranslated = translated; // User's working copy
        let viewState = 0; // 0: User(Edit), 1: Original, 2: AI(Reference)

        // Sync user edits

        // Add to implicit approval queue
        pendingApprovals.push({
            original: text,
            aiTranslated: aiTranslated,
            timestamp: Date.now(),
            element: textSpan
        });

        textSpan.addEventListener('input', () => {
            userTranslated = textSpan.innerText;
        });

        // Double-Click to Edit
        resultDiv.addEventListener('dblclick', (e) => {
            e.stopPropagation(); // Prevent drag/toggle

            // Force to User View (State 0) if not already
            if (viewState !== 0) {
                viewState = 0;
                textSpan.innerText = userTranslated;
                textSpan.style.color = '#000';
                textSpan.style.fontFamily = 'inherit';
            }

            textSpan.contentEditable = "true";
            textSpan.focus();
            textSpan.style.cursor = 'text'; // Only text span gets text cursor
            resultDiv.style.cursor = 'move'; // Keep bubble as move cursor
            // Move cursor to end
            const range = document.createRange();
            const sel = window.getSelection();
            range.selectNodeContents(textSpan);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        });

        // Add Enter key listener for user feedback
        // const textSpan = resultDiv.querySelector('.manga-translator-text'); // Already defined above
        // let userHasEdited = false; // No longer blocking toggle based on this

        textSpan.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                // Get text but strictly remove the sparkle character if present
                let rawText = textSpan.innerText;
                // Remove ✨ and leading whitespace
                const correctedText = rawText.replace(/✨/g, '').trim();

                // Save and Lock
                userTranslated = correctedText;
                // Update UI to show only clean text (removes sparkle visually too after edit)
                textSpan.innerText = userTranslated;
                textSpan.contentEditable = "false";
                resultDiv.style.cursor = 'default';

                // Send feedback to backend
                try {
                    // Remove from pending queue (explicit feedback takes priority)
                    pendingApprovals = pendingApprovals.filter(p => p.element !== textSpan);

                    chrome.runtime.sendMessage({
                        action: 'sendFeedback',
                        payload: {
                            original_text: text,
                            corrected_translation: correctedText,
                            session_id: sessionId
                        }
                    });
                    console.log(`✅ Feedback sent: "${text}" -> "${correctedText}"`);

                    // Visual feedback
                    textSpan.style.outline = '2px solid #4CAF50';
                    setTimeout(() => textSpan.style.outline = 'none', 1000);
                    textSpan.blur(); // Remove focus after submit
                } catch (err) {
                    console.error('❌ Feedback failed:', err);
                }
            }
        });

        // Move cursor to end when user focuses on text
        textSpan.addEventListener('focus', () => {
            const range = document.createRange();
            const sel = window.getSelection();
            range.selectNodeContents(textSpan);
            range.collapse(false); // Collapse to end
            sel.removeAllRanges();
            sel.addRange(range);
        });

        makeDraggable(resultDiv, () => {
            // Cycle State: 0 -> 1 -> (2 if modified) -> 0
            viewState++;

            // Skip State 2 (AI Reference) if user hasn't edited anything
            // (i.e., if User Copy is same as AI Original Copy)
            if (viewState === 2 && userTranslated.trim() === aiTranslated.trim()) {
                viewState++;
            }

            // Wrap around
            if (viewState > 2) viewState = 0;

            if (viewState === 0) {
                // View: User Translation (Read-only, dblclick to edit)
                textSpan.innerText = userTranslated;
                textSpan.style.color = '#000';
                textSpan.style.fontFamily = 'inherit';
                textSpan.contentEditable = "false";
            } else if (viewState === 1) {
                // View: Original Text (Read-only)
                textSpan.innerText = text;
                textSpan.style.color = '#777';
                textSpan.style.fontFamily = 'monospace';
                textSpan.style.cursor = 'text'; // Show text cursor to indicate copyable
                textSpan.contentEditable = "false";
            } else if (viewState === 2) {
                // View: AI Reference (Read-only)
                textSpan.innerText = aiTranslated;
                textSpan.style.color = '#555'; // Dark grey, distinct but subtle
                textSpan.style.fontFamily = 'inherit';
                textSpan.contentEditable = "false";
            }
        });

    } catch (err) {
        resultDiv.innerText = "Error";
        console.error(err);
    }
}

async function cropImage(dataUrl, rect, dpr) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const s = dpr || 1;
            canvas.width = rect.width * s;
            canvas.height = rect.height * s;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, rect.left * s, rect.top * s, rect.width * s, rect.height * s, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(resolve, 'image/png');
        };
        img.src = dataUrl;
    });
}

function makeDraggable(el, onClick) {
    let isDragging = false;
    let possibleClickOnText = false;
    let hasMoved = false;
    let startX, startY, initialLeft, initialTop;
    let clickTimeout = null;

    el.addEventListener('mousedown', (e) => {
        if (e.target.className === 'manga-translator-close') return;
        if (e.target.isContentEditable) return;

        // Check if clicking on text (Read-Only mode)
        // Allow Selection (Browser Default), so DONT start dragging bubble.
        // But track for potential Click (Toggle)
        if (e.target.classList.contains('manga-translator-text') || e.target.closest('.manga-translator-text')) {
            possibleClickOnText = true;
            startX = e.clientX; startY = e.clientY;
            return;
        }

        isDragging = true;
        hasMoved = false;
        startX = e.clientX; startY = e.clientY;
        initialLeft = parseFloat(el.style.left); initialTop = parseFloat(el.style.top);
        el.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (possibleClickOnText) {
            // If moved significantly, it's a Text Selection, not a Click.
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                possibleClickOnText = false;
            }
            return;
        }

        if (!isDragging) return;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;

        el.style.left = (initialLeft + dx) + 'px';
        el.style.top = (initialTop + dy) + 'px';
    });

    window.addEventListener('mouseup', (e) => {
        // Handle Text Click (Toggle view)
        if (possibleClickOnText) {
            if (onClick) {
                if (clickTimeout) clearTimeout(clickTimeout);
                clickTimeout = setTimeout(() => {
                    onClick();
                }, 250);
            }
            possibleClickOnText = false;
            return;
        }

        // Handle Bubble Drag End
        if (isDragging) {
            isDragging = false;
            el.style.cursor = 'move';
            // Only trigger toggle if not moved AND not clicking editable text
            if (!hasMoved && onClick && !e.target.isContentEditable) {
                if (clickTimeout) clearTimeout(clickTimeout);
                clickTimeout = setTimeout(() => {
                    onClick();
                }, 250);
            }
        }
    });

    // Double click handler separate (in main code), but ensure timeout is cleared if dblclick occurs
    el.addEventListener('dblclick', () => {
        if (clickTimeout) {
            clearTimeout(clickTimeout);
            clickTimeout = null;
        }
    });
}

async function performOCR(blob, lang) {
    try {
        const base64 = await new Promise(r => {
            const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob);
        });

        let srvLang = 'en';
        if (lang.includes('kor')) srvLang = 'korean';
        if (lang.includes('jpn')) srvLang = 'japan';
        if (lang.includes('chi')) srvLang = 'chinese';

        const res = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'performLocalOCR', payload: { image_base64: base64, lang: srvLang } },
                r => r && r.success ? resolve(r.data) : reject(r ? r.error : 'offline'));
        });
        return { text: res.text, confidence: res.confidence };
    } catch (e) {
        // Fallback to minimal Tesseract (placeholder logic - you may want to re-add full Tesseract here if needed)
        console.warn("Local OCR failed", e);
        return { text: "" };
    }
}

// Session Management - Use fixed ID for persistent learning
const sessionId = 'global';

async function translateText(text, target) {
    if (!text || !text.trim()) return { text: "", isLearned: false };

    try {
        console.log(`[Flow] Asking DeepSeek API (via Local): ${text.substring(0, 20)}...`);
        const data = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                action: 'performLocalTranslate',
                payload: {
                    text: text,
                    session_id: sessionId,
                    target_lang: target
                }
            }, r => r && r.success ? resolve(r.data) : reject(r ? r.error : 'offline'));
        });

        return {
            text: data.translatedText || text,
            isLearned: !!data.is_learned
        };

    } catch (e) {
        console.error("❌ CRITICAL: Translation Request Failed!", e);
        return {
            text: text + " [LLM: " + (typeof e === 'string' ? e : "Failed to fetch") + "]",
            isLearned: false
        };
    }
}


// --- Floating Settings Panel ---

// Settings Panel removed as per user request
