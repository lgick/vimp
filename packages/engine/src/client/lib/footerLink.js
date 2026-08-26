import { projectLink } from '../../lib/packageLink.js';

// Ссылка в футере лобби и формы входа. Один рендер на оба экрана: лобби
// подставляет адрес проекта движка, форма входа — адрес игры из манифеста.
//
// Адреса нет (пакет не объявил repository/homepage) — якорь гасится, а не
// прячется: ячейка футера остаётся пустой, и раскладка space-between не едет.

/**
 * @param {HTMLAnchorElement|null} anchor - якорь футера
 * @param {string|null} url - адрес проекта (resolveProjectUrl)
 */
export function renderProjectLink(anchor, url) {
  if (!anchor) {
    return;
  }

  const link = projectLink(url);

  if (!link) {
    anchor.textContent = '';
    anchor.removeAttribute('href');

    return;
  }

  anchor.textContent = link.label;
  anchor.href = link.url;
}
