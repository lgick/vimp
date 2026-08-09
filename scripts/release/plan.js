import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { capture } from './shell.js';
import { compareVersions, increment } from './semver.js';
import { parseUnreleased, suggestLevel, validateUnreleased } from './changelog.js';
import { npmVersion, crateVersion } from './registry.js';

// «Что публиковать» выводится из трёх независимых сигналов: изменённые пути
// от базовой точки, локальная версия против опубликованной и непустая
// секция [Unreleased]. Ниже — чистая таблица решений (decide) и сбор данных
// для неё из репозитория и реестров.

export const CRATE_NAME = 'vimp-engine-core';
export const ENGINE_NAME = 'vimp-engine';

// Чистая функция: только вход → набор артефактов. Покрыта plan.test.js.
export function decide(input) {
  const crate = decideArtifact(input.crate, CRATE_NAME);
  const engine = decideArtifact(input.engine, ENGINE_NAME);

  // у игры те же три сигнала, что у крейта и движка: своя неопубликованная
  // версия, свои коммиты после тега — плюс распространение сверху. Без этого
  // строка «Game only → ✅» из publishing.md была бы недостижима
  const games = (input.games ?? []).map(game => {
    const required = crate.publish || input.engineApiChanged === true;
    const ahead =
      game.published === null ||
      (game.published !== undefined &&
        compareVersions(game.version, game.published) > 0);
    const ownChanges = game.changed === true;
    const reasons = [];

    if (crate.publish) {
      reasons.push('крейт публикуется → игру нужно пересобрать');
    }
    if (input.engineApiChanged) {
      reasons.push('изменился ENGINE_API_VERSION → публикация обязательна');
    }
    if (!required && engine.publish) {
      reasons.push('движок публикуется → можно обновить и игру');
    }
    if (!required && ahead) {
      reasons.push(
        game.published === null
          ? 'ещё не публиковалась'
          : `локальная ${game.version} > опубликованной ${game.published}`,
      );
    }
    if (!required && !ahead && ownChanges) {
      reasons.push('есть коммиты после тега версии');
    }
    if (!required && !engine.publish && !ahead && !ownChanges) {
      reasons.push('изменений нет');
    }

    return {
      ...game,
      publish: required || engine.publish || ahead || ownChanges,
      // версия уже поднята руками — публикуем как есть
      bump: !ahead,
      required,
      reason: reasons.join('; '),
    };
  });

  const publishedGames = games.filter(game => game.publish);
  const releasable = [crate, engine];

  return {
    crate,
    engine,
    games,
    // журнал непубликуемого артефакта релиз не блокирует: опечатка в чужом
    // CHANGELOG не должна мешать выпустить один крейт
    problems: releasable
      .filter(artifact => artifact.publish)
      .flatMap(artifact => artifact.problems ?? []),
    // …но и не замалчивается: `## Added` вместо `### Added` сам делает секцию
    // пустой, а пустая секция при неизменённых файлах и даёт publish: false —
    // дефект спрятал бы себя, и релиз молча «не потребовался»
    warnings: releasable
      .filter(artifact => !artifact.publish)
      .flatMap(artifact => artifact.problems ?? []),
    prod: {
      push: engine.publish || publishedGames.length > 0,
      reason: engine.publish
        ? 'опубликован движок'
        : publishedGames.length > 0
          ? 'опубликованы игры → нужен перепин'
          : 'публиковать нечего',
      // при бампе ENGINE_API_VERSION движок и плагин обязаны доехать в прод
      // одним пушем — все пуши ветки собраны в шаге C
      strictlyLast: input.engineApiChanged === true,
    },
  };
}

function decideArtifact(artifact, name) {
  if (!artifact) {
    return { name, publish: false, reason: 'артефакт не рассматривался' };
  }

  const { local, published, changed, unreleased, changelogFile } = artifact;
  const ahead = published === null || compareVersions(local, published) > 0;
  // контракт заголовков проверяется и на пути «версия поднята руками»:
  // журнал всё равно датируется при публикации
  const problems = validateUnreleased(unreleased).map(problem =>
    changelogFile ? `${changelogFile}: ${problem}` : problem,
  );

  // версия уже поднята, но не опубликована — публикуем как есть, без бампа
  if (ahead) {
    return {
      name,
      publish: true,
      bump: false,
      current: local,
      target: local,
      problems,
      reason: published
        ? `локальная ${local} > опубликованной ${published}`
        : 'ещё не публиковался',
    };
  }

  const hasUnreleased = unreleased?.isEmpty === false;

  if (!changed && !hasUnreleased) {
    return {
      name,
      publish: false,
      current: local,
      problems,
      reason: `нет изменений с ${published}`,
    };
  }

  const suggestion = suggestLevel(unreleased?.sections ?? [], local);
  const signals = [];

  if (changed) {
    signals.push('изменены файлы артефакта');
  }
  if (hasUnreleased) {
    signals.push(`${suggestion.reason} в [Unreleased]`);
  }

  return {
    name,
    publish: true,
    bump: true,
    level: suggestion.level,
    current: local,
    target: increment(local, suggestion.level),
    problems,
    reason: signals.join('; '),
  };
}

