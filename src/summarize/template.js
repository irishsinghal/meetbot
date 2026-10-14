// Summary templates are plain Markdown with two kinds of placeholders:
//   {{title}} {{date}} {{time}} {{duration}} {{participants}} {{personal_notes}}   filled by MeetBot
//   {{ai:key|instruction for the model}}                                           written by the local LLM
// Put your own templates in ~/.meetbot/templates/<name>.md (or pass a file path) and select with --template.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from '../config.js';

export const SLOT_RE = /\{\{\s*ai\s*:\s*([A-Za-z0-9_-]+)\s*(?:\|([\s\S]*?))?\}\}/g;
export const BUILTINS = ['title', 'date', 'time', 'duration', 'participants', 'personal_notes'];
const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates');

export function templateDirs() { return [path.join(configDir(), 'templates'), bundled]; }

export function listTemplates() {
  const names = new Set();
  for (const d of templateDirs()) { try { fs.readdirSync(d).filter((f) => f.endsWith('.md')).forEach((f) => names.add(f.slice(0, -3))); } catch { /* none */ } }
  return [...names].sort();
}

export function loadTemplate(nameOrPath) {
  const candidates = [nameOrPath, ...templateDirs().map((d) => path.join(d, `${nameOrPath}.md`)), ...templateDirs().map((d) => path.join(d, nameOrPath))];
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return { name: path.basename(c, '.md'), text: fs.readFileSync(c, 'utf8') }; } catch { /* next */ } }
  throw new Error(`Template "${nameOrPath}" not found. Available: ${listTemplates().join(', ') || 'none'}`);
}

export function parseSlots(text) {
  const slots = []; const seen = new Set();
  for (const m of text.matchAll(SLOT_RE)) {
    if (seen.has(m[1])) continue; seen.add(m[1]);
    slots.push({ key: m[1], instruction: (m[2] || 'Write this section concisely.').trim() });
  }
  return slots;
}

export function fillTemplate(text, builtins, ai = {}) {
  let out = text.replace(SLOT_RE, (_, key) => (ai[key] ?? '_Not generated._').trim());
  out = out.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, k) => (k in builtins ? String(builtins[k]) : all));
  return out.endsWith('\n') ? out : `${out}\n`;
}
