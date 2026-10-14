// `meetbot layout`: choose how meeting folders are organised and (optionally) move the existing ones to match.
import path from 'node:path';
import { LAYOUTS, applyMigration, planMigration } from './storage.js';
import { saveConfig } from './setup.js';

/** ask/confirm are prompt helpers; the defaults behave non-interactively (keep current layout, don't move anything). */
export async function reconfigureLayout(cfg, flags = {}, io = {}) {
  const out = io.out || ((s) => console.log(s));
  const ask = io.ask || (async (_q, def) => def);
  const confirm = io.confirm || (async () => false);
  const names = Object.keys(LAYOUTS);

  let layout = flags.layout;
  if (!layout) {
    out(`Current layout: ${cfg.folderLayout}   (output folder: ${cfg.outputDir})`);
    for (const n of names) out(`  ${n.padEnd(7)} ${LAYOUTS[n].example}`);
    layout = await ask(`Layout (${names.join(' | ')})`, cfg.folderLayout);
  }
  if (!LAYOUTS[layout]) throw new Error(`Unknown layout "${layout}". Choose: ${names.join(', ')}`);

  if (layout !== cfg.folderLayout) {
    out(`Saved ${saveConfig({ folderLayout: layout }, io.dir)}`);
    cfg.folderLayout = layout;
  } else out(`Layout stays "${layout}".`);

  // Offer to move meetings that are not in the chosen layout (this also covers re-running after a manual change).
  const moves = planMigration(cfg.outputDir, layout);
  if (!moves.length) { out('All existing meetings already match this layout.'); return { layout, moved: 0 }; }
  const rel = (p) => path.relative(cfg.outputDir, p);
  out(`\n${moves.length} existing meeting${moves.length === 1 ? '' : 's'} would move:`);
  for (const m of moves.slice(0, 8)) out(`  ${rel(m.from)}  ->  ${rel(m.to)}`);
  if (moves.length > 8) out(`  ... and ${moves.length - 8} more`);
  const go = flags.migrate === true || (flags.migrate !== false && await confirm('Move them now?'));
  if (!go) { out('Left as is. Run "meetbot layout --migrate" any time to move them.'); return { layout, moved: 0 }; }
  const r = applyMigration(cfg.outputDir, moves);
  out(`Moved ${r.moved} meeting${r.moved === 1 ? '' : 's'}.`);
  for (const f of r.failed) out(`  FAILED ${rel(f.from)}: ${f.error}  (close anything using that folder, e.g. Explorer or OneDrive, and re-run)`);
  return { layout, moved: r.moved, failed: r.failed };
}
