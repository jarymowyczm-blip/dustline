/**
 * tools/bundle-single.mjs — pack the production build into ONE .html file.
 *
 * Useful for hosting on itch.io, emailing a build, or opening straight from
 * disk without a web server. The JS is base64-embedded and imported from a blob
 * URL, which avoids the HTML parser choking on raw `<` characters inside a
 * minified bundle.
 *
 * Usage:  npm run build:single   →  dist/dustline-single.html
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const htmlPath = path.join(dist, 'index.html');
const assetsDir = path.join(dist, 'assets');

if (!fs.existsSync(htmlPath)) {
  console.error('dist/index.html not found — run "npm run build" first.');
  process.exit(1);
}

const jsFile = fs.readdirSync(assetsDir).find((f) => f.endsWith('.js'));
if (!jsFile) {
  console.error('No JS asset found in dist/assets.');
  process.exit(1);
}

const js = fs.readFileSync(path.join(assetsDir, jsFile));
const b64 = js.toString('base64');

const loader =
  '<script type="module">' +
  `const raw = atob(${JSON.stringify(b64)});` +
  'const bytes = new Uint8Array(raw.length);' +
  'for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);' +
  'const url = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));' +
  'await import(url);' +
  '</script>';

const html = fs
  .readFileSync(htmlPath, 'utf8')
  .replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/, () => loader);

const out = path.join(dist, 'dustline-single.html');
fs.writeFileSync(out, html);
console.log(`✔ ${path.relative(root, out)} — ${(fs.statSync(out).size / 1048576).toFixed(2)} MB (self-contained)`);
