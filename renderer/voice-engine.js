// ─── voice-engine.js ──────────────────────────────────────────────────────────
// John Modica AI Shell — Free Forever Voice Engine
//
//  ZERO paid APIs. ZERO internet required for TTS. ZERO API keys.
//
//  3-TIER SYSTEM (auto-failover):
//  ┌─────────────────────────────────────────────────────────────────────┐
//  │  TIER 1 (default, instant, zero install)                            │
//  │    Web Speech API — built into Chromium/Electron                    │
//  │    Uses system voices. Not John's voice but works immediately.       │
//  ├─────────────────────────────────────────────────────────────────────┤
//  │  TIER 2 (voice clone, local, free forever)                          │
//  │    Coqui XTTS-v2 local server at localhost:5002                     │
//  │    Clones from assets/voices/john-voice.wav                         │
//  │    tts-server.py spawned by main.js on boot.                        │
//  │    ~1.8 GB model (downloads once to ~/.local/share/tts/)            │
//  │    After that: fully offline, zero cost, sounds like YOU.           │
//  ├─────────────────────────────────────────────────────────────────────┤
//  │  TIER 3 (silent fallback)                                           │
//  │    If both fail: logs warning, continues silently. App never breaks. │
//  └─────────────────────────────────────────────────────────────────────┘
//
//  VOICE SAMPLE:
//    Drop a 10-30 second WAV recording of your voice into:
//      assets/voices/john-voice.wav
//    The XTTS server reads this on every TTS request as the speaker reference.
//    No re-training. No fine-tuning. Just drop the file in.
//
//  SPEAKER EMBEDDING CACHE:
//    After first use, XTTS caches a speaker embedding to:
//      assets/voices/john-voice.json
//    Subsequent requests are faster. Delete the JSON to force re-compute.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const TTS_SERVER_URL    = 'http://localhost:5002';
const VOICE_SAMPLE_PATH = 'assets/voices/john-voice.wav';
const HEALTH_CHECK_MS   = 5000;   // check XTTS server availability every 5s
const MAX_WEB_SPEECH_LEN = 200;   // characters per Web Speech utterance chunk
const VAD_SILENCE_MS    = 1200;   // ms of silence before auto-stop recording
const VAD_THRESHOLD     = 0.015;  // RMS amplitude threshold for voice detection

