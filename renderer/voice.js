// ─── voice.js ─────────────────────────────────────────────────────────────────
// John Modica AI Shell — Voice Bridge (Legacy Compatibility Layer)
//
// This file bridges calls from older parts of the codebase to voice-engine.js
// which is the canonical 3-tier TTS implementation.
//
//  Tier 1 — Web Speech API      (instant, built-in, zero install)
//  Tier 2 — Coqui XTTS-v2       (voice clone, local, free forever)
//  Tier 3 — Silent fallback      (app never breaks)
//
// All real logic lives in:  renderer/voice-engine.js
// This file delegates everything there and re-exports for backwards compat.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

/* ── Wait for voice-engine to initialise ─────────────────────────────────── */
let _voiceEngine = null;

function _getEngine() {
  if (_voiceEngine) return _voiceEngine;
  if (window.voiceEngine) { _voiceEngine = window.voiceEngine; return _voiceEngine; }
  return null;
}

/* ── Public bridge API ───────────────────────────────────────────────────── */

/**
 * Speak text using the active TTS engine.
 * @param {string} text
 * @param {object} [opts]  passed through to voice-engine speak()
 */
function speak(text, opts = {}) {
  const eng = _getEngine();
  if (eng && typeof eng.speak === 'function') {
    return eng.speak(text, opts);
  }
  // Fallback: Web Speech API directly
  if ('speechSynthesis' in window && text) {
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = 'en-US';
    window.speechSynthesis.speak(utt);
  }
}

/**
 * Stop any currently playing speech.
 */
function stopSpeech() {
  const eng = _getEngine();
  if (eng && typeof eng.stop === 'function') {
    eng.stop();
    return;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

/**
 * Check whether XTTS voice clone server is available.
 * @returns {boolean}
 */
function isXTTSAvailable() {
  const eng = _getEngine();
  return eng ? !!eng.xttsAvailable : false;
}

/**
 * Trigger a health-check ping to the XTTS server.
 */
function checkXTTSHealth() {
  const eng = _getEngine();
  if (eng && typeof eng.checkHealth === 'function') eng.checkHealth();
}

/* ── Global export ───────────────────────────────────────────────────────── */
window.voiceBridge = { speak, stopSpeech, isXTTSAvailable, checkXTTSHealth };

// Named exports for direct import patterns
if (typeof module !== 'undefined') {
  module.exports = { speak, stopSpeech, isXTTSAvailable, checkXTTSHealth };
}
