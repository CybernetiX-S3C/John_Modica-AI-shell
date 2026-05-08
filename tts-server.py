#!/usr/bin/env python3
# ─── tts-server.py ─────────────────────────────────────────────────────────────
# John Modica AI Shell — Local Voice Clone TTS Server
#
# Engine : Coqui XTTS-v2  (free, open-source, offline after first download)
# Model  : tts_models/multilingual/multi-dataset/xtts_v2
#          ~1.8 GB — downloads ONCE to ~/.local/share/tts/   (NOT in repo)
# Runs at: http://localhost:5002
#
# ENDPOINTS:
#   GET  /health          → {"status":"ok","model":"xtts_v2","voice_sample":"..."}
#   POST /speak           → WAV audio bytes (Content-Type: audio/wav)
#   POST /embed           → JSON speaker embedding (pre-compute cache)
#   GET  /voice-sample    → confirms which WAV is loaded
#   POST /set-voice       → hot-swap the voice sample without restart
#
# VOICE SAMPLE:
#   Place a 10–30 second clean WAV of your voice at:
#     assets/voices/john-voice.wav
#   Speaks like you every time. No training. No fine-tuning.
#   Speaker embedding is cached to:
#     assets/voices/john-voice-embed.json
#   Delete the JSON to force re-compute.
#
# STARTUP (auto-launched by main.js on Electron boot):
#   python3 tts-server.py
#   python3 tts-server.py --port 5002 --voice assets/voices/john-voice.wav
#
# FIRST RUN:
#   Model downloads automatically (~1.8 GB, one time only).
#   Subsequent starts: model loads from cache in ~3–8 seconds.
#
# REQUIREMENTS:
#   pip install -r requirements-tts.txt
#   (see also: setup.sh which handles this automatically)
# ───────────────────────────────────────────────────────────────────────────────

import os
import sys
import json
import time
import wave
import struct
import argparse
import logging
import threading
import tempfile
from pathlib  import Path
from io       import BytesIO
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level   = logging.INFO,
    format  = '[tts-server] %(asctime)s  %(levelname)s  %(message)s',
    datefmt = '%H:%M:%S',
)
log = logging.getLogger('tts-server')

# ── Args ──────────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description='John Modica AI — Local TTS Server (XTTS-v2)')
parser.add_argument('--port',  type=int,  default=5002,                               help='Port to listen on (default: 5002)')
parser.add_argument('--host',  type=str,  default='127.0.0.1',                        help='Host to bind to (default: 127.0.0.1 — localhost only)')
parser.add_argument('--voice', type=str,  default='assets/voices/john-voice.wav',     help='Path to voice sample WAV file')
parser.add_argument('--lang',  type=str,  default='en',                               help='Language code (default: en)')
parser.add_argument('--model', type=str,  default='tts_models/multilingual/multi-dataset/xtts_v2', help='Coqui TTS model name')
parser.add_argument('--gpu',   action='store_true',                                    help='Use GPU if available (faster synthesis)')
args = parser.parse_args()

# ── Globals ───────────────────────────────────────────────────────────────────
TTS_ENGINE      = None      # Coqui TTS instance
VOICE_SAMPLE    = args.voice
LANG            = args.lang
MODEL_NAME      = args.model
USE_GPU         = args.gpu
EMBED_CACHE     = None      # pre-computed speaker embedding (dict)
EMBED_CACHE_PATH = Path(args.voice).with_suffix('').with_name(
    Path(args.voice).stem + '-embed.json'
)
_lock = threading.Lock()    # one synthesis at a time

# ══════════════════════════════════════════════════════════════════════════════
#  MODEL LOADER
# ══════════════════════════════════════════════════════════════════════════════
def load_model():
    global TTS_ENGINE, EMBED_CACHE
    log.info(f'Loading Coqui XTTS-v2 model: {MODEL_NAME}')
    log.info('(First run will download ~1.8 GB — subsequent starts use cache)')

    try:
        from TTS.api import TTS as CoquiTTS
        TTS_ENGINE = CoquiTTS(MODEL_NAME, gpu=USE_GPU)
        log.info('✓ XTTS-v2 model loaded successfully')
    except ImportError:
        log.error('Coqui TTS not installed. Run: pip install -r requirements-tts.txt')
        sys.exit(1)
    except Exception as e:
        log.error(f'Model load failed: {e}')
        sys.exit(1)

    # Load or generate speaker embedding
    _load_embed()

