# 🎙 John Modica AI — Voice Sample Folder

## DROP YOUR VOICE HERE

Place a clean WAV recording of your voice in this folder:

```
assets/voices/john-voice.wav
```

That's it. The TTS server reads it automatically on every synthesis request.
No training. No fine-tuning. No accounts. No API keys. Free forever.

---

## Recording Guidelines

| Setting | Recommended |
|---------|-------------|
| Duration | 15–30 seconds (longer = better clone quality) |
| Format | WAV, 22050 Hz or 44100 Hz, mono or stereo |
| Environment | Quiet room — no background noise, no echo |
| Content | Read anything naturally in your normal speaking voice |
| Mic | Any mic works — USB, headset, phone, built-in |

**What to say (example):**
> "My name is John Modica. I'm the founder of CybernetiX S3C, a cybersecurity
> company dedicated to ethical hacking and protecting digital infrastructures.
> I've spent years in the field conducting penetration tests, identifying
> vulnerabilities, and helping people understand the world of cyber security.
> Keep that darkness lit."

---

## Files in This Folder

| File | Purpose |
|------|---------|
| `john-voice.wav` | **Your voice sample** — drop it here |
| `john-voice-embed.json` | Auto-generated speaker embedding cache (delete to force re-compute) |
| `README.md` | This file |

---

## How It Works

1. `tts-server.py` starts automatically when John Modica AI boots
2. XTTS-v2 model loads (~3–8 sec after first download)
3. On first TTS request, it reads `john-voice.wav` and computes a speaker embedding
4. The embedding is cached to `john-voice-embed.json` — subsequent requests are faster
5. Every AI response is synthesized in your cloned voice, locally, offline

---

## Swapping Voices at Runtime

```
POST http://localhost:5002/set-voice
{"voice_sample": "assets/voices/other-voice.wav"}
```

Or just replace `john-voice.wav` and restart the TTS server.

---

## Model Storage (NOT in this folder)

The XTTS-v2 model (~1.8 GB) downloads **once** to:
- Linux/macOS: `~/.local/share/tts/`
- Windows: `%APPDATA%\tts\`

It is **not** stored in the project folder and **not** in the repo.
The `.gitignore` excludes it. You only download it once — ever.

---

## No Voice Sample?

The app still works. It falls back to the **Web Speech API** (built into
Chromium) — a system voice speaks the responses. Not your voice, but
fully functional and still 100% free.

---

*CybernetiX S3C — Keep that darkness lit 💜*
