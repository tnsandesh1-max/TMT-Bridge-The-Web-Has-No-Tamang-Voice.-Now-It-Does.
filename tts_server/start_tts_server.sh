#!/bin/bash
echo "TMT Bridge TTS Server"
echo "====================="
cd "$(dirname "$0")"
pip install -r requirements.txt --break-system-packages 2>/dev/null || pip install -r requirements.txt
python3 tts_server.py
