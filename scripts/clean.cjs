const fs = require('node:fs');
const path = require('node:path');

function clean(root, { all = false, dryRun = false } = {}) {
  const removed = [];
  function remove(relative) {
    let parent = root;
    for (const segment of relative.split(path.sep).slice(0, -1)) {
      parent = path.join(parent, segment);
      if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) return;
    }
    const target = path.join(root, relative);
    if (!fs.existsSync(target) && !fs.lstatSync(target, { throwIfNoEntry: false })) return;
    removed.push(relative);
    if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
  }
  const generated = ['dist', path.join('src-tauri', 'target'), path.join('src-tauri', 'gen'), all ? 'node_modules' : path.join('node_modules', '.vite')];
  for (const target of generated) remove(target);
  function caches(relative = '') {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (['.git', 'node_modules', '.venv'].includes(entry.name)) continue;
      const child = path.join(relative, entry.name);
      if (generated.includes(child)) continue;
      if (entry.name === '__pycache__' || entry.name === '.DS_Store' || /\.py[co]$/.test(entry.name)) remove(child);
      else if (entry.isDirectory()) caches(child);
    }
  }
  caches();
  return removed;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--all', '--dry-run'].includes(arg))) {
    console.error('Usage: node scripts/clean.cjs [--all] [--dry-run]');
    process.exitCode = 1;
  } else {
    const dryRun = args.includes('--dry-run');
    const removed = clean(path.resolve(__dirname, '..'), { all: args.includes('--all'), dryRun });
    for (const target of removed) console.log(`${dryRun ? 'Would remove' : 'Removed'} ${target}`);
    console.log(removed.length ? 'Cleanup complete.' : 'No generated files to remove.');
  }
}
module.exports = { clean };
