// Slash-command interpreter shared by the TUI and the plain-text mode. Returns [{level, text}] to display.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { configDir } from './config.js';
import { parseIcs } from './ics.js';
import { isNoteCommand, KINDS } from './notes.js';
import { fmtClock } from './render.js';
import { PresetStore } from './speakers.js';
import { listTemplates, loadTemplate } from './summarize/template.js';

export const HELP = [
  'NOTES      type + Enter = note   /a action   /d decision   /q question   /f flag this moment',
  'CONTROL    /start  /pause  /resume  /stop  (/stop nosummary)   /reconnect   /status   /open',
  'SPEAKERS   Tab / Shift+Tab = next/prev speaker   /speaker <#|name>   /relabel <#|name> (fix last line)',
  '           /add <name, name>  /rm <#|name>  /roster  /me <name>  /mode call|room  /name <Speaker N> <name>',
  'PRESETS    /preset list | save <n> | load <n> | rm <n>      /ics <file>  load attendees + title from an invite',
  'MEETING    /title <text>  /template [name]  /hint <word>      /help',
].join('\n');

const msg = (text, level = 'info') => ({ level, text });
export const presetStore = () => new PresetStore(path.join(configDir(), 'presets'));

export function applyPreset(session, p) {
  if (p.me) session.setMe(p.me);
  if (p.mode) session.setMode(p.mode);
  (p.participants || []).forEach((n) => session.addPerson(n));
  (p.hints || []).forEach((h) => session.hints.push(h));
}

export function applyIcs(session, text) {
  const ev = parseIcs(text);
  if (ev.title && !session.title) session.title = ev.title;
  const me = session.book.me.toLowerCase();
  ev.attendees.filter((a) => a.name.toLowerCase() !== me).forEach((a) => session.addPerson(a.name));
  return ev;
}

export function openFolder(dir) {
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try { spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref(); return true; } catch { return false; }
}

const rosterText = (s) => (s.book.roster.length
  ? s.book.roster.map((n, i) => `${s.book.current === n ? '>' : ' '} ${i + 1}. ${n}`).join('\n')
  : 'No participants yet. Add with /add Name, Name  or load a preset / invite.');

