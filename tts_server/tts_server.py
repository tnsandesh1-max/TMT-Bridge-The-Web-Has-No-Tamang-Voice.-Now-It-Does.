"""
TMT Bridge — Local TTS Server
==============================
Extracted from HealthVoice Nepal (app.py) TTS stack.
Runs locally on port 7799 so the browser extension can
get real Nepali/Tamang audio without relying on
speechSynthesis (which has no ne-NP/tmg voice on most systems).

TTS Priority (same as app.py):
  1. Google Cloud TTS  — ne-NP-Standard-A (best Nepali quality)
  2. ElevenLabs        — eleven_multilingual_v2 (multilingual fallback)
  3. gTTS              — Google Translate TTS (free, always works)

Run: python tts_server.py
"""

import base64, io, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse
import json
from dotenv import load_dotenv
load_dotenv()
# ── Config — paste your keys here or set as env vars ─────────────────────────
GOOGLE_TTS_API_KEY  = os.environ.get("GOOGLE_TTS_API_KEY",  "")   # Optional but best quality
ELEVENLABS_API_KEY  = os.environ.get("ELEVENLABS_API_KEY",  "")
ELEVENLABS_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "XB0fDUnXU5powFXDhCwa")  # Charlotte — gentle
ELEVENLABS_MODEL    = "eleven_multilingual_v2"

PORT = 7799


# ── Language detection ────────────────────────────────────────────────────────
def detect_language(text: str) -> str:
    """Returns 'ne' if Devanagari script dominates, else 'en'."""
    if not text:
        return "ne"
    dev = sum(1 for c in text if '\u0900' <= c <= '\u097F')
    total = len([c for c in text if c.strip()])
    return "ne" if (total == 0 or dev / total > 0.25) else "en"


# ── TTS backends (copied from app.py) ────────────────────────────────────────

def google_tts_nepali(text: str) -> bytes | None:
    """Google Cloud TTS — native ne-NP-Standard-A voice."""
    if not GOOGLE_TTS_API_KEY:
        return None
    try:
        import urllib.request
        payload = json.dumps({
            "input": {"text": text},
            "voice": {
                "languageCode": "ne-NP",
                "name": "ne-NP-Standard-A",
                "ssmlGender": "FEMALE",
            },
            "audioConfig": {
                "audioEncoding": "MP3",
                "speakingRate": 0.87,
                "pitch": -3.0,
                "volumeGainDb": 1.0,
            },
        }).encode()
        url = f"https://texttospeech.googleapis.com/v1/text:synthesize?key={GOOGLE_TTS_API_KEY}"
        req = urllib.request.Request(url, data=payload,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=12) as r:
            data = json.loads(r.read())
            audio_b64 = data.get("audioContent", "")
            if audio_b64:
                return base64.b64decode(audio_b64)
    except Exception as e:
        print(f"⚠️  Google TTS: {e}")
    return None


def elevenlabs_tts(text: str) -> bytes | None:
    """ElevenLabs multilingual — works for Nepali and English."""
    if not ELEVENLABS_API_KEY or ELEVENLABS_API_KEY.startswith("YOUR_"):
        return None
    try:
        import urllib.request
        payload = json.dumps({
            "text": text,
            "model_id": ELEVENLABS_MODEL,
            "voice_settings": {
                "stability": 0.75,
                "similarity_boost": 0.65,
                "style": 0.45,
                "use_speaker_boost": False,
            },
        }).encode()
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}"
        req = urllib.request.Request(url, data=payload, headers={
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        })
        with urllib.request.urlopen(req, timeout=15) as r:
            if r.status == 200:
                return r.read()
    except Exception as e:
        print(f"⚠️  ElevenLabs: {e}")
    return None


def gtts_tts(text: str, lang: str = "ne") -> bytes | None:
    """gTTS — Google Translate TTS, free, always available online."""
    try:
        from gtts import gTTS
        buf = io.BytesIO()
        # Tamang has no separate gTTS code — use Nepali (closest)
        gtts_lang = "ne" if lang in ("ne", "tmg", "nep", "nepali", "tamang") else "en"
        gTTS(text=text, lang=gtts_lang, slow=False).write_to_fp(buf)
        buf.seek(0)
        return buf.read()
    except Exception as e:
        print(f"⚠️  gTTS: {e}")
    return None


def text_to_speech(text: str, lang: str | None = None) -> tuple[bytes | None, str]:
    """
    Same priority chain as app.py:
      Nepali/Tamang: Google ne-NP → ElevenLabs → gTTS(ne)
      English:       ElevenLabs  → gTTS(en)
    """
    if lang is None:
        lang = detect_language(text)

    print(f"  TTS lang={lang!r} text={text[:40]!r}…")

    if lang in ("ne", "nep", "nepali", "tmg", "tamang"):
        # 1. Google Cloud ne-NP
        audio = google_tts_nepali(text)
        if audio:
            print("  ✅ Google ne-NP")
            return audio, "google_ne_NP"
        # 2. ElevenLabs
        audio = elevenlabs_tts(text)
        if audio:
            print("  ✅ ElevenLabs")
            return audio, "elevenlabs"
        # 3. gTTS
        audio = gtts_tts(text, "ne")
        if audio:
            print("  ✅ gTTS ne")
            return audio, "gtts_ne"
    else:
        # English
        audio = elevenlabs_tts(text)
        if audio:
            print("  ✅ ElevenLabs en")
            return audio, "elevenlabs_en"
        audio = gtts_tts(text, "en")
        if audio:
            print("  ✅ gTTS en")
            return audio, "gtts_en"

    return None, "none"


# ── HTTP Server ───────────────────────────────────────────────────────────────

class TTSHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[TMT-TTS] {fmt % args}")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "ok",
                "google_tts": bool(GOOGLE_TTS_API_KEY),
                "elevenlabs": bool(ELEVENLABS_API_KEY),
                "gtts": True,
            }).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/tts":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            data = json.loads(body)
        except Exception:
            self.send_response(400)
            self.end_headers()
            return

        text = (data.get("text") or "").strip()
        lang = (data.get("lang") or data.get("language") or "").lower()

        if not text:
            self.send_response(400)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "No text"}).encode())
            return

        audio, provider = text_to_speech(text, lang or None)

        if audio:
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("X-TTS-Provider", provider)
            self.end_headers()
            self.wfile.write(audio)
        else:
            self.send_response(503)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "All TTS providers failed"}).encode())


if __name__ == "__main__":
    print(f"🎙️  TMT Bridge TTS Server starting on http://localhost:{PORT}")
    print(f"   Google Cloud TTS : {'✅ configured' if GOOGLE_TTS_API_KEY else '❌ no key (set GOOGLE_TTS_API_KEY)'}")
    print(f"   ElevenLabs       : {'✅ configured' if ELEVENLABS_API_KEY else '❌ no key'}")
    print(f"   gTTS fallback    : ✅ always available")
    print(f"\n   POST http://localhost:{PORT}/tts")
    print(f"   Body: {{\"text\": \"नमस्ते\", \"lang\": \"ne\"}}")
    print(f"\n   Keep this running while using the browser extension.")
    server = HTTPServer(("localhost", PORT), TTSHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 TTS Server stopped.")
