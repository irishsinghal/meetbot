// Audio sources emit 'data' events of exactly 100 ms: 6400 bytes of stereo int16 @16 kHz (L = mic, R = system).
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWav, toStereo16k } from './wav.js';

export const FRAME_BYTES = 6400;
export const FRAME_MS = 100;
const here = path.dirname(fileURLToPath(import.meta.url));
export const SIDECAR = path.resolve(here, '../../sidecar/capture.py');

class Chunker {
  constructor(emit) { this.emit = emit; this.buf = Buffer.alloc(0); }
  push(b) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, b]) : b;
    while (this.buf.length >= FRAME_BYTES) { this.emit(this.buf.subarray(0, FRAME_BYTES)); this.buf = this.buf.subarray(FRAME_BYTES); }
  }
}

/** Live capture through the Python sidecar (pyaudiowpatch). */
export class SidecarSource extends EventEmitter {
  constructor({ python = '', args = [], script = SIDECAR } = {}) { super(); this.python = python; this.args = args; this.script = script; this.proc = null; }

  candidates() {
    if (this.python) return [{ cmd: this.python, pre: [] }];
    return process.platform === 'win32'
      ? [{ cmd: 'python', pre: [] }, { cmd: 'py', pre: ['-3'] }, { cmd: 'python3', pre: [] }]
      : [{ cmd: 'python3', pre: [] }, { cmd: 'python', pre: [] }];
  }

  async start() {
    let lastErr;
    for (const c of this.candidates()) {
      try { await this._spawn(c); return; } catch (e) { lastErr = e; if (e.code !== 'ENOENT') break; }
    }
    throw lastErr || new Error('Python not found');
  }

  _spawn({ cmd, pre }) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, [...pre, this.script, ...this.args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.proc = p;
      const chunker = new Chunker((f) => this.emit('data', Buffer.from(f)));
      let ready = false; const errLines = [];
      p.once('error', reject);
      p.stdout.on('data', (b) => chunker.push(b));
      let carry = '';
      p.stderr.on('data', (b) => {
        carry += b.toString('utf8');
        let i;
        while ((i = carry.indexOf('\n')) >= 0) {
          const line = carry.slice(0, i).trim(); carry = carry.slice(i + 1);
          if (!line) continue;
          let o; try { o = JSON.parse(line); } catch { o = { type: 'info', msg: line }; }
          errLines.push(o.msg || line); if (errLines.length > 8) errLines.shift();
          if (o.type === 'ready' && !ready) { ready = true; resolve(); }
          this.emit(o.type === 'error' || o.type === 'warn' ? o.type === 'error' ? 'fault' : 'warn' : 'info', o.msg || line);
        }
      });
      p.once('exit', (code) => {
        if (!ready) reject(new Error(errLines.join(' ') || `capture helper exited with code ${code}`));
        else if (!this.stopping) this.emit('error', new Error(`capture helper stopped unexpectedly (code ${code}). ${errLines.join(' ')}`));
        this.emit('end');
      });
    });
  }

  async stop() {
    this.stopping = true;
    const p = this.proc; if (!p) return;
    await new Promise((resolve) => { p.once('exit', resolve); try { p.stdin.end(); } catch { /* ignore */ } setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve(); }, 1500); });
  }
}

/** Replays a WAV file as if it were live (for demos, tests and re-running a recorded call through Voicegain). */
export class FileSource extends EventEmitter {
  constructor(file, { as = 'system', speed = 1 } = {}) {
    super(); this.file = file; this.as = as; this.speed = speed; this.timer = null;
  }

  async start() {
    this.pcm = toStereo16k(parseWav(fs.readFileSync(this.file)), this.as);
    this.pos = 0;
    const tick = () => {
      if (this.stopped) return;
      if (this.pos >= this.pcm.length) { this.emit('end'); return; }
      const chunk = Buffer.alloc(FRAME_BYTES); this.pcm.copy(chunk, 0, this.pos, Math.min(this.pcm.length, this.pos + FRAME_BYTES));
      this.pos += FRAME_BYTES; this.emit('data', chunk);
      this.timer = setTimeout(tick, FRAME_MS / this.speed);
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop() { this.stopped = true; clearTimeout(this.timer); }
  get durationSec() { return this.pcm ? this.pcm.length / 4 / 16000 : 0; }
}
