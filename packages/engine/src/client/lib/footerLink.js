import { resolvePackageLink } from '../../lib/packageLink.js';

// Ссылка в футере лобби и формы входа. Один рендер на оба экрана: лобби
// подставляет пакет движка, форма входа — пакет игры из манифеста.
//
// Данных нет (standalone-манифест без метаданных пакета) — якорь гасится, а не
// прячется: ячейка футера остаётся пустой, и раскладка space-between не едет.

/**
 * @param {HTMLAnchorElement|null} anchor - якорь футера
 * @param {{name?: string, homepage?: string}|null} pkg - метаданные пакета
 */
export function renderPackageLink(anchor, pkg) {
  if (!anchor) {
    return;
  }

  const link = resolvePackageLink(pkg);

  if (!link) {
    anchor.textContent = '';
    anchor.removeAttribute('href');

    return;
  }

  anchor.textContent = link.label;
  anchor.href = link.url;
}
