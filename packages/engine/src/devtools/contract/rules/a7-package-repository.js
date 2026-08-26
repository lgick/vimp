import { WARN, skip, verdict } from '../result.js';
import { resolveProjectUrl } from '../../../lib/packageLink.js';

// Игра без объявленного репозитория собирается и играется — это не отказ.
// Но движок показывает ссылку на проект в футере формы входа, и берёт он её
// только отсюда (фолбэка нет, см. lib/packageLink.js): без поля ячейка
// футера у игроков останется пустой, а заметить это без подсказки негде.
// Отсюда warn — под --strict он становится ошибкой.
export default {
  id: 'A7',
  name: 'packageRepository',
  level: WARN,
  title: 'package.json declares repository (the #auth footer links to it)',

  check(ctx) {
    if (!ctx.pkg) {
      return skip('no package.json');
    }

    if (resolveProjectUrl(ctx.pkg)) {
      return verdict([]);
    }

    return verdict([
      'neither "repository" nor "homepage" resolves to a project URL — ' +
        "the game's entry form will show no project link",
    ]);
  },
};
