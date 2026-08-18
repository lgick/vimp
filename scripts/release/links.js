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
// не пишет. Без --no-save релиз уносил из корня `@vimp-games/tanks`, и в
// коммит шага уезжал lock без плагина — прод ставит его именно оттуда
// (`npm ci`). Флаг обязателен на обеих сторонах пары.
export function buildLinkPlan(observed, { root, engineDir }) {
  const unlink = [];
  const relink = [];

  for (const entry of observed) {
    if (entry.gameLinked) {
      unlink.push({
        label: `unlink ${entry.name}`,
        cwd: root,
        command: 'npm',
        args: ['unlink', '--no-save', entry.name],
      });
      unlink.push({
        label: `npm install (vimp)`,
        cwd: root,
        command: 'npm',
        args: ['install'],
      });
    }

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
        args: ['install'],
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

    if (entry.engineLinked) {
      relink.push({
        label: 'register vimp-engine',
        cwd: engineDir,
        command: 'npm',
        args: ['link'],
      });
    }
  }

  for (const entry of observed) {
    if (entry.gameLinked) {
      relink.push({
        label: `link ${entry.name} в vimp`,
        cwd: root,
        command: 'npm',
        args: ['link', entry.name],
      });
    }

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
