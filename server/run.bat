@echo off
echo Starting Local OCR Server...
set OLLAMA_FLASH_ATTENTION=1
set OLLAMA_KV_CACHE_TYPE=q8_0
python main.py
pause
