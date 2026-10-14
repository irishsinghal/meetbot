// `meetbot doctor`: everything that commonly goes wrong, checked in one go.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { jwtInfo } from './config.js';
import { SIDECAR } from './audio/source.js';
import { listModels } from './summarize/ollama.js';
import { listTemplates } from './summarize/template.js';
import { sttModel, sttReady } from './refine.js';

export async function doctor(cfg) {
  const rows = []; const add = (ok, label, detail = '') => rows.push({ ok, label, detail });
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 20, 'Node.js', `v${process.versions.node}${major >= 20 ? '' : ' (need 20+)'}`);

  const v = cfg.voicegain;
  add(!!v.jwt, 'Voicegain JWT', v.jwt ? (() => { const i = jwtInfo(v.jwt); return i?.exp ? `set, expires ${i.exp.toISOString().slice(0, 10)}${i.exp < new Date() ? ' (EXPIRED)' : ''}` : 'set'; })() : 'missing - set the VOICEGAIN_JWT environment variable');
  if (v.jwt) { const i = jwtInfo(v.jwt); if (i?.exp && i.exp < new Date()) rows.at(-1).ok = false; }
  add(!!v.saConfig, 'Speech Analytics config id', v.saConfig ? 'set' : 'missing - create one in the Voicegain console and set VOICEGAIN_SA_CONFIG (the API marks it required)');
  add(true, 'Voicegain API', v.baseUrl);

  const candidates = cfg.capture.python ? [[cfg.capture.python, []]] : process.platform === 'win32' ? [['python', []], ['py', ['-3']]] : [['python3', []], ['python', []]];
  let py = null;
  for (const [cmd, pre] of candidates) { const r = spawnSync(cmd, [...pre, SIDECAR, '--check'], { encoding: 'utf8', timeout: 15000 }); if (!r.error) { py = { r, cmd }; break; } }
  if (!py) add(false, 'Audio capture (Python)', 'Python not found. Install Python 3, then: pip install pyaudiowpatch numpy');
  else if (py.r.status === 0) { let d = {}; try { d = JSON.parse(py.r.stdout); } catch { /* ignore */ } add(true, 'Audio capture', `mic: ${d.mic || '?'} | system: ${d.loopback || '?'}`); }
  else if (py.r.status === 2) add(false, 'Audio capture (Python)', 'missing packages. Run: pip install pyaudiowpatch numpy');
  else { let d = {}; try { d = JSON.parse(py.r.stdout); } catch { /* ignore */ } add(false, 'Audio capture', `device problem (mic: ${d.mic || 'none'}, system: ${d.loopback || 'none'})`); }

  try {
    const models = await listModels(cfg.llm.url);
    const has = models.includes(cfg.llm.model) || models.some((m) => m.split(':')[0] === cfg.llm.model && !cfg.llm.model.includes(':'));
    add(has, 'Local model (Ollama)', has ? cfg.llm.model : `"${cfg.llm.model}" not installed. Run: ollama pull ${cfg.llm.model}   (installed: ${models.join(', ') || 'none'})`);
  } catch (e) { add(false, 'Local model (Ollama)', `not reachable at ${cfg.llm.url} - start Ollama (summaries need it; transcripts do not)`); }

  if (cfg.recording?.enabled) { const ok = sttReady(cfg); add(ok, 'Local transcription (faster-whisper)', ok ? `ready (${sttModel(cfg)}); recording is on by default` : 'recording is on but faster-whisper is missing. Run: meetbot setup'); }

  try { fs.mkdirSync(cfg.outputDir, { recursive: true }); fs.accessSync(cfg.outputDir, fs.constants.W_OK); add(true, 'Output folder', cfg.outputDir); } catch (e) { add(false, 'Output folder', `${cfg.outputDir}: ${e.message}`); }
  add(true, 'Templates', `${listTemplates().join(', ')} (default: ${cfg.template})`);
  return rows;
}