class VoiceEngine {
  constructor() {
    // ── State ────────────────────────────────────────────────────────────────
    this.ttsEnabled        = false;   // auto-speak responses
    this.micEnabled        = false;   // mic currently active
    this.mediaStream       = null;    // getUserMedia stream
    this.audioContext      = null;    // Web Audio context
    this.mediaRecorder     = null;    // MediaRecorder for STT
    this.recognizer        = null;    // Web Speech SpeechRecognition
    this.hotwordEnabled    = false;
    this._hotwordActive    = false;
    this._vadActive        = false;
    this._silenceTimer     = null;
    this._analyser         = null;
    this._vadRafId         = null;

    // ── XTTS server ──────────────────────────────────────────────────────────
    this.xttsAvailable     = false;   // true once health check passes
    this._xttsCheckTimer   = null;
    this._currentAudio     = null;    // currently playing HTMLAudioElement
    this._speakQueue       = [];      // queued speak() calls
    this._speaking         = false;

    // ── Web Speech TTS ───────────────────────────────────────────────────────
    this._synth            = window.speechSynthesis || null;
    this._synthVoice       = null;    // chosen system voice

    // ── Callbacks (set by app.js) ────────────────────────────────────────────
    this.onTranscript      = null;    // fn(text, isFinal)
    this.onMicStateChange  = null;    // fn(active)
    this.onSpeakStart      = null;    // fn(text)
    this.onSpeakEnd        = null;    // fn()
    this.onError           = null;    // fn(msg)
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════════════════════════════════════
  async init() {
    // Pick a Web Speech voice (prefer a lower, warmer male voice if available)
    this._pickSynthVoice();
    window.speechSynthesis?.addEventListener?.('voiceschanged', () => this._pickSynthVoice());

    // Start polling for XTTS server (non-blocking)
    this._startXTTSHealthCheck();

    // Restore settings
    const sm = window.settingsManager;
    if (sm) {
      this.ttsEnabled     = sm.getBool('voiceTTSEnabled');
      this.hotwordEnabled = sm.getBool('hotwordEnabled');
      const voiceEnabled  = sm.getBool('voiceEnabled');
      if (voiceEnabled) await this.requestMicAccess().catch(() => {});
    }

    // Start hotword listener if enabled
    if (this.hotwordEnabled) this._startHotwordLoop();

    // Update TTS toggle button state
    this._syncTTSButton();

    console.log('[VoiceEngine] Initialised. XTTS:', this.xttsAvailable ? 'ONLINE' : 'Waiting…');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  XTTS SERVER HEALTH CHECK
  //  Polls localhost:5002/health every 5s until it comes online.
  //  tts-server.py takes ~10-30s to load the model on first boot.
  // ══════════════════════════════════════════════════════════════════════════
  _startXTTSHealthCheck() {
    const check = async () => {
      try {
        const res = await fetch(`${TTS_SERVER_URL}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          if (!this.xttsAvailable) {
            this.xttsAvailable = true;
            console.log('[VoiceEngine] XTTS-v2 server ONLINE — voice cloning active 🎙');
            window.appController?.toast('🎙 Voice clone server ready. Speaking as John.', 'success');
            this._syncTTSButton();
          }
          return;
        }
      } catch (_) { /* server not ready yet */ }
      this.xttsAvailable = false;
    };

    // Immediate check, then repeat
    check();
    this._xttsCheckTimer = setInterval(check, HEALTH_CHECK_MS);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SPEAK  — main entry point
  //  Routes to XTTS (Tier 2) or Web Speech (Tier 1) automatically.
  //  Text is queued — one utterance at a time.
  // ══════════════════════════════════════════════════════════════════════════
  speak(text) {
    if (!this.ttsEnabled) return;
    if (!text || !text.trim()) return;

    // Strip markdown before speaking
    const clean = text
      .replace(/```[\s\S]*?```/g, ' code block ')
      .replace(/`[^`]+`/g, '')
      .replace(/#{1,6}\s/g, '')
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
      .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[>|]/g, '')
      .replace(/\n+/g, ' ')
      .trim();

    if (!clean) return;
    this._speakQueue.push(clean);
    if (!this._speaking) this._processQueue();
  }

  async _processQueue() {
    if (this._speaking || this._speakQueue.length === 0) return;
    this._speaking = true;
    const text = this._speakQueue.shift();

    this.onSpeakStart?.(text);

    // Stop any current mic recording while speaking (avoid feedback)
    const wasMicActive = this.micEnabled;
    if (wasMicActive) this._pauseMic();

    try {
      if (this.xttsAvailable) {
        await this._speakXTTS(text);
      } else {
        await this._speakWebSpeech(text);
      }
    } catch (e) {
      console.warn('[VoiceEngine] Speak error, falling back:', e.message);
      try { await this._speakWebSpeech(text); } catch (_) { /* silent */ }
    }

    this.onSpeakEnd?.();
    this._speaking = false;

    // Resume mic if it was active
    if (wasMicActive) this._resumeMic();

    // Process next in queue
    if (this._speakQueue.length > 0) this._processQueue();
  }

  // ── TIER 2: XTTS-v2 via local tts-server.py ───────────────────────────────
  async _speakXTTS(text) {
    const res = await fetch(`${TTS_SERVER_URL}/speak`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        text,
        voice_sample: VOICE_SAMPLE_PATH,
        language:     'en',
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) throw new Error(`XTTS server error: ${res.status}`);

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    await this._playAudioBlob(url);
    URL.revokeObjectURL(url);
  }

  // ── TIER 1: Web Speech API (built into Chromium) ──────────────────────────
  _speakWebSpeech(text) {
    return new Promise((resolve, reject) => {
      if (!this._synth) { resolve(); return; }
      this._synth.cancel(); // clear any stuck utterance

      // Chunk long text (Web Speech has char limits in some browsers)
      const chunks = this._chunkText(text, MAX_WEB_SPEECH_LEN);
      let idx = 0;

      const speakNext = () => {
        if (idx >= chunks.length) { resolve(); return; }
        const utt    = new SpeechSynthesisUtterance(chunks[idx++]);
        utt.voice    = this._synthVoice;
        utt.rate     = 0.95;
        utt.pitch    = 0.9;
        utt.volume   = 1.0;
        utt.onend    = speakNext;
        utt.onerror  = (e) => { if (e.error !== 'interrupted') reject(e); else resolve(); };
        this._synth.speak(utt);
      };
      speakNext();
    });
  }

  // ── Audio blob player ─────────────────────────────────────────────────────
  _playAudioBlob(url) {
    return new Promise((resolve, reject) => {
      const audio        = new Audio(url);
      audio.volume       = 1.0;
      this._currentAudio = audio;
      audio.onended      = () => { this._currentAudio = null; resolve(); };
      audio.onerror      = (e) => { this._currentAudio = null; reject(e); };
      audio.play().catch(reject);
    });
  }

  // ── Text chunker ──────────────────────────────────────────────────────────
  _chunkText(text, maxLen) {
    const chunks = [];
    // Split on sentence boundaries
    const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > maxLen && buf) {
        chunks.push(buf.trim());
        buf = s;
      } else {
        buf += s;
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
    return chunks.length ? chunks : [text];
  }

  // ── Stop speaking ─────────────────────────────────────────────────────────
  stopSpeaking() {
    this._speakQueue = [];
    this._speaking   = false;
    this._synth?.cancel();
    if (this._currentAudio) {
      this._currentAudio.pause();
      this._currentAudio.src = '';
      this._currentAudio     = null;
    }
    this.onSpeakEnd?.();
  }

  // ── Pick Web Speech voice ─────────────────────────────────────────────────
  _pickSynthVoice() {
    if (!this._synth) return;
    const voices = this._synth.getVoices();
    if (!voices.length) return;

    // Prefer deep/male English voices
    const preferred = [
      'Google US English Male', 'Microsoft David', 'Microsoft Guy',
      'en-US-GuyNeural', 'Alex', 'Daniel',
    ];
    for (const name of preferred) {
      const v = voices.find(v => v.name === name);
      if (v) { this._synthVoice = v; return; }
    }
    // Fallback: first English voice
    this._synthVoice = voices.find(v => v.lang.startsWith('en')) || voices[0];
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MICROPHONE / STT
  // ══════════════════════════════════════════════════════════════════════════

  // Request mic access — called once, permission granted permanently
  async requestMicAccess() {
    if (this.mediaStream) return true;
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount:       1,
          sampleRate:         16000,
          echoCancellation:   true,
          noiseSuppression:   true,
          autoGainControl:    true,
        }
      });
      this.audioContext = new AudioContext({ sampleRate: 16000 });
      console.log('[VoiceEngine] Mic access granted.');

      // Update mic button
      const btn = document.getElementById('voice-btn');
      if (btn) {
        btn.classList.add('has-mic');
        btn.title = 'Click to start/stop listening (Ctrl+Space)';
      }

      // Show TTS button now that we have a working audio context
      const ttsBtn = document.getElementById('tts-toggle-btn');
      if (ttsBtn) ttsBtn.style.display = '';

      return true;
    } catch (e) {
      console.warn('[VoiceEngine] Mic denied:', e.message);
      this._emitError('Microphone access denied. Check browser/OS permissions.');
      return false;
    }
  }

  // Toggle mic on/off
  toggleMic() {
    if (!this.mediaStream) {
      this.requestMicAccess().then(ok => { if (ok) this._startListening(); });
      return;
    }
    if (this.micEnabled) {
      this._stopListening();
    } else {
      this._startListening();
    }
  }

  _pauseMic() {
    if (!this.micEnabled) return;
    this._stopListening(true);
  }

  _resumeMic() {
    if (!this.mediaStream || this.micEnabled) return;
    this._startListening();
  }

  // ── Start listening (Web Speech Recognition) ───────────────────────────────
  _startListening() {
    if (this.micEnabled) return;
    this.micEnabled = true;
    this.onMicStateChange?.(true);
    this._updateMicButton(true);

    // Prefer Web Speech API (works in Chromium/Electron with mic permission)
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      this._startWebSpeechSTT(SR);
      this._startVAD(); // VAD for auto-stop on silence
    } else {
      // Fallback: MediaRecorder → could pipe to local whisper.cpp in future
      this._emitError('Speech recognition not available. Use Ctrl+Space push-to-talk.');
      this.micEnabled = false;
    }
  }

  _stopListening(silent = false) {
    if (!this.micEnabled && !silent) return;
    this.micEnabled = false;
    this.onMicStateChange?.(false);
    this._updateMicButton(false);
    this._stopVAD();

    if (this.recognizer) {
      try { this.recognizer.stop(); } catch (_) {}
      this.recognizer = null;
    }
  }

  // ── Web Speech STT ─────────────────────────────────────────────────────────
  _startWebSpeechSTT(SR) {
    const r = new SR();
    r.continuous      = true;
    r.interimResults  = true;
    r.lang            = window.settingsManager?.get('voiceLang') || 'en-US';
    r.maxAlternatives = 1;

    r.onresult = (e) => {
      let interim = '', final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t;
        else interim += t;
      }
      if (interim && this.onTranscript) this.onTranscript(interim, false);
      if (final)   { this.onTranscript?.(final, true); this._resetVADTimer(); }
    };

    r.onerror = (e) => {
      if (e.error === 'no-speech') return;
      if (e.error === 'aborted')   return;
      console.warn('[VoiceEngine] STT error:', e.error);
    };

    r.onend = () => {
      // Auto-restart if mic still enabled (continuous mode)
      if (this.micEnabled) {
        try { r.start(); } catch (_) { /* might be already starting */ }
      }
    };

    try { r.start(); } catch (_) {}
    this.recognizer = r;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  VOICE ACTIVITY DETECTION (VAD)
  //  Uses Web Audio AnalyserNode to detect silence and auto-stop after
  //  VAD_SILENCE_MS of no voice — prevents runaway recordings.
  // ══════════════════════════════════════════════════════════════════════════
  _startVAD() {
    if (!this.mediaStream || !this.audioContext) return;
    this._vadActive = true;

    const source   = this.audioContext.createMediaStreamSource(this.mediaStream);
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize        = 256;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
    this._analyser = analyser;

    const buf  = new Float32Array(analyser.fftSize);
    let silenceStart = null;

    const tick = () => {
      if (!this._vadActive) return;
      analyser.getFloatTimeDomainData(buf);

      // RMS amplitude
      let sum = 0;
      for (const s of buf) sum += s * s;
      const rms = Math.sqrt(sum / buf.length);

      if (rms > VAD_THRESHOLD) {
        silenceStart = null; // voice detected — reset silence timer
      } else {
        if (!silenceStart) silenceStart = Date.now();
        else if (Date.now() - silenceStart > VAD_SILENCE_MS) {
          // Auto-stop on prolonged silence
          this._stopListening();
          return;
        }
      }
      this._vadRafId = requestAnimationFrame(tick);
    };
    this._vadRafId = requestAnimationFrame(tick);
  }

  _stopVAD() {
    this._vadActive = false;
    if (this._vadRafId) { cancelAnimationFrame(this._vadRafId); this._vadRafId = null; }
    if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; }
    this._analyser = null;
  }

