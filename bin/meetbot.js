#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, redact } from '../src/config.js';
import { FileSource, SidecarSource } from '../src/audio/source.js';
import { MeetingSession } from '../src/session.js';
import { applyIcs, applyPreset, presetStore } from '../src/commands.js';

const USAGE = `MeetBot - terminal meeting recorder with a live notepad

  meetbot [start] [options]       record a meeting (TUI)
  meetbot summarize <folder>      re-run the summary for a saved meeting  [--template name|file]
  meetbot doctor                  check setup (Voicegain JWT, audio capture, Ollama, folders)
  meetbot probe [--seconds 15]    open a test Voicegain session and show the raw websocket messages
  meetbot presets | templates | devices

start options:
  --title <text>        meeting title (default: the local model suggests one)
  --preset <name>       load saved speakers (see /preset in the app)
  --ics <file>          load title + attendees from a calendar invite
  --attendee <name>     add a participant (repeatable)
  --template <name|file>  summary template (default: general-meeting)
  --me <name>           your name in the transcript
  --room                everyone is on the microphone (no remote channel)
  --no-system / --no-mic   capture only one side
  --out <dir>           output folder (default: Documents/MeetBot)
  --file <wav>          replay a 16-bit WAV instead of live capture (--file-as system|mic, --speed 2)
  --plain               line-based mode instead of the full-screen UI
  --no-summary          skip the local summary
  -y, --auto-start      start recording immediately
`;

const opts = {
  title: { type: 'string' }, preset: { type: 'string' }, ics: { type: 'string' }, attendee: { type: 'string', multiple: true },
  template: { type: 'string' }, me: { type: 'string' }, room: { type: 'boolean' }, 'no-system': { type: 'boolean' }, 'no-mic': { type: 'boolean' },
  out: { type: 'string' }, file: { type: 'string' }, 'file-as': { type: 'string' }, speed: { type: 'string' }, plain: { type: 'boolean' },
  'no-summary': { type: 'boolean' }, 'auto-start': { type: 'boolean', short: 'y' }, seconds: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  mic: { type: 'string' }, loopback: { type: 'string' },
};

function sourceFactory(cfg, v) {
  return () => {
    if (v.file) return new FileSource(v.file, { as: v['file-as'] || 'system', speed: Number(v.speed || 1) });
    const args = [];
    if (v['no-mic']) args.push('--no-mic'); if (v['no-system'] || v.room) args.push('--no-system');
    if (v.mic) args.push('--mic', v.mic); if (v.loopback) args.push('--loopback', v.loopback);
    return new SidecarSource({ python: cfg.capture.python, args });
  };
}

async function main() {
  const { values: v, positionals } = parseArgs({ options: opts, allowPositionals: true, strict: false });
  const cmd = positionals[0] && !positionals[0].startsWith('-') ? positionals[0] : 'start';
  if (v.help || cmd === 'help') { console.log(USAGE); return; }
  const cfg = loadConfig({ ...(v.out ? { outputDir: path.resolve(v.out) } : {}), ...(v.me ? { me: v.me } : {}), ...(v.template ? { template: v.template } : {}) });

  if (cmd === 'version') { console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version); return; }
  if (cmd === 'templates') { const { listTemplates } = await import('../src/summarize/template.js'); console.log(listTemplates().join('\n')); return; }
  if (cmd === 'presets') { const l = presetStore().list(); console.log(l.length ? l.join('\n') : 'No presets yet. In a meeting: /add names, then /preset save <name>.'); return; }
  if (cmd === 'devices') { const { spawnSync } = await import('node:child_process'); const { SIDECAR } = await import('../src/audio/source.js'); const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [SIDECAR, '--list'], { encoding: 'utf8' }); console.log(r.stdout || r.stderr); return; }
  if (cmd === 'doctor') {
    const { doctor } = await import('../src/doctor.js');
    const rows = await doctor(cfg);
    for (const r of rows) console.log(`${r.ok ? '  ok ' : ' FAIL'}  ${r.label}${r.detail ? `: ${r.detail}` : ''}`);
    process.exitCode = rows.every((r) => r.ok) ? 0 : 1; return;
  }
  if (cmd === 'summarize') {
    const dir = positionals[1]; if (!dir) throw new Error('Usage: meetbot summarize <meeting folder> [--template name]');
    const { resummarize } = await import('../src/recover.js');
    const r = await resummarize(path.resolve(dir), cfg, { template: v.template, onProgress: (m) => console.log(m) });
    console.log(`Wrote ${r.file} (template: ${r.template})${r.warning ? `\n! ${r.warning}` : ''}`); return;
  }
  if (cmd === 'probe') {
    const { probe } = await import('../src/probe.js');
    await probe(cfg, { seconds: Number(v.seconds || 15), source: sourceFactory(cfg, v)() }); return;
  }
  if (cmd !== 'start') { console.error(`Unknown command "${cmd}".\n\n${USAGE}`); process.exitCode = 2; return; }

  // ---- start ----
  const session = new MeetingSession(cfg, { sourceFactory: sourceFactory(cfg, v) });
  if (v.title) session.title = v.title;
  if (v.room) session.setMode('room');
  if (v.preset) { const p = presetStore().load(v.preset); if (!p) throw new Error(`No preset "${v.preset}". Existing: ${presetStore().list().join(', ') || 'none'}`); applyPreset(session, p); }
  if (v.ics) applyIcs(session, fs.readFileSync(v.ics, 'utf8'));
  for (const a of v.attendee || []) session.addPerson(a);
  if (v.me) session.setMe(v.me);

  if (!cfg.voicegain.jwt) console.error('Note: VOICEGAIN_JWT is not set; run "meetbot doctor".');
  const summarize = !v['no-summary'];
  const origStop = session.stop.bind(session); session.stop = (o = {}) => origStop({ summarize: o.summarize !== false && summarize });

  if (v.plain || !process.stdin.isTTY || !process.stdout.isTTY) {
    const { runPlain } = await import('../src/tui/plain.js');
    await runPlain(session, { autoStart: true, stopAfterSourceEnd: !!v.file });
  } else {
    const { runTui } = await import('../src/tui/app.js');
    const r = await runTui(session, { autoStart: !!v['auto-start'] });
    if (r) console.log(`Saved to ${r.dir}`);
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(`Error: ${redact(e.message, loadConfig())}`); process.exit(1); });