def _load_embed():
    global EMBED_CACHE
    # Check voice sample exists
    if not Path(VOICE_SAMPLE).exists():
        log.warning(f'Voice sample not found: {VOICE_SAMPLE}')
        log.warning('Place a WAV file at assets/voices/john-voice.wav')
        log.warning('Will attempt synthesis without speaker embedding cache.')
        return

    # Load cached embedding if fresh
    if EMBED_CACHE_PATH.exists():
        try:
            with open(EMBED_CACHE_PATH) as f:
                data = json.load(f)
            # Check if voice sample changed (compare mtime)
            sample_mtime = Path(VOICE_SAMPLE).stat().st_mtime
            if data.get('sample_mtime') == sample_mtime:
                EMBED_CACHE = data
                log.info(f'✓ Speaker embedding loaded from cache: {EMBED_CACHE_PATH}')
                return
        except Exception as e:
            log.warning(f'Embed cache read failed ({e}), recomputing…')

    # Compute embedding
    log.info(f'Computing speaker embedding from: {VOICE_SAMPLE}')
    try:
        gpt_cond, spk = TTS_ENGINE.synthesizer.tts_model.get_conditioning_latents(
            audio_path      = [VOICE_SAMPLE],
            gpt_cond_len    = 6,
            max_ref_length  = 60,
            sound_norm_refs = False,
        )
        EMBED_CACHE = {
            'sample_mtime': Path(VOICE_SAMPLE).stat().st_mtime,
            'gpt_cond':     gpt_cond.cpu().tolist(),
            'speaker':      spk.cpu().tolist(),
        }
        with open(EMBED_CACHE_PATH, 'w') as f:
            json.dump(EMBED_CACHE, f)
        log.info(f'✓ Speaker embedding cached to: {EMBED_CACHE_PATH}')
    except Exception as e:
        log.warning(f'Could not compute embedding ({e}) — will use voice sample directly on each request')
        EMBED_CACHE = None

# ══════════════════════════════════════════════════════════════════════════════
#  SYNTHESIS
# ══════════════════════════════════════════════════════════════════════════════
def synthesize(text: str, voice_sample: str = None, language: str = None) -> bytes:
    """
    Synthesize text → WAV bytes using XTTS-v2.
    Uses pre-computed speaker embedding if available (faster).
    Falls back to voice_sample path for conditioning on every call.
    """
    global TTS_ENGINE, EMBED_CACHE

    if TTS_ENGINE is None:
        raise RuntimeError('TTS engine not loaded')

    sample  = voice_sample or VOICE_SAMPLE
    lang    = language     or LANG
    text    = text.strip()

    if not text:
        return _silent_wav()

    with _lock:
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
            tmp_path = tmp.name

        try:
            # Use cached embedding (fast path)
            if EMBED_CACHE and 'gpt_cond' in EMBED_CACHE:
                import torch
                gpt_cond = torch.tensor(EMBED_CACHE['gpt_cond'])
                spk      = torch.tensor(EMBED_CACHE['speaker'])
                out      = TTS_ENGINE.synthesizer.tts_model.inference(
                    text        = text,
                    language    = lang,
                    gpt_cond_latent  = gpt_cond,
                    speaker_embedding = spk,
                    temperature = 0.7,
                )
                # out is a dict with 'wav' key (list of floats)
                wav_data = out.get('wav', [])
                _float_to_wav(wav_data, tmp_path, sample_rate=24000)
            else:
                # Direct synthesis with voice sample (slower, no cache)
                TTS_ENGINE.tts_to_file(
                    text            = text,
                    speaker_wav     = sample if Path(sample).exists() else None,
                    language        = lang,
                    file_path       = tmp_path,
                )

            with open(tmp_path, 'rb') as f:
                return f.read()

        finally:
            try: os.unlink(tmp_path)
            except: pass


def _float_to_wav(samples, path, sample_rate=24000):
    """Convert float audio samples to WAV file."""
    import struct
    pcm = [max(-32768, min(32767, int(s * 32767))) for s in samples]
    with wave.open(path, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(struct.pack(f'<{len(pcm)}h', *pcm))


def _silent_wav(duration_ms=100, sample_rate=22050):
    """Return a short silent WAV (used when text is empty)."""
    n_samples = int(sample_rate * duration_ms / 1000)
    buf = BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b'\x00\x00' * n_samples)
    return buf.getvalue()