  _resetVADTimer() {
    // Called on each final transcript — give extra time before auto-stop
    if (this._silenceTimer) clearTimeout(this._silenceTimer);
    this._silenceTimer = setTimeout(() => this._stopListening(), VAD_SILENCE_MS + 500);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  HOTWORD DETECTION — "hey modica"
  //  Uses continuous Web Speech recognition in the background.
  //  Lightweight — only fires _startListening() when hotword is heard.
  //  Disabled by default. Toggle in Settings → Voice Engine.
  // ══════════════════════════════════════════════════════════════════════════
  _startHotwordLoop() {
    if (this._hotwordActive) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || !this.mediaStream) return;

    this._hotwordActive = true;
    const r = new SR();
    r.continuous     = true;
    r.interimResults = true;
    r.lang           = 'en-US';

    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript.toLowerCase().trim();
        if (t.includes('hey modica') || t.includes('hey john') || t.includes('ok modica')) {
          if (!this.micEnabled) {
            window.appController?.toast('🎤 Hotword detected! Listening…', 'info');
            this._startListening();
          }
        }
      }
    };
    r.onend = () => { if (this._hotwordActive) try { r.start(); } catch (_) {} };
    try { r.start(); } catch (_) {}
    this._hotwordRecognizer = r;
  }

  stopHotword() {
    this._hotwordActive = false;
    try { this._hotwordRecognizer?.stop(); } catch (_) {}
    this._hotwordRecognizer = null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  TOGGLE TTS
  // ══════════════════════════════════════════════════════════════════════════
  toggleTTS() {
    this.ttsEnabled = !this.ttsEnabled;
    window.settingsManager?.set('voiceTTSEnabled', String(this.ttsEnabled));
    this._syncTTSButton();
    window.appController?.toast(
      this.ttsEnabled ? '🔊 Auto-speak ON' : '🔇 Auto-speak OFF',
      'info'
    );
  }

  _syncTTSButton() {
    const btn = document.getElementById('tts-toggle-btn');
    if (!btn) return;
    btn.textContent = this.ttsEnabled ? '🔊' : '🔇';
    btn.title       = this.ttsEnabled ? 'Auto-speak ON — click to mute' : 'Auto-speak OFF — click to enable';
    btn.classList.toggle('active', this.ttsEnabled);
    btn.style.display = '';

    // Also update badge
    const badge = document.getElementById('voice-tier-badge');
    if (badge) {
      badge.textContent = this.xttsAvailable ? '🎙 XTTS' : '🔈 WebSpeech';
      badge.title       = this.xttsAvailable
        ? 'Voice clone active (Coqui XTTS-v2 — localhost:5002)'
        : 'Web Speech API (system voice)';
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  KEYBOARD SHORTCUT — Ctrl+Space push-to-talk
  // ══════════════════════════════════════════════════════════════════════════
  bindPushToTalk() {
    let held = false;
    document.addEventListener('keydown', async (e) => {
      if (e.code === 'Space' && e.ctrlKey && !held) {
        held = true;
        e.preventDefault();
        if (!this.mediaStream) await this.requestMicAccess();
        if (!this.micEnabled) this._startListening();
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && e.ctrlKey && held) {
        held = false;
        this._stopListening();
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  UI HELPERS
  // ══════════════════════════════════════════════════════════════════════════
  _updateMicButton(active) {
    const btn = document.getElementById('voice-btn');
    if (!btn) return;
    btn.textContent  = active ? '🔴' : '🎤';
    btn.title        = active ? 'Listening… (Ctrl+Space to stop)' : 'Click or Ctrl+Space to listen';
    btn.setAttribute('aria-pressed', String(active));
    btn.classList.toggle('recording', active);
  }

  _emitError(msg) {
    console.warn('[VoiceEngine]', msg);
    this.onError?.(msg);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  destroy() {
    this._stopListening();
    this.stopHotword();
    this.stopSpeaking();
    clearInterval(this._xttsCheckTimer);
    this.mediaStream?.getTracks().forEach(t => t.stop());
    this.audioContext?.close();
  }

  // ── Status info ───────────────────────────────────────────────────────────
  getStatus() {
    return {
      xttsAvailable: this.xttsAvailable,
      ttsEnabled:    this.ttsEnabled,
      micEnabled:    this.micEnabled,
      hasMicAccess:  !!this.mediaStream,
      hotwordOn:     this._hotwordActive,
      tier:          this.xttsAvailable ? 'XTTS-v2 (voice clone)' : 'Web Speech API',
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
const voiceEngine = new VoiceEngine();
if (typeof window !== 'undefined') window.voiceEngine = voiceEngine;
