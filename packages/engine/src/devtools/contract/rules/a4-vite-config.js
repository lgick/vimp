import { ERROR, skip, verdict } from '../result.js';

// vite.config.js проверяется как текст, а не импортом: конфиг —
// функция от mode и вне Vite не исполняется. Каждый пункт здесь ловит
// молчаливую поломку сборки, а не стилистику (docs/ai/02-packaging.md):
// без preserveEntrySignatures default-экспорт плагина вытряхивает
// tree-shaking, а build.lib всегда инлайнит ассеты.
const REQUIRED = [
  [/emptyOutDir\s*:\s*false/, 'emptyOutDir: false (two builds share dist/)'],
  [/assetsInlineLimit\s*:\s*0/, 'assetsInlineLimit: 0'],
  [
    /preserveEntrySignatures\s*:\s*['"]strict['"]/,
    "preserveEntrySignatures: 'strict' (or the default export is tree-shaken)",
  ],
  [/inlineDynamicImports\s*:\s*true/, 'inlineDynamicImports: true'],
  // external записывают и строкой, и регэкспом (/^pixi\.js(\/.*)?$/) —
  // проверяем только присутствие pixi в списке
  [/external\s*:\s*\[[^\]]*pixi/, "external with pixi.js"],
  [/entryFileNames[^\n]*\[hash\]/, 'entryFileNames with [hash]'],
];

export default {
  id: 'A4',
  name: 'viteConfig',
  level: ERROR,
  title: 'vite.config.js carries the required rollup options',

  check(ctx) {
    if (!ctx.viteText) {
      return skip('no vite.config.js');
    }

    const violations = REQUIRED.filter(([re]) => !re.test(ctx.viteText)).map(
      ([, what]) => `vite.config.js: missing ${what}`,
    );

    if (/\blib\s*:\s*[{'"]/.test(ctx.viteText)) {
      violations.push(
        'vite.config.js: build.lib is used — it always inlines assets',
      );
    }

    return verdict(violations);
  },
};
