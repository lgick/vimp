// Копирует ESM-сборку pixi.js (node_modules/pixi.js/lib/**/*.mjs) в
// public/vendor/pixi/lib/, откуда её по стабильному URL резолвит
// import map в index.html (см. `<script type="importmap">`). Нужно,
// чтобы движок и динамически загружаемый game-plugin (@vimp-games/*)
// использовали ОДИН экземпляр pixi.js в браузере — иначе два
// независимых модульных графа означают два разных реестра
// расширений/пайпов PixiJS и падение рендера (RenderTargetSystem
// получает null render target от «чужого» рендерера).
//
// pixi.js в packages/engine остаётся внешней зависимостью сборки
// (vite.config.js: build.rollupOptions.external) — движок больше не
// бандлит свою копию, а резолвит `pixi.js` бегущей строкой через
// import map в тот же файл, что и здесь скопирован.
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const engineDir = path.resolve(import.meta.dirname, '..');
const srcDir = path.resolve(engineDir, '../../node_modules/pixi.js/lib');
const destDir = path.resolve(engineDir, 'public/vendor/pixi/lib');

async function copyMjsTree(from, to) {
  await mkdir(to, { recursive: true });

  const entries = await readdir(from, { withFileTypes: true });

  for (const entry of entries) {
    const fromPath = path.join(from, entry.name);
    const toPath = path.join(to, entry.name);

    if (entry.isDirectory()) {
      await copyMjsTree(fromPath, toPath);
    } else if (entry.name.endsWith('.mjs')) {
      await cp(fromPath, toPath);
    }
  }
}

await rm(destDir, { recursive: true, force: true });
await copyMjsTree(srcDir, destDir);

console.log(`[sync-pixi-vendor] pixi.js/lib (*.mjs) → ${path.relative(engineDir, destDir)}`);
