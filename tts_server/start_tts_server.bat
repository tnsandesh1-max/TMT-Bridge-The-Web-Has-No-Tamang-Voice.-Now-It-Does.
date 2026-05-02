@echo off
echo TMT Bridge TTS Server
echo =====================
cd /d "%~dp0"
pip install -r requirements.txt
python tts_server.py
pause
