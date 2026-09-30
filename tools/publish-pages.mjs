/**
 * tools/publish-pages.mjs — refresh docs/ with the production build.
 *
 * GitHub Pages can serve this repository straight from a branch: point
 * Settings → Pages at "main / docs" and the game is live, with no CI, no
 * secrets and no build step on anyone's machine. This script is the only thing
 * needed to update that site: it rebuilds docs/ from scratch so stale hashed
 * bundles never pile up.
 *
 * Usage:  npm run publish:pages   (runs the build, then refreshes docs/)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'docs');

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/index.html not found — run "npm run build" (or "npm run publish:pages") first.');
  process.exit(1);
}

// Clean slate: asset filenames are content-hashed, so old ones must not linger.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

function copy(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) copy(path.join(from, entry), path.join(to, entry));
  } else {
    fs.copyFileSync(from, to);
  }
}

copy(path.join(dist, 'index.html'), path.join(out, 'index.html'));
const assets = path.join(dist, 'assets');
if (fs.existsSync(assets)) copy(assets, path.join(out, 'assets'));

// Jekyll would otherwise try to process the built site.
fs.writeFileSync(path.join(out, '.nojekyll'), '');

let files = 0;
let bytes = 0;
(function walk(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const s = fs.statSync(p);
    if (s.isDirectory()) walk(p);
    else { files++; bytes += s.size; }
  }
})(out);

console.log(`✔ docs/ refreshed — ${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
console.log('  Serve it with:  Settings → Pages → Source: Deploy from a branch → main → /docs');
