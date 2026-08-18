import { ERROR, skip, verdict } from '../result.js';

// Тайл-лист и картинки динамических тел везёт пакет игры (dist/img/),
// движок игровых картинок не раздаёт. Карта, назвавшая отсутствующий
// файл, падает молча в рантайме: полотно пустое, консоль чистая.
export default {
  id: 'E2',
  name: 'mapImages',
  level: ERROR,
  title: 'map images exist in dist/img/',

  check(ctx) {
    const maps = ctx.gameConfig?.maps;

    if (!ctx.distFiles) {
      return skip('not built — no dist/');
    }

    if (!maps) {
      return skip('no gameConfig.maps');
    }

    const violations = [];

    for (const [name, map] of Object.entries(maps)) {
      const images = [
        map?.spriteSheet?.img,
        ...(map?.physicsDynamic ?? []).map(body => body?.img),
      ].filter(Boolean);

      for (const img of new Set(images)) {
        if (!ctx.distFiles.has(`img/${img}`)) {
          violations.push(`map "${name}": dist/img/${img} is missing`);
        }
      }
    }

    return verdict(violations);
  },
};
