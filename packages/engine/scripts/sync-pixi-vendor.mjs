// Собирает единый, самодостаточный ESM-вендор pixi.js для import map в
// index.html. Нужно, чтобы движок и динамически загружаемый game-plugin
// (@vimp-games/*) использовали ОДИН экземпляр pixi.js в браузере —
// иначе два независимых модульных графа означают два разных реестра
// расширений/пайпов PixiJS и падение рендера (RenderTargetSystem
// получает null render target от «чужого» рендерера).
//
// Раньше здесь копировалось дерево node_modules/pixi.js/lib/**/*.mjs —
// не работает: сам pixi.js/lib импортирует свои npm-зависимости
// (eventemitter3, tiny-lru, earcut, ismobilejs, ...) голыми
// спецификаторами, которых нет в браузерном import map → рендер вообще
// не стартует (Failed to resolve module specifier). Вместо этого
// esbuild бандлит оба входа (`pixi.js` и `pixi.js/unsafe-eval`) в
// самодостаточные ESM-файлы без внешних импортов, с `splitting: true` —
// общий код (классы рендерера и т.д.) выносится в один shared-чанк,
// поэтому `unsafe-eval` патчит ТЕ ЖЕ классы, которые использует
// основной бандл (раздельная сборка каждого входа дала бы две копии
// классов и unsafe-eval молча не подействовал бы).
//
// pixi.js в packages/engine остаётся внешней зависимостью Vite-сборки
// (vite.config.js: build.rollupOptions.external) — движок больше не
// бандлит свою копию, а резолвит `pixi.js` бегущей строкой через
// import map в файлы, собранные здесь.
import { build } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const engineDir = path.resolve(import.meta.dirname, '..');
const outdir = path.resolve(engineDir, 'public/vendor/pixi');

await rm(outdir, { recursive: true, force: true });

await build({
  // Спецификаторы резолвятся самим esbuild от `absWorkingDir` — важно
  // передать именно bare-специфкаторы, а не готовый абсолютный путь:
  // `require.resolve()`/`createRequire` следуют условию CJS `require` в
  // package.json `exports` и вернули бы `lib/index.js` (CJS-обёртку с
  // одним default-экспортом вместо именованных) — из-за чего браузер
  // падал с «does not provide an export named Application». Условие
  // `import` в `conditions` заставляет esbuild резолвить ESM-вход
  // (`lib/index.mjs` / `lib/unsafe-eval/init.mjs`) с настоящими named
  // export'ами.
  entryPoints: {
    index: 'pixi.js',
    'unsafe-eval': 'pixi.js/unsafe-eval',
  },
  absWorkingDir: engineDir,
  conditions: ['import'],
  mainFields: ['module', 'main'],
  bundle: true,
  splitting: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outdir,
  chunkNames: 'chunks/[name]-[hash]',
  logLevel: 'info',
});

// Отдельный файл вместо инлайн-<script type="importmap"> в index.html:
// прод-CSP (packages/engine/src/config/master.js) не даёт 'unsafe-inline'/
// nonce для script-src, инлайновый importmap блокировался бы браузером.
// Внешний importmap same-origin ('self') грузится штатно.
await mkdir(outdir, { recursive: true });
await writeFile(
  path.join(outdir, 'importmap.json'),
  JSON.stringify({
    imports: {
      'pixi.js': '/vendor/pixi/index.js',
      'pixi.js/unsafe-eval': '/vendor/pixi/unsafe-eval.js',
    },
  }),
);

console.log(`[sync-pixi-vendor] pixi.js (bundled, code-split) → ${path.relative(engineDir, outdir)}`);