export async function runCommand(session, line) {
  const raw = String(line ?? '').trim();
  if (!raw) return [];
  if (!raw.startsWith('/')) { const n = session.addNoteLine(raw); return n ? [] : [msg('Empty note ignored.', 'warn')]; }
  const [cmdRaw, ...parts] = raw.split(/\s+/);
  const cmd = cmdRaw.toLowerCase(); const arg = parts.join(' ').trim();

  if (isNoteCommand(cmd)) {
    const n = session.addNoteLine(raw);
    return n ? [] : [msg(`Usage: ${cmd} <text>`, 'warn')];
  }

  switch (cmd) {
    case '/help': case '/?': return [msg(HELP)];
    case '/start': try { return (await session.start()) ? [msg('Recording started.')] : [msg(`Already ${session.state}.`, 'warn')]; } catch (e) { return [msg(`Could not start: ${e.message}`, 'error')]; }
    case '/pause': return session.pause() ? [msg('Paused.')] : [msg('Not recording.', 'warn')];
    case '/resume': return session.resume() ? [msg('Resumed.')] : [msg('Not paused.', 'warn')];
    case '/stop': case '/end': {
      if (!['recording', 'paused'].includes(session.state)) return [msg('Nothing to stop.', 'warn')];
      session.stop({ summarize: !/^no/i.test(arg) }).catch((e) => session.log('error', `Stop failed: ${e.message}`));
      return [msg('Stopping...')];
    }
    case '/reconnect': return session.reconnect() ? [msg('Reconnecting to Voicegain...')] : [msg('Already connected or connecting.', 'warn')];
    case '/status': return [msg(`${session.state} | clock ${fmtClock(session.clockSec())} | Voicegain: ${session.linkState} | notes: ${session.notes.length} | queued frames: ${session.queue.length}`)];
    case '/open': return session.folder ? [msg(openFolder(session.folder.dir) ? `Opened ${session.folder.dir}` : session.folder.dir)] : [msg('Meeting has not started yet; no folder.', 'warn')];
    case '/title': if (!arg) return [msg(`Title: ${session.title || '(none; the model will suggest one)'}`)]; session.title = arg; session._writeMeta?.(); return [msg(`Title set: ${arg}`)];
    case '/me': if (!arg) return [msg(`You are "${session.book.me}"`)]; session.setMe(arg); return [msg(`You are now "${arg}"`)];
    case '/mode': if (!['call', 'room'].includes(arg)) return [msg(`Mode: ${session.book.mode}. Use /mode call (mic = you, system audio = others) or /mode room (everyone on the mic; pick speakers manually).`)]; session.setMode(arg); return [msg(`Mode: ${arg}`)];
    case '/roster': case '/who': return [msg(rosterText(session))];
    case '/add': { if (!arg) return [msg('Usage: /add Name, Name', 'warn')]; const names = arg.split(/\s*,\s*/).filter(Boolean); const added = names.filter((n) => session.addPerson(n)); return [msg(added.length ? `Added: ${added.join(', ')}` : 'Already on the roster.')]; }
    case '/rm': case '/remove': { const n = session.removePerson(arg); return [msg(n ? `Removed ${n}` : `No such participant: ${arg}`, n ? 'info' : 'warn')]; }
    case '/speaker': case '/s': { const n = session.setSpeaker(arg); return [msg(n ? `Speaker: ${n}` : `Unknown participant "${arg}". Roster:\n${rosterText(session)}`, n ? 'info' : 'warn')]; }
    case '/relabel': case '/r': { const r = session.relabelLast(arg); return [msg(r ? `Last line -> ${r.name}: "${r.text.slice(0, 60)}"` : 'No line to relabel (or unknown participant).', r ? 'info' : 'warn')]; }
    case '/name': {
      const m = /^(speaker\s*\d+|\d+)\s+(.+)$/i.exec(arg);
      if (!m) return [msg('Usage: /name Speaker 2 Priya   (renames a speaker Voicegain detected)', 'warn')];
      return [msg(session.renameLabel(m[1], m[2]) ? `${m[1]} is now ${m[2]}` : 'Could not rename.', 'info')];
    }
    case '/hint': if (!arg) return [msg('Usage: /hint Kubernetes   (boosts recognition of names/jargon; applies when a session starts or reconnects)', 'warn')]; session.hints.push(...arg.split(/\s*,\s*/)); return [msg(`Hints: ${session.hints.join(', ')}`)];
    case '/template': {
      if (!arg) return [msg(`Template: ${session.templateName}. Available: ${listTemplates().join(', ')}`)];
      try { loadTemplate(arg); session.templateName = arg; return [msg(`Summary template: ${arg}`)]; } catch (e) { return [msg(e.message, 'warn')]; }
    }
    case '/ics': {
      if (!arg) return [msg('Usage: /ics C:\\path\\invite.ics', 'warn')];
      try { const ev = applyIcs(session, fs.readFileSync(arg.replace(/^"|"$/g, ''), 'utf8')); return [msg(`Loaded "${ev.title || 'invite'}" with ${ev.attendees.length} attendees.\n${rosterText(session)}`)]; } catch (e) { return [msg(`Could not read invite: ${e.message}`, 'error')]; }
    }
    case '/preset': {
      const [sub, ...rest] = parts; const name = rest.join(' ').trim(); const store = presetStore();
      if (sub === 'list' || !sub) return [msg(store.list().length ? `Presets: ${store.list().join(', ')}` : 'No presets yet. Save one with /preset save <name>.')];
      if (!name) return [msg(`Usage: /preset ${sub} <name>`, 'warn')];
      if (sub === 'save') { store.save(name, session.book, { hints: session.hints }); return [msg(`Saved preset "${name}" (${session.book.roster.length} participants)`)]; }
      if (sub === 'load') { const p = store.load(name); if (!p) return [msg(`No preset "${name}".`, 'warn')]; applyPreset(session, p); return [msg(`Loaded preset "${name}".\n${rosterText(session)}`)]; }
      if (sub === 'rm') return [msg(store.remove(name) ? `Deleted preset "${name}"` : `No preset "${name}".`)];
      return [msg('Usage: /preset list | save <name> | load <name> | rm <name>', 'warn')];
    }
    default: return [msg(`Unknown command ${cmd}. Type /help`, 'warn')];
  }
}

export { KINDS };
