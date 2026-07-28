// index.html содержит инлайновый <script type="importmap">, разрешённый
// прод-CSP по sha256-хэшу (src="..." для importmap не поддерживается ни
// одним браузером — инлайн обязателен, см. index.html и
// src/config/master.js). vite build минифицирует HTML и может
// переформатировать байты этого скрипта, из-за чего фактический хэш
// dist/index.html разойдётся с тем, что зашит в CSP — тихо ломая прод.
// Этот скрипт (postbuild) считает хэш по факту собранного файла и падает
// при расхождении, печатая актуальное значение для master.js/Nginx-доков.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import masterConfig from '../src/config/master.js';

const engineDir = path.resolve(import.meta.dirname, '..');
const distIndexPath = path.join(engineDir, 'dist', 'index.html');

const html = await readFile(distIndexPath, 'utf8');

const importmapTags = html.match(/<script\s+type="importmap"/g) ?? [];
const hasSrcAttribute = /<script\s+type="importmap"[^>]*\ssrc=/.test(html);

if (importmapTags.length !== 1 || hasSrcAttribute) {
  console.error(
    `[check-importmap-csp-hash] expected exactly one <script type="importmap"> tag with no src attribute in ` +
      `dist/index.html, found ${importmapTags.length}${hasSrcAttribute ? ' (including one with src=)' : ''}. ` +
      'A stray/broken importmap tag leaked into the built markup — likely a literal tag written inside an ' +
      'HTML comment in index.html that vite build parsed as real markup.',
  );
  process.exit(1);
}

const match = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);

if (!match) {
  console.error(
    '[check-importmap-csp-hash] regex /<script type="importmap">([\\s\\S]*?)<\\/script>/ found no match in ' +
      "dist/index.html — this doesn't mean the tag is missing, it means the built markup's exact " +
      'attribute quoting/ordering/whitespace no longer matches what this script expects (e.g. after a ' +
      'Vite HTML-minifier upgrade). Update the regex above to match the new dist output, then re-run.',
  );
  process.exit(1);
}

const hash = `sha256-${createHash('sha256').update(match[1], 'utf8').digest('base64')}`;
const csp = masterConfig.security.csp('');

if (!csp.includes(hash)) {
  console.error(
    `[check-importmap-csp-hash] script-src in security.csp (packages/engine/src/config/master.js) is missing the current importmap hash.\n` +
      `Expected: '${hash}'\n` +
      `Add it to script-src there and to the Nginx CSP snippets in docs/en/deployment.md and docs/ru/deployment.md.`,
  );
  process.exit(1);
}

console.log(`[check-importmap-csp-hash] importmap hash matches CSP (${hash})`);
