// Configuration: defaults < ~/.meetbot/config.json < environment variables < CLI flags.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function configDir() {
  return process.env.MEETBOT_HOME || path.join(os.homedir(), '.meetbot');
}

/** The user's real Documents folder (handles OneDrive-redirected Documents on Windows). */
export function documentsDir() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('MyDocuments')"],
        { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
      if (out) return out;
    } catch { /* fall through */ }
  }
  return path.join(os.homedir(), 'Documents');
}

const deepMerge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof a?.[k] === 'object' ? deepMerge(a[k], v) : v;
  }
  return out;
};

export function defaults() {
  return {
    me: 'You',
    outputDir: path.join(documentsDir(), 'MeetBot'),
    template: 'general-meeting',
    voicegain: {
      baseUrl: 'https://api.voicegain.ai/v1',
      jwt: '',                 // prefer the VOICEGAIN_JWT environment variable
      saConfig: '',            // id of a Speech Analytics configuration (create it in the Voicegain console)
      language: 'en-us',
      optimizedFor: 'meeting',
      model: '',               // e.g. VoiceGain-kappa (best accuracy) / VoiceGain-rho (lower latency); empty = default
      content: 'words',        // 'words' (word-level, with edits) or 'segments'
      diarization: false,      // ask Voicegain to diarize too (falls back automatically if rejected)
      maxSpeakers: 6,
      protocol: 'WSS',
      noAudioTimeout: 1800000, // ms; keeps the session alive while paused (API maximum is 30 min)
      persist: 60000,          // ms Voicegain retains the result after the session ends
      lineGapMs: 1500,         // silence between words that starts a new transcript line
    },
    llm: { url: 'http://127.0.0.1:11434', model: 'qwen2.5:7b-instruct', ctx: 16384, chunkChars: 24000 },
    capture: { python: '' },
    speakerLagSec: 1.0,        // pressing a speaker key applies from this many seconds in the past
  };
}

export function loadConfig(overrides = {}) {
  let cfg = defaults();
  const file = path.join(configDir(), 'config.json');
  try { cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${e.message}`);
  }
  const env = process.env;
  const set = (obj, key, val) => { if (val !== undefined && val !== '') obj[key] = val; };
  set(cfg.voicegain, 'jwt', env.VOICEGAIN_JWT);
  set(cfg.voicegain, 'baseUrl', env.VOICEGAIN_BASE_URL);
  set(cfg.voicegain, 'saConfig', env.VOICEGAIN_SA_CONFIG);
  set(cfg.voicegain, 'language', env.MEETBOT_LANG);
  set(cfg, 'me', env.MEETBOT_ME);
  set(cfg, 'outputDir', env.MEETBOT_OUTPUT_DIR);
  set(cfg, 'template', env.MEETBOT_TEMPLATE);
  set(cfg.llm, 'model', env.MEETBOT_LLM);
  set(cfg.llm, 'url', env.OLLAMA_URL);
  set(cfg.capture, 'python', env.MEETBOT_PYTHON);
  return deepMerge(cfg, overrides);
}

/** Remove secrets from anything we might print or log. */
export function redact(text, cfg) {
  let s = String(text ?? '');
  const jwt = cfg?.voicegain?.jwt;
  if (jwt) s = s.split(jwt).join('<JWT>');
  return s.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '<JWT>');
}

/** Decode (not verify) the JWT payload to show expiry in `doctor`. */
export function jwtInfo(jwt) {
  try {
    const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return { exp: p.exp ? new Date(p.exp * 1000) : null };
  } catch { return null; }
}