# ══════════════════════════════════════════════════════════════════════════════
#  HTTP HANDLER
# ══════════════════════════════════════════════════════════════════════════════
class TTSHandler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *a):
        # Suppress default HTTP logs (noisy) — we use our own
        if '200' not in str(a):
            log.debug(fmt % a)

    def _cors(self):
        # Allow Electron renderer (localhost) to call us
        self.send_header('Access-Control-Allow-Origin',  'http://localhost')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        # ── /health ──────────────────────────────────────────────────────────
        if path == '/health':
            data = json.dumps({
                'status':       'ok',
                'model':        MODEL_NAME,
                'voice_sample': VOICE_SAMPLE,
                'embed_cached': EMBED_CACHE is not None,
                'gpu':          USE_GPU,
                'lang':         LANG,
            }).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self._cors()
            self.end_headers()
            self.wfile.write(data)

        # ── /voice-sample ────────────────────────────────────────────────────
        elif path == '/voice-sample':
            exists = Path(VOICE_SAMPLE).exists()
            data   = json.dumps({
                'path':    VOICE_SAMPLE,
                'exists':  exists,
                'size_kb': round(Path(VOICE_SAMPLE).stat().st_size / 1024, 1) if exists else 0,
            }).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self._cors()
            self.end_headers()
            self.wfile.write(data)

        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        global VOICE_SAMPLE, EMBED_CACHE

        path = urlparse(self.path).path
        length = int(self.headers.get('Content-Length', 0))
        body   = self.rfile.read(length) if length > 0 else b'{}'

        try:
            payload = json.loads(body) if body else {}
        except json.JSONDecodeError:
            payload = {}

        # ── /speak ───────────────────────────────────────────────────────────
        if path == '/speak':
            text         = payload.get('text', '').strip()
            voice_sample = payload.get('voice_sample', VOICE_SAMPLE)
            language     = payload.get('language', LANG)

            if not text:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error":"text is required"}')
                return

            t0 = time.time()
            log.info(f'Synthesizing {len(text)} chars…')

            try:
                wav_bytes = synthesize(text, voice_sample, language)
                elapsed   = round(time.time() - t0, 2)
                log.info(f'✓ Synthesized {len(wav_bytes):,} bytes in {elapsed}s')

                self.send_response(200)
                self.send_header('Content-Type',   'audio/wav')
                self.send_header('Content-Length', str(len(wav_bytes)))
                self.send_header('X-Elapsed-Sec',  str(elapsed))
                self._cors()
                self.end_headers()
                self.wfile.write(wav_bytes)

            except Exception as e:
                log.error(f'Synthesis error: {e}')
                err = json.dumps({'error': str(e)}).encode()
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self._cors()
                self.end_headers()
                self.wfile.write(err)

        # ── /set-voice ───────────────────────────────────────────────────────
        elif path == '/set-voice':
            new_path = payload.get('voice_sample', '').strip()
            if not new_path or not Path(new_path).exists():
                self.send_response(400)
                self.end_headers()
                self.wfile.write(json.dumps({'error': f'File not found: {new_path}'}).encode())
                return
            VOICE_SAMPLE      = new_path
            EMBED_CACHE       = None
            EMBED_CACHE_PATH  = Path(new_path).with_suffix('').with_name(
                Path(new_path).stem + '-embed.json'
            )
            _load_embed()
            data = json.dumps({'status': 'ok', 'voice_sample': VOICE_SAMPLE}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self._cors()
            self.end_headers()
            self.wfile.write(data)

        # ── /embed ───────────────────────────────────────────────────────────
        elif path == '/embed':
            _load_embed()
            data = json.dumps({
                'status':  'ok',
                'cached':  EMBED_CACHE is not None,
                'path':    str(EMBED_CACHE_PATH),
            }).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self._cors()
            self.end_headers()
            self.wfile.write(data)

        else:
            self.send_response(404)
            self.end_headers()

# ══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════════════
if __name__ == '__main__':
    log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    log.info('  John Modica AI — Local TTS Server')
    log.info('  Engine : Coqui XTTS-v2 (free, offline)')
    log.info(f'  Voice  : {VOICE_SAMPLE}')
    log.info(f'  Listen : http://{args.host}:{args.port}')
    log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    # Load model in a thread so we can confirm port open immediately
    t = threading.Thread(target=load_model, daemon=True)
    t.start()

    server = HTTPServer((args.host, args.port), TTSHandler)
    log.info(f'HTTP server started — waiting for model to load…')

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info('Shutting down TTS server.')
        server.shutdown()
