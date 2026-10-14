// Persistent diagnostic log: ~/.meetbot/logs/meetbot.log (home overridable with MEETBOT_HOME).
// Everything session.log() emits, plus startup info and uncaught errors with stack traces. Secrets are redacted.
// Never throws: logging must not break the app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, redact } from './config.js';

const MAX_BYTES = 2 * 1024 * 1024;
let file = null; let cfgRef = null; let signalHandler = null;

/** Replace the default "exit immediately" reaction to SIGINT/SIGTERM/SIGHUP (e.g. to save a meeting first). */
export function onSignal(fn) { signalHandler = fn; }

export function logFile() { return file; }

export function initErrLog(cfg, { argv = process.argv.slice(2) } = {}) {
  try {
    cfgRef = cfg;
    const dir = path.join(configDir(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'meetbot.log');
    try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.old`); } catch { /* no file yet */ }
    writeLog('info', `---- start pid=${process.pid} node=${process.version} ${process.platform}/${process.arch} ${os.release()} cwd=${process.cwd()}`);
    writeLog('info', `argv: ${argv.join(' ')}`);
    writeLog('info', `config: ${JSON.stringify({ outputDir: cfg.outputDir, python: cfg.capture?.python, voicegainBase: cfg.voicegain?.baseUrl, jwtSet: !!cfg.voicegain?.jwt, llm: cfg.llm?.url, llmModel: cfg.llm?.model })}`);
  } catch { /* ignore */ }
  process.on('uncaughtException', (e) => { writeLog('fatal', `uncaughtException: ${fmt(e)}`); restoreAndExit(e); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) { try { process.on(sig, () => { writeLog('warn', `received ${sig}`); if (signalHandler) signalHandler(sig); else process.exit(130); }); } catch { /* not supported on this platform */ } }
  process.on('exit', (code) => writeLog('info', `---- exit code=${code}`));
  process.on('unhandledRejection', (e) => writeLog('error', `unhandledRejection: ${fmt(e)}`));
  return file;
}

function restoreAndExit(e) {
  try { process.stderr.write(`\nFatal: ${redact(e?.message ?? e, cfgRef)}\nDetails logged to ${file}\n`); } catch { /* ignore */ }
  process.exit(1);
}

const fmt = (e) => (e instanceof Error ? e.stack || e.message : typeof e === 'string' ? e : (() => { try { return JSON.stringify(e); } catch { return String(e); } })());

export function writeLog(level, text) {
  if (!file) return;
  try { fs.appendFileSync(file, `${new Date().toISOString()} [${level}] ${redact(typeof text === 'string' ? text : fmt(text), cfgRef)}\n`); } catch { /* ignore */ }
}
