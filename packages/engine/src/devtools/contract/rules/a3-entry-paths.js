import { ERROR, skip, verdict } from '../result.js';

// Пути точек входа захардкожены в dev-режиме мастера
// (GameCatalog._toDevManifest отдаёт браузеру /@fs/<пакет>/src/client/index.js).
// Игра, разложившая половины иначе, собирается и публикуется нормально, а в
// dev-режиме просто не грузится.
export default {
  id: 'A3',
  name: 'entryPaths',
  level: ERROR,
  title: 'entries live at src/client/index.js and src/host/index.js',

  check(ctx) {
    if (!ctx.pkg) {
      return skip('no package.json');
    }

    const violations = [];

    if (!ctx.hostEntryExists) {
      violations.push('src/host/index.js is missing — dev mode hardcodes it');
    }

    if (!ctx.clientEntryExists) {
      violations.push('src/client/index.js is missing — dev mode hardcodes it');
    }

    return verdict(violations);
  },
};
