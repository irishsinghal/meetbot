// Post-meeting pass: re-transcribe the kept stereo recording locally (faster-whisper, sidecar/transcribe.py), then
// attribute every word using the live results as the source of truth for WHO spoke (channel + speaker timeline +
// Voicegain diarization), and delete the recording once that succeeded.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { SIDECAR } from './audio/source.js';
import { loadMeeting, resummarize } from './recover.js';
import { renderTranscript } from './render.js';

export const TRANSCRIBE = path.resolve(path.dirname(SIDECAR), 'transcribe.py');
export const AUDIO_FILE = 'audio.pcm';
export const STT_REQUIREMENTS = path.resolve(path.dirname(SIDECAR), 'requirements-stt.txt');

/** Whisper model for the configured language: small.en for English, multilingual small otherwise. */
export function sttModel(cfg) {
  if (cfg.recording?.model) return cfg.recording.model;
  return /^en(-|$)/i.test(cfg.voicegain?.language || 'en') ? 'small.en' : 'small';
}

const pythonCmd = (cfg) => (cfg.capture?.python ? { cmd: cfg.capture.python, pre: [] } : process.platform === 'win32' ? { cmd: 'python', pre: [] } : { cmd: 'python3', pre: [] });

/** True if faster-whisper can be imported with the configured Python. */
export function sttReady(cfg, run = spawnSync) {
  const { cmd, pre } = pythonCmd(cfg);
  const r = run(cmd, [...pre, TRANSCRIBE, '--check'], { encoding: 'utf8', timeout: 20000 });
  return !r.error && r.status === 0;
}

/**
 * Attribute words to speakers from the live lines and group them into transcript lines.
 * words: [{chn, w, s, e}] (seconds). live: [{t, tEnd, speaker, chn}]. fallback(chn, sec) names a speaker when no live line is near.
 */
export function mergeWords(words, live, { fallback = () => 'Speaker', pad = 2, gap = 1.5, maxWords = 45 } = {}) {
  const out = [];
  for (const chn of [0, 1]) {
    const cand = live.filter((l) => l.chn === chn || l.chn === undefined).sort((a, b) => a.t - b.t);
    let prev = null; let cur = null;
    for (const w of words.filter((x) => x.chn === chn).sort((a, b) => a.s - b.s)) {
      const mid = (w.s + w.e) / 2;
      let best = null; let bd = Infinity;
      for (const l of cand) { const d = mid < l.t ? l.t - mid : mid > l.tEnd ? mid - l.tEnd : 0; if (d < bd) { bd = d; best = l; } }
      const speaker = best && bd <= pad ? best.speaker : (prev ?? fallback(chn, mid));
      prev = speaker;
      if (!cur || cur.speaker !== speaker || w.s - cur.tEnd > gap || cur.n >= maxWords) {
        cur = { t: w.s, tEnd: w.e, speaker, chn, text: '', n: 0, live: false }; out.push(cur);
      }
      cur.text += (cur.text ? ' ' : '') + w.w; cur.tEnd = Math.max(cur.tEnd, w.e); cur.n += 1;
    }
  }
  return out.sort((a, b) => a.t - b.t || a.chn - b.chn).map(({ n, ...l }) => l);
}

/** Run the sidecar over `audioPath`; resolves to [{chn, w, s, e, p}]. */
export function transcribeAudio(cfg, audioPath, { prompt = '', onProgress, spawnImpl = spawn } = {}) {
  const { cmd, pre } = pythonCmd(cfg);
  const lang = (cfg.voicegain?.language || 'en').split('-')[0];
  const args = [...pre, TRANSCRIBE, '--audio', audioPath, '--model', sttModel(cfg), '--language', lang];
  if (prompt) args.push('--prompt', prompt);
  return new Promise((resolve, reject) => {
    let proc; try { proc = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { reject(e); return; }
    const words = []; let finished = false; let lastErr = '';
    readline.createInterface({ input: proc.stdout }).on('line', (l) => {
      let m; try { m = JSON.parse(l); } catch { return; }
      if (m.done) finished = true;
      else for (const w of m.words || []) words.push({ chn: m.chn, w: w.w, s: w.s, e: w.e, p: w.p });
    });
    readline.createInterface({ input: proc.stderr }).on('line', (l) => {
      let m; try { m = JSON.parse(l); } catch { lastErr = l; return; }
      if (m.type === 'progress') onProgress?.(m.pct); else if (m.type === 'error') lastErr = m.message;
    });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 && finished ? resolve(words) : reject(new Error(`Local transcription failed (exit ${code}): ${lastErr || 'no details'}`))));
  });
}

/** Refined transcript lines for a meeting. `book` is the SpeakerBook (used as a fallback name source). */
export async function refineLines({ cfg, audioPath, liveLines, book, hints = [], onProgress, transcribe = transcribeAudio }) {
  const words = await transcribe(cfg, audioPath, { prompt: hints.join(', '), onProgress: (p) => onProgress?.(`Refining transcript locally... ${Math.round(p * 100)}%`) });
  if (!words.length) throw new Error('Local transcription found no speech');
  const fallback = (chn, sec) => (chn === 0 && book.mode !== 'room' ? book.me : book.speakerAt(sec) || (book.mode === 'room' ? 'Speaker' : 'Remote'));
  return mergeWords(words, liveLines, { fallback });
}

/** Delete the recording and note it in meeting.json. Never throws. */
export function discardAudio(dir) {
  try { fs.rmSync(path.join(dir, '.data', AUDIO_FILE), { force: true }); } catch { /* ignore */ }
  try {
    const f = path.join(dir, '.data', 'meeting.json');
    const m = JSON.parse(fs.readFileSync(f, 'utf8')); m.audio = false; m.refined = true; fs.writeFileSync(f, JSON.stringify(m, null, 2));
  } catch { /* ignore */ }
}

/** `meetbot retranscribe <folder>`: redo transcript.md + summary.md from a kept recording, then delete it. */
export async function retranscribeMeeting(dir, cfg, { onProgress, transcribe, summarizer } = {}) {
  const audioPath = path.join(dir, '.data', AUDIO_FILE);
  if (!fs.existsSync(audioPath)) throw new Error(`No recording in ${dir} (it is deleted after a successful transcription, or recording was off)`);
  const { meta, lines, book } = loadMeeting(dir, cfg);
  const refined = await refineLines({ cfg, audioPath, liveLines: lines, book, hints: [...book.roster, book.me], onProgress, transcribe });
  const transcript = path.join(dir, 'transcript.md');
  if (fs.existsSync(transcript)) fs.copyFileSync(transcript, path.join(dir, '.data', 'transcript-live.md'));
  const participants = [...new Set([...(book.mode !== 'room' ? [book.me] : []), ...book.roster, ...refined.map((l) => l.speaker)])];
  fs.writeFileSync(transcript, renderTranscript({ ...meta, participants, lines: refined }), 'utf8');
  const r = await resummarize(dir, cfg, { lines: refined, summarizer, onProgress });
  discardAudio(dir);
  return { lines: refined.length, summary: r.file, warning: r.warning };
}
