// `meetbot setup`: first-run wizard. Saves ~/.meetbot/config.json, installs the sidecar's Python packages,
// pulls the Ollama model and finishes with `doctor`. Every prompt can be skipped by passing its value as a flag.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { configDir, defaultVenvDir, venvPython } from './config.js';
import { SIDECAR } from './audio/source.js';
import { listModels } from './summarize/ollama.js';
import { doctor } from './doctor.js';
import { reconfigureLayout } from './layout.js';
import { STT_REQUIREMENTS, TRANSCRIBE, sttModel, sttReady } from './refine.js';

const REQUIREMENTS = path.resolve(path.dirname(SIDECAR), 'requirements.txt');

/** Merge `updates` (nested objects merge, everything else replaces) into config.json and return its path. */
export function saveConfig(updates, dir = configDir()) {
  const file = path.join(dir, 'config.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${e.message}`); }
  const merge = (a, b) => { for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === 'object' ? merge(a[k] && typeof a[k] === 'object' ? a[k] : {}, v) : v; return a; };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(merge(cur, updates), null, 2)}\n`, { mode: 0o600 });
  return file;
}

const SYSTEM_PYTHONS = process.platform === 'win32' ? [['python', []], ['py', ['-3']]] : [['python3', []], ['python', []]];

/** First Python interpreter that starts, or null. */
export function findPython(cfg, run = spawnSync) {
  const candidates = cfg.capture.python ? [[cfg.capture.python, []]] : SYSTEM_PYTHONS;
  for (const [cmd, pre] of candidates) if (!run(cmd, [...pre, '--version'], { encoding: 'utf8' }).error) return { cmd, pre };
  return null;
}

export async function setup(cfg, flags = {}, io = {}) {
  const out = io.out || ((s) => console.log(s));
  const run = io.run || ((cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }));
  const probe = io.probe || ((cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 }));
  const interactive = !flags.yes && (io.interactive ?? (process.stdin.isTTY && process.stdout.isTTY));
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q, def = '') => {
    if (!rl) return def;
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim();
    return a || def;
  };
  const confirm = async (q) => !rl || /^(y|yes|)$/i.test((await rl.question(`${q} [Y/n]: `)).trim());
  const step = (n, t) => out(`\n[${n}/5] ${t}`);

  try {
    // 1. settings
    step(1, 'Settings');
    const updates = {};
    const jwt = flags.jwt || (cfg.voicegain.jwt ? '' : await ask('Voicegain JWT (stored in plain text in config.json; leave blank to use the VOICEGAIN_JWT env var)'));
    if (jwt) updates.voicegain = { ...updates.voicegain, jwt };
    else if (cfg.voicegain.jwt) out('  Voicegain JWT: already set, keeping it');
    const sa = flags.saConfig || (cfg.voicegain.saConfig ? '' : await ask('Voicegain Speech Analytics config id (create one in the Voicegain console)'));
    if (sa) updates.voicegain = { ...updates.voicegain, saConfig: sa };
    else if (cfg.voicegain.saConfig) out('  SA config id: already set, keeping it');
    const me = flags.me || await ask('Your name in transcripts', cfg.me);
    if (me && me !== 'You') updates.me = me;
    const dir = flags.out || await ask('Where to save meetings', cfg.outputDir);
    if (dir && dir !== cfg.outputDir) updates.outputDir = path.resolve(dir);
    const model = flags.model || cfg.llm.model;
    if (flags.model) updates.llm = { model };
    if (Object.keys(updates).length) {
      const file = saveConfig(updates, io.dir);
      out(`  Saved ${file}`);
    } else out('  Nothing to change.');
    if (updates.voicegain?.jwt) cfg.voicegain.jwt = updates.voicegain.jwt;
    if (updates.voicegain?.saConfig) cfg.voicegain.saConfig = updates.voicegain.saConfig;
    if (updates.outputDir) cfg.outputDir = updates.outputDir;
    cfg.llm.model = model;
    if (flags.layout || rl) await reconfigureLayout(cfg, { layout: flags.layout }, { out, ask, confirm: confirm, dir: io.dir });

    // 2. python packages
    step(2, 'Audio capture packages');
    let py = findPython(cfg);
    if (!py) out('  Python 3 not found. Install it from python.org, then re-run "meetbot setup".');
    else {
      if (!cfg.capture.python && !flags['skip-install']) {
        // No venv found: make one so the packages never touch the system Python.
        const vdir = defaultVenvDir();
        if (await confirm(`  No virtual environment found. Create one at ${vdir}?`)) {
          const r = run(py.cmd, [...py.pre, '-m', 'venv', vdir]);
          const vpy = r.status === 0 ? venvPython(vdir) : '';
          if (vpy) { saveConfig({ capture: { python: vpy } }, io.dir); cfg.capture.python = vpy; py = { cmd: vpy, pre: [] }; out(`  Created it and saved capture.python = ${vpy}`); }
          else out('  Could not create the virtual environment; continuing with the system Python.');
        }
      } else if (cfg.capture.python) out(`  Using ${cfg.capture.python}`);
      const check = () => probe(py.cmd, [...py.pre, SIDECAR, '--check']);
      if (check().status !== 2) out('  pyaudiowpatch and numpy are installed.');
      else if (flags['skip-install']) out(`  Missing packages. Run: ${py.cmd} -m pip install -r "${REQUIREMENTS}"`);
      else if (await confirm('  pyaudiowpatch / numpy are missing. Install them with pip now?')) {
        const r = run(py.cmd, [...py.pre, '-m', 'pip', 'install', '-r', REQUIREMENTS]);
        out(r.status === 0 ? '  Installed.' : '  pip failed; see its output above.');
      }
    }

    // 3. cleaner transcripts: optional local re-transcription of a kept recording
    step(3, 'Cleaner transcripts after each call (optional, recommended)');
    let rec = cfg.recording.enabled;
    if (flags.recording) rec = /^(on|y|yes|true|1)$/i.test(flags.recording);
    else if (rl) rec = await confirm("  Keep each call's audio on this computer and re-transcribe it locally afterwards (deleted when done; speakers still come from the live results)? You can switch it per call in the app");
    if (rec !== cfg.recording.enabled) { saveConfig({ recording: { enabled: rec } }, io.dir); cfg.recording.enabled = rec; }
    out(`  Audio recording is ${rec ? 'ON' : 'off'} by default (config: recording.enabled).`);
    if (rec && py) {
      const model = sttModel(cfg);
      if (sttReady(cfg)) out('  faster-whisper is installed.');
      else if (flags['skip-install']) out(`  Missing package. Run: ${py.cmd} -m pip install -r "${STT_REQUIREMENTS}"`);
      else if (await confirm('  faster-whisper is missing. Install it with pip now?')) {
        const r = run(py.cmd, [...py.pre, '-m', 'pip', 'install', '-r', STT_REQUIREMENTS]);
        out(r.status === 0 ? '  Installed.' : '  pip failed; see its output above.');
      }
      if (!flags['skip-install'] && sttReady(cfg) && await confirm(`  Download the ${model} speech model now (about 0.5 GB, once)?`)) {
        const r = run(py.cmd, [...py.pre, TRANSCRIBE, '--prefetch', '--model', model]);
        out(r.status === 0 ? '  Model ready.' : '  Download failed; it will be retried on first use.');
      }
    }

    // 4. ollama model
    step(4, 'Local summary model');
    let models = null;
    try { models = await listModels(cfg.llm.url); } catch { /* not running */ }
    if (!models) out(`  Ollama is not reachable at ${cfg.llm.url}. Install it from ollama.com and start it, then re-run "meetbot setup" (transcripts work without it).`);
    else if (models.includes(model) || models.some((m) => m.split(':')[0] === model && !model.includes(':'))) out(`  ${model} is installed.`);
    else if (flags['skip-install']) out(`  Missing model. Run: ollama pull ${model}`);
    else if (await confirm(`  ${model} is not installed. Pull it now (several GB)?`)) {
      const r = run('ollama', ['pull', model]);
      out(r.error || r.status !== 0 ? `  Could not run "ollama pull ${model}"; run it yourself.` : '  Pulled.');
    }

    // 5. verify
    step(5, 'Checking everything');
    const rows = await doctor(cfg);
    for (const r of rows) out(`${r.ok ? '  ok ' : ' FAIL'}  ${r.label}${r.detail ? `: ${r.detail}` : ''}`);
    const ok = rows.every((r) => r.ok);
    out(ok ? '\nAll set. Run "meetbot" to start a meeting.' : '\nFix the FAIL items above, then run "meetbot doctor" to re-check.');
    return { ok, rows };
  } finally { rl?.close(); }
}