async function git(root, args) {
  const { code, stdout } = await capture('git', args, {
    cwd: root,
    allowFailure: true,
  });

  return code === 0 ? stdout.trim() : null;
}

// Базовая точка сравнения: тег релиза, а пока тегов нет — коммит, в котором
// версия стала текущей (за всё время процедуры теги ни разу не ставились,
// см. docs/en/publishing.md).
export async function findBase(root, { tag, versionFile, versionNeedle }) {
  const tagged = await git(root, ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`]);

  if (tagged) {
    return { ref: tagged, source: `тег ${tag}` };
  }

  const log = await git(root, [
    'log',
    '--format=%H',
    `-S${versionNeedle}`,
    '--',
    versionFile,
  ]);

  const commit = log ? log.split('\n').filter(Boolean).at(0) : null;

  return commit
    ? { ref: commit, source: `коммит с версией в ${path.basename(versionFile)}` }
    : { ref: null, source: 'история недоступна — считаем изменённым' };
}

export async function changedSince(root, ref, paths) {
  if (!ref) {
    return true;
  }

  const output = await git(root, ['diff', '--name-only', `${ref}..HEAD`, '--', ...paths]);

  return output === null ? true : output !== '';
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readCrateVersion(root) {
  const cargo = await readFile(
    path.join(root, 'packages', 'engine', 'core', 'Cargo.toml'),
    'utf8',
  );
  const match = /^version\s*=\s*"([^"]+)"/m.exec(cargo);

  if (!match) {
    throw new Error('в packages/engine/core/Cargo.toml не найдено поле version');
  }

  return match[1];
}

export async function readEngineApiVersion(root) {
  const source = await readFile(
    path.join(root, 'packages', 'engine', 'src', 'config', 'opcodes.js'),
    'utf8',
  );
  const match = /ENGINE_API_VERSION\s*=\s*(\d+)/.exec(source);

  return match ? Number(match[1]) : null;
}

// Сбор входа для decide(): версии, изменённые пути, секции [Unreleased].
export async function collect(root) {
  const engineDir = path.join(root, 'packages', 'engine');
  const enginePkg = await readJson(path.join(engineDir, 'package.json'));
  const crateLocal = await readCrateVersion(root);

  const [enginePublished, cratePublished] = await Promise.all([
    npmVersion(ENGINE_NAME),
    crateVersion(CRATE_NAME),
  ]);

  const crateBase = await findBase(root, {
    tag: `${CRATE_NAME}@${crateLocal}`,
    versionFile: 'packages/engine/core/Cargo.toml',
    versionNeedle: `version = "${crateLocal}"`,
  });
  const engineBase = await findBase(root, {
    tag: `${ENGINE_NAME}@${enginePkg.version}`,
    versionFile: 'packages/engine/package.json',
    versionNeedle: `"version": "${enginePkg.version}"`,
  });

  const cratePaths = ['packages/engine/core'];

  // скоуп npm-пакета берётся из его же поля files, а не хардкодится —
  // без него детект движка был бы неверным, поэтому падаем внятно
  if (!Array.isArray(enginePkg.files) || enginePkg.files.length === 0) {
    throw new Error(
      'в packages/engine/package.json нет непустого поля files — по нему определяется скоуп пакета',
    );
  }

  const enginePaths = enginePkg.files.map(entry => `packages/engine/${entry}`);

  const crateChangelog = await readFile(
    path.join(engineDir, 'core', 'CHANGELOG.md'),
    'utf8',
  );
  const engineChangelog = await readFile(
    path.join(engineDir, 'CHANGELOG.md'),
    'utf8',
  );

  const opcodesTouched = await changedSince(root, engineBase.ref, [
    'packages/engine/src/config/opcodes.js',
  ]);
  const engineApiChanged = opcodesTouched
    ? await engineApiDiffers(root, engineBase.ref)
    : false;

  return {
    engineApiChanged,
    crate: {
      local: crateLocal,
      published: cratePublished,
      changed: await changedSince(root, crateBase.ref, cratePaths),
      base: crateBase,
      changelogFile: 'packages/engine/core/CHANGELOG.md',
      unreleased: parseUnreleased(crateChangelog),
    },
    engine: {
      local: enginePkg.version,
      published: enginePublished,
      changed: await changedSince(root, engineBase.ref, enginePaths),
      base: engineBase,
      changelogFile: 'packages/engine/CHANGELOG.md',
      unreleased: parseUnreleased(engineChangelog),
    },
  };
}

// Меняли opcodes.js — но интересует именно число ENGINE_API_VERSION:
// правка комментария рядом не должна объявлять игру обязательной.
async function engineApiDiffers(root, ref) {
  const current = await readEngineApiVersion(root);
  const previous = await git(root, [
    'show',
    `${ref}:packages/engine/src/config/opcodes.js`,
  ]);

  if (!previous || current === null) {
    return false;
  }

  const match = /ENGINE_API_VERSION\s*=\s*(\d+)/.exec(previous);

  return match ? Number(match[1]) !== current : false;
}
