// Voicegain real-time Speech Analytics: POST /sa, then stream audio over one websocket and read results
// from another. Everything Voicegain-specific lives in this folder.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { redact } from '../config.js';

export class VoicegainError extends Error {
  constructor(message, { status, reason, detail } = {}) { super(message); this.name = 'VoicegainError'; this.status = status; this.reason = reason; this.detail = detail; }
}

const safeLabel = (s) => String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 64);

/** Hints boost recognition of names/jargon. Spec: no special chars except "_", max 50, optional ":weight". */
export function toHints(words = [], weight = 6) {
  const seen = new Set();
  const out = [];
  for (const w of words) {
    const h = String(w).trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_]/gu, '');
    if (h && !seen.has(h.toLowerCase())) { seen.add(h.toLowerCase()); out.push(`${h}:${weight}`); }
  }
  return out.slice(0, 50);
}

/** Request body for POST /sa. Channel layout: LEFT = your microphone, RIGHT = system audio (remote side). */
export function buildSessionRequest(cfg, { title = '', hints = [], diarization = cfg.voicegain.diarization, tags = [] } = {}) {
  const v = cfg.voicegain;
  const asr = { languages: [v.language], content: v.content };
  if (v.optimizedFor) asr.optimizedFor = v.optimizedFor; // Ascalon rejects this field, so it is off by default
  if (v.model) asr.acousticModelRealTime = v.model;
  const h = toHints(hints);
  if (h.length) asr.hints = h;
  if (diarization) asr.diarization = { minSpeakers: 1, maxSpeakers: v.maxSpeakers };
  const body = {
    asyncMode: 'REAL-TIME',
    label: safeLabel(title) || undefined,
    tags: ['meetbot', ...tags].slice(0, 32),
    persist: v.persist,
    audio: {
      source: { stream: { protocol: v.protocol, noAudioTimeout: v.noAudioTimeout } },
      format: 'L16', rate: 16000, channels: 'stereo', capture: false,
    },
    speakerChannels: [
      { audioChannelSelector: 'left', vadMode: 'normal', isAgent: true },
      { audioChannelSelector: 'right', vadMode: 'normal', isAgent: false },
    ],
    virtualDualChannelEnabled: false,
    asr,
  };
  if (v.saConfig) body.saConfig = v.saConfig;
  return JSON.parse(JSON.stringify(body)); // drop undefined
}

const fixWs = (u) => String(u || '').replace(/^(wss?):\/(?!\/)/, '$1://'); // docs show a typo'd "wss:/host" form

export async function createSession(cfg, body, fetchImpl = fetch) {
  const v = cfg.voicegain;
  if (!v.jwt) throw new VoicegainError('No Voicegain JWT. Set the VOICEGAIN_JWT environment variable.');
  let res;
  const url = `${v.baseUrl.replace(/\/$/, '')}/sa`;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${v.jwt}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new VoicegainError(`Cannot reach Voicegain (${redact(e.message, cfg)})`);
  }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    const reason = json?.error?.reason; const detail = json?.error?.detail;
    let msg = `Voicegain ${res.status}: ${reason || res.statusText}${detail ? ` - ${detail}` : ''} [POST ${url}] ${text.slice(0, 300)}`;
    if (res.status === 401) msg += ' (check VOICEGAIN_JWT; it may have expired)';
    if (res.status === 400 && !v.saConfig) msg += ' (set VOICEGAIN_SA_CONFIG to a Speech Analytics config id from the Voicegain console)';
    throw new VoicegainError(redact(msg, cfg), { status: res.status, reason, detail });
  }
  const audioUrl = fixWs(json?.audio?.stream?.websocketUrl);
  const resultUrl = fixWs(json?.websocket?.url);
  if (!audioUrl || !resultUrl) {
    throw new VoicegainError(`Voicegain response is missing websocket URLs (audio.stream.websocketUrl / websocket.url): ${redact(text.slice(0, 300), cfg)}`);
  }
  return { raw: json, sessionId: json.saSessionId, audioUrl, resultUrl, pollUrl: json?.poll?.url, speakerChannels: json.speakerChannels };
}

/** Create a session, retrying once without diarization if the API rejects that setting. */
export async function startSession(cfg, opts, fetchImpl = fetch) {
  try {
    return { ...(await createSession(cfg, buildSessionRequest(cfg, opts), fetchImpl)), diarization: !!(opts.diarization ?? cfg.voicegain.diarization) };
  } catch (e) {
    const wantsDia = opts.diarization ?? cfg.voicegain.diarization;
    if (wantsDia && e.status === 400) {
      const s = await createSession(cfg, buildSessionRequest(cfg, { ...opts, diarization: false }), fetchImpl);
      s.warning = `Voicegain rejected diarization (${e.detail || e.reason}); continuing with channel-based speakers.`;
      return { ...s, diarization: false };
    }
    throw e;
  }
}

/** The two websockets of one session. Events: 'payload'(obj) 'raw'(text) 'open' 'closed'({code,reason,clean}) 'error'(Error) */
export class VoicegainLink extends EventEmitter {
  constructor(session, { maxBuffered = 4 * 1024 * 1024 } = {}) {
    super();
    this.s = session; this.maxBuffered = maxBuffered;
    this.audio = null; this.results = null; this.closed = false; this.ending = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let opened = 0; let failed = false;
      const done = () => { if (++opened === 2 && !failed) { this.emit('open'); resolve(); } };
      const fail = (e) => { if (!failed) { failed = true; reject(e); } };
      // Results first so no early message is missed.
      this.results = new WebSocket(this.s.resultUrl);
      this.audio = new WebSocket(this.s.audioUrl);
      this.results.on('open', done); this.audio.on('open', done);
      this.results.on('message', (data) => {
        const text = data.toString();
        this.emit('raw', text);
        try { this.emit('payload', JSON.parse(text)); } catch { /* ignore non-JSON frames */ }
      });
      for (const [name, ws] of [['results', this.results], ['audio', this.audio]]) {
        ws.on('error', (e) => { fail(e); this.emit('error', new Error(`Voicegain ${name} socket: ${e.message}`)); });
        ws.on('close', (code, reason) => this._onClose(name, code, reason));
      }
    });
  }

  _onClose(name, code, reason) {
    if (this.closed) return;
    // Results socket closing ends the session; audio socket closing unexpectedly does too.
    if (name === 'results' || !this.ending) {
      this.closed = true;
      this.emit('closed', { which: name, code, reason: reason?.toString?.() || '', clean: this.ending });
      try { this.audio?.terminate(); this.results?.terminate(); } catch { /* ignore */ }
    }
  }

  get healthy() { return !this.closed && this.audio?.readyState === WebSocket.OPEN; }

  /** Send one binary audio frame. Returns false if it could not be sent. */
  sendAudio(buf) {
    if (!this.healthy) return false;
    if (this.audio.bufferedAmount > this.maxBuffered) { this.emit('backpressure', this.audio.bufferedAmount); return false; }
    this.audio.send(buf, { binary: true });
    return true;
  }

  /** Close the audio stream (tells Voicegain to finish) and wait for the remaining results. */
  async end(timeoutMs = 8000) {
    if (this.closed) return;
    this.ending = true;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.once('closed', () => { clearTimeout(t); resolve(); });
      try { this.audio.close(1000); } catch { resolve(); }
    });
    this.closed = true;
    try { this.results?.close(); } catch { /* ignore */ }
  }
}
