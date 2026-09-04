import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

// Локальные npm link между vimp и репозиториями игр. Релиз обязан идти на
// копиях из реестра, поэтому линки снимаются до сборки и возвращаются в
// конце — включая падение и Ctrl-C (см. release.js).

async function symlinkTarget(target) {
  try {
    const link = await lstat(target);

    if (!link.isSymbolicLink()) {
      return null;
    }

    return await realpath(target);
  } catch {
    return null;
  }
}

// Снимок состояния линков обеих сторон, до первого unlink.
export async function observeLinks(root, games) {
  const observed = [];

  for (const game of games) {
    const gameLink = await symlinkTarget(
      path.join(root, 'node_modules', game.name),
    );
    const engineLink = await symlinkTarget(
      path.join(game.dir, 'node_modules', 'vimp-engine'),
    );

    observed.push({
      name: game.name,
      dir: game.dir,
      gameLinked: gameLink !== null,
      engineLinked: engineLink !== null,
    });
  }

  return observed;
}

// Из наблюдаемого состояния — два списка шагов. Ничего не выполняется:
// шаги отдаются оркестратору, поэтому логика проверяема тестами.
//
// `npm unlink <pkg>` — алиас `npm uninstall`: он снимает не только симлинк,
// но и запись из package.json с package-lock.json, а обратно `npm link` её
// не пишет. Со стороны игры без --no-save из её package.json уезжал бы
// `vimp-engine`, а правленый lock — в релизный коммит шага B. В корне vimp
// игр в зависимостях больше нет (master-game-registry, этап 5), но флаг
// обязателен на обеих сторонах пары: разное поведение половин одной
// операции — источник сюрпризов, а не экономия.
export function buildLinkPlan(observed, { root, engineDir }) {
  const unlink = [];
  const relink = [];

  // Все игры корня — одной командой. `npm link` не сохраняет состояние
  // линков нигде: следующий вызов реифицирует дерево по package.json и
  // возвращает предыдущий пакет копией из реестра. Пара `npm link tanks`
  // + `npm link snakes` оставляла линк только на последней игре.
  const rootGames = observed
    .filter(entry => entry.gameLinked)
    .map(entry => entry.name);

  if (rootGames.length) {
    unlink.push({
      label: `unlink ${rootGames.join(', ')}`,
      cwd: root,
      command: 'npm',
      args: ['unlink', '--no-save', ...rootGames],
    });
    unlink.push({
      label: `npm install (vimp)`,
      cwd: root,
      command: 'npm',
      args: ['install', '--no-audit', '--no-fund', '--prefer-offline'],
    });
  }

  for (const entry of observed) {
    if (entry.engineLinked) {
      unlink.push({
        label: `unlink vimp-engine в ${entry.name}`,
        cwd: entry.dir,
        command: 'npm',
        args: ['unlink', '--no-save', 'vimp-engine'],
      });
      unlink.push({
        label: `npm install (${entry.name})`,
        cwd: entry.dir,
        command: 'npm',
        args: ['install', '--no-audit', '--no-fund', '--prefer-offline'],
      });
    }
  }

  // возврат: сначала регистрация пакетов в глобальном реестре ссылок,
  // потом сами связи — ровно те пары, что были сняты
  for (const entry of observed) {
    if (entry.gameLinked) {
      relink.push({
        label: `register ${entry.name}`,
        cwd: entry.dir,
        command: 'npm',
        args: ['link'],
      });
    }
  }

  // движок регистрируется один раз, сколько бы игр на него ни ссылалось
  if (observed.some(entry => entry.engineLinked)) {
    relink.push({
      label: 'register vimp-engine',
      cwd: engineDir,
      command: 'npm',
      args: ['link'],
    });
  }

  if (rootGames.length) {
    relink.push({
      label: `link ${rootGames.join(', ')} в vimp`,
      cwd: root,
      command: 'npm',
      args: ['link', ...rootGames],
    });
  }

  for (const entry of observed) {
    if (entry.engineLinked) {
      relink.push({
        label: `link vimp-engine в ${entry.name}`,
        cwd: entry.dir,
        command: 'npm',
        args: ['link', 'vimp-engine'],
      });
    }
  }

  return { unlink, relink };
}

// Проверка результата: путь либо стал обычным каталогом (после unlink),
// либо снова симлинком (после relink).
export async function isLinked(target) {
  return (await symlinkTarget(target)) !== null;
}
