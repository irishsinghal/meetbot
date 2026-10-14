// Configuration: defaults < ~/.meetbot/config.json < environment variables < CLI flags.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Interpreter inside a virtual environment folder, or '' if `dir` is not one. */
export function venvPython(dir) {
  const exe = path.join(dir, ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  return fs.existsSync(exe) ? exe : '';
}

/** Where `meetbot setup` creates the virtual environment for the audio sidecar. */
export const defaultVenvDir = () => path.join(configDir(), 'venv');

/** The Python the sidecar should use when capture.python is not configured: an active venv, then a venv in the repo or ~/.meetbot. */
export function detectVenvPython() {
  const dirs = [process.env.VIRTUAL_ENV, path.join(repoRoot, '.venv'), path.join(repoRoot, 'venv'), defaultVenvDir()];
  for (const d of dirs) { const p = d && venvPython(d); if (p) return p; }
  return '';
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
    folderLayout: 'day',       // flat | day | nested (see `meetbot layout`)
    template: 'auto',          // 'auto' = voice-note when only you spoke, otherwise general-meeting; or any template name/file
    voicegain: {
      baseUrl: 'https://api.ascalon.ai/v1',
      jwt: '',                 // prefer the VOICEGAIN_JWT environment variable
      saConfig: '',            // id of a Speech Analytics configuration (create it in the Voicegain console)
      language: 'en-us',
      optimizedFor: '',           // Voicegain-only setting (e.g. 'meeting'); the Ascalon API rejects it
      model: '',               // e.g. VoiceGain-kappa (best accuracy) / VoiceGain-rho (lower latency); empty = default
      content: 'segments',     // 'segments' (live partial text, ~2 s latency) or 'words' (word-level; ~4 s latency on Ascalon)
      diarization: false,      // ask Voicegain to diarize too (falls back automatically if rejected)
      maxSpeakers: 6,
      protocol: 'WSS',
      noAudioTimeout: 1800000, // ms; keeps the session alive while paused (API maximum is 30 min)
      persist: 60000,          // ms Voicegain retains the result after the session ends
      lineGapMs: 1500,         // silence between words that starts a new transcript line
    },
    llm: { url: 'http://127.0.0.1:11434', model: 'qwen2.5:7b-instruct', ctx: 16384, chunkChars: 24000 },
    mentions: { enabled: true, names: [] }, // flag when someone says your name (plus these aliases) and explain why with the local model
    ui: { popup: true },        // open the browser UI as a small app-style window (Edge/Chrome/Brave); false = a normal tab
    capture: { python: '' },
    // Optional, recommended: keep the call's audio locally and re-transcribe it after the call with local Whisper
    // (speakers still come from the live results). The recording is deleted once that succeeds. Asked in `meetbot setup`.
    recording: { enabled: false, model: '' }, // model '' = small.en (English) / small (other languages)
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
  set(cfg, 'folderLayout', env.MEETBOT_LAYOUT);
  set(cfg.llm, 'model', env.MEETBOT_LLM);
  set(cfg.llm, 'url', env.OLLAMA_URL);
  set(cfg.capture, 'python', env.MEETBOT_PYTHON);
  set(cfg.recording, 'model', env.MEETBOT_STT_MODEL);
  if (!cfg.capture.python) cfg.capture.python = detectVenvPython();
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
