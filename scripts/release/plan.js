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
export const SCAFFOLD_NAME = 'create-vimp-game';

// Чистая функция: только вход → набор артефактов. Покрыта plan.test.js.
export function decide(input) {
  const crate = decideArtifact(input.crate, CRATE_NAME);
  const engine = decideArtifact(input.engine, ENGINE_NAME);

  // Скаффолдер вшивает в тарбол снимок версий движка и крейта (хук prepack,
  // packages/create-vimp-game/scripts/write-versions.js). Отставший снимок —
  // тихая поломка: `npm create vimp-game` сгенерирует игру на старых пинах,
  // и всплывёт это только на сборке её ядра. Поэтому у него, как у игры,
  // есть обязательная пересборка сверху.
  const scaffoldReasons = [];

  if (crate.publish) {
    scaffoldReasons.push('крейт публикуется → пины шаблона устареют');
  }

  if (engine.publish) {
    scaffoldReasons.push('движок публикуется → пины шаблона устареют');
  }

  // прерванный прогон: движок уже опубликован, скаффолдер за ним не поехал —
  // publish у движка уже false, и без этого сигнала снимок остался бы старым
  if (!crate.publish && !engine.publish && input.scaffold?.pinsStale) {
    scaffoldReasons.push('пины шаблона отстали от движка в репозитории');
  }

  const scaffold = decideArtifact(input.scaffold, SCAFFOLD_NAME, {
    required: crate.publish || engine.publish || input.scaffold?.pinsStale === true,
    reasons: scaffoldReasons,
  });

  // Версии, на которых игра будет собрана: свежие, если артефакт публикуется
  // в этом прогоне, иначе те, что уже лежат в реестре. Брать локальные нельзя
  // — `cargo update --precise` и `npm i -D` ходят в реестр, а «publish в этом
  // прогоне» само по себе непригодно: после прерванного прогона крейт уже
  // опубликован, publish у него false, и игра собралась бы на старом ядре
  const crateVersion = crate.publish
    ? crate.target
    : (input.crate?.published ?? null);
  const engineVersion = engine.publish
    ? engine.target
    : (input.engine?.published ?? null);

  // у игры те же три сигнала, что у крейта и движка: своя неопубликованная
  // версия, свои коммиты после тега — плюс распространение сверху. Без этого
  // строка «Game only → ✅» из publishing.md была бы недостижима
  const games = (input.games ?? []).map(game => {
    // пин, отставший от крейта в реестре, означает, что опубликованная игра
    // собрана на старом ядре: пересборка обязательна так же, как при бампе
    const coreStale =
      crateVersion !== null &&
      typeof game.corePin === 'string' &&
      game.corePin !== crateVersion;
    const required = crate.publish || input.engineApiChanged === true || coreStale;
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
    // при bump крейта причина уже названа выше — здесь остаётся случай, когда
    // крейт опубликован раньше, а игра за ним не поехала
    if (coreStale && !crate.publish) {
      reasons.push(
        `ядро игры на ${game.corePin}, в реестре ${crateVersion} → пересборка`,
      );
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
      // у игр CHANGELOG нет, уровень выводить не из чего: обязательная
      // пересборка — minor, всё остальное — patch. Всегда подтверждается
      level: required ? 'minor' : 'patch',
      reason: reasons.join('; '),
    };
  });

  const publishedGames = games.filter(game => game.publish);
  const releasable = [crate, engine, scaffold];

  return {
    crate,
    engine,
    scaffold,
    games,
    // против чего собирается игра — считается здесь, чтобы шаг B и причина в
    // плане не разошлись
    crateVersion,
    engineVersion,
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
      // игры едут в прод через реестр auth-сервиса, а не через образ
      // (master-game-registry, этап 5): публикация игры не меняет в этом
      // репозитории ни файла, и пуш в main был бы деплоем без изменений.
      // Движок и крейт — меняют: их бамп коммитится и тегается здесь же,
      // и без пуша релиз остался бы наполовину локальным
      // Прерванный прогон — третий случай: крейт и движок опубликованы
      // прошлым запуском, их бампы закоммичены и затегированы, publish у
      // обоих уже false — и без этого сигнала повторный прогон оставил бы
      // релиз наполовину локальным ровно так же, как отменённый пуш
      push: engine.publish || crate.publish || input.unpushed === true,
      // …но выпущенную игру всё равно надо прогнать против текущего движка:
      // проверка нужна и тогда, когда пушить нечего
      verifyGames: publishedGames.length > 0,
      reason: engine.publish
        ? 'опубликован движок'
        : crate.publish
          ? 'опубликован крейт'
          : input.unpushed === true
            ? 'релизные коммиты этого репозитория не уехали в main'
            : publishedGames.length > 0
              ? 'игры едут через реестр — деплой не нужен, только проверка sim'
              : 'публиковать нечего',
      // при бампе ENGINE_API_VERSION движок и плагин обязаны доехать в прод
      // одним пушем — все пуши ветки собраны в шаге C
      strictlyLast: input.engineApiChanged === true,
    },
  };
}

// Состояние репозитория движка: что отказ, а что замечание. Обязательным
// оно является только для шагов, которые в vimp коммитят, тегают и пушат —
// крейта, движка, скаффолдера и деплоя. Релиз одной игры здесь не меняет ни
// файла: игра собирается против копий движка ИЗ РЕЕСТРА, а до игроков едет
// через реестр auth-сервиса, а не через образ (master-game-registry). Гнать
// разработчика чистить чужое дерево ради чужого артефакта — требование без
// причины.
//
// facts: {npmDryRun, branch, dirty, upstream, behind, cratePatches[],
// changelog[]}
export function repoProblems(facts, { writesRepo = true } = {}) {
  const problems = [...(facts.changelog ?? [])];
  const notes = [];
  // холостой npm из окружения: публикации молча не случатся, а теги и
  // коммиты — да. К состоянию дерева отношения не имеет, поэтому жёсткий
  // всегда
  if (facts.npmDryRun) {
    problems.push(
      'в окружении выставлен npm_config_dry_run — `npm publish` пройдёт ' +
        'вхолостую. Похоже на `npm run release --dry-run` без `--`: ' +
        'холостой прогон запускается как `npm run release -- --dry-run`',
    );
  }

  const gate = writesRepo ? problems : notes;

  if (facts.branch !== 'main') {
    gate.push(`ветка ${facts.branch}, а релиз идёт с main`);
  }

  if (facts.dirty) {
    gate.push('рабочее дерево не чистое');
  }

  // симметрично проверке у игр: без upstream `git push` шага C упадёт
  // последним действием — уже после всех необратимых публикаций, а до того
  // `git log @{u}..HEAD` напечатает «нечего пушить», то есть обратное правде
  if (!facts.upstream) {
    gate.push('у main нет upstream (git push в шаге C не сработает)');
  } else if (facts.behind > 0) {
    gate.push(`отставание от remote на ${facts.behind} коммит(ов)`);
  }

  // локальный [patch.crates-io] публикует ядро, собранное против крейта,
  // которого нет ни у кого больше. Жёсткий всегда: игра собирается своим
  // Cargo, но `npm run sim` шага прода поднимает ядро ЭТОГО дерева
  problems.push(...(facts.cratePatches ?? []));

  if (notes.length) {
    notes.push(
      'ни один артефакт этого репозитория не публикуется, поэтому релиз идёт. ' +
        'Но учтите: игра собирается против копий движка из реестра, а sim ' +
        'шага прода гоняет её движком из этого дерева',
    );
  }

  return { problems, notes };
}

// extra.required — сигнал «пересборка обязательна» извне журнала и диффа
// (сейчас только у скаффолдера: его пины зависят от чужих версий). Уровень
// он не поднимает: пустая секция [Unreleased] по-прежнему значит patch,
// перепин чужой версии новой фичей не является.
function decideArtifact(artifact, name, extra = {}) {
  const required = extra.required === true;
  const extraReasons = extra.reasons ?? [];

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
      required,
      current: local,
      target: local,
      problems,
      reason: [
        ...extraReasons,
        published
          ? `локальная ${local} > опубликованной ${published}`
          : 'ещё не публиковался',
      ].join('; '),
    };
  }

  const hasUnreleased = unreleased?.isEmpty === false;

  if (!changed && !hasUnreleased && !required) {
    return {
      name,
      publish: false,
      required,
      current: local,
      problems,
      reason: `нет изменений с ${published}`,
    };
  }

  const suggestion = suggestLevel(unreleased?.sections ?? [], local);
  const signals = [...extraReasons];

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
    required,
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
  const scaffoldDir = path.join(root, 'packages', 'create-vimp-game');
  const enginePkg = await readJson(path.join(engineDir, 'package.json'));
  const scaffoldPkg = await readJson(path.join(scaffoldDir, 'package.json'));
  const crateLocal = await readCrateVersion(root);

  const [enginePublished, cratePublished, scaffoldPublished] = await Promise.all([
    npmVersion(ENGINE_NAME),
    crateVersion(CRATE_NAME),
    npmVersion(SCAFFOLD_NAME),
  ]);

  const [crateBase, engineBase, scaffoldBase] = await Promise.all([
    findBase(root, {
      tag: `${CRATE_NAME}@${crateLocal}`,
      versionFile: 'packages/engine/core/Cargo.toml',
      versionNeedle: `version = "${crateLocal}"`,
    }),
    findBase(root, {
      tag: `${ENGINE_NAME}@${enginePkg.version}`,
      versionFile: 'packages/engine/package.json',
      versionNeedle: `"version": "${enginePkg.version}"`,
    }),
    findBase(root, {
      tag: `${SCAFFOLD_NAME}@${scaffoldPkg.version}`,
      versionFile: 'packages/create-vimp-game/package.json',
      versionNeedle: `"version": "${scaffoldPkg.version}"`,
    }),
  ]);

  const cratePaths = ['packages/engine/core'];

  // скоуп npm-пакета берётся из его же поля files, а не хардкодится —
  // без него детект движка был бы неверным, поэтому падаем внятно
  if (!Array.isArray(enginePkg.files) || enginePkg.files.length === 0) {
    throw new Error(
      'в packages/engine/package.json нет непустого поля files — по нему определяется скоуп пакета',
    );
  }

  const enginePaths = enginePkg.files.map(entry => `packages/engine/${entry}`);

  if (!Array.isArray(scaffoldPkg.files) || scaffoldPkg.files.length === 0) {
    throw new Error(
      'в packages/create-vimp-game/package.json нет непустого поля files — по нему определяется скоуп пакета',
    );
  }

  // scripts/ в files не входит, но write-versions.js пишет файл, который
  // уезжает в тарбол: правка хука меняет опубликованное содержимое
  const scaffoldPaths = [
    ...scaffoldPkg.files.map(entry => `packages/create-vimp-game/${entry}`),
    'packages/create-vimp-game/scripts',
  ];

  const crateChangelog = await readFile(
    path.join(engineDir, 'core', 'CHANGELOG.md'),
    'utf8',
  );
  const engineChangelog = await readFile(
    path.join(engineDir, 'CHANGELOG.md'),
    'utf8',
  );
  const scaffoldChangelog = await readFile(
    path.join(scaffoldDir, 'CHANGELOG.md'),
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
    unpushed: await hasUnpushedCommits(root),
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
    scaffold: {
      local: scaffoldPkg.version,
      published: scaffoldPublished,
      changed: await changedSince(root, scaffoldBase.ref, scaffoldPaths),
      base: scaffoldBase,
      changelogFile: 'packages/create-vimp-game/CHANGELOG.md',
      unreleased: parseUnreleased(scaffoldChangelog),
      pinsStale: await pinsStaleSince(root, scaffoldBase.ref, {
        engine: enginePkg.version,
        crate: crateLocal,
      }),
    },
  };
}

// Незапушенные коммиты main. Свои коммиты релиз ставит только на бампе
// крейта, движка или скаффолдера, поэтому непустой `@{u}..HEAD` в этом
// репозитории и означает «релиз не доехал до прода». Без upstream ветки
// сигнала нет — этот случай ловит preflightRepo.
async function hasUnpushedCommits(root) {
  const count = await git(root, ['rev-list', '--count', '@{u}..HEAD']);

  return count !== null && Number(count) > 0;
}

// Пины, которые prepack-хук вшивает в тарбол скаффолдера, живут в чужих
// файлах: у самого пакета от их бампа не меняется ни строки, и трёх обычных
// сигналов не хватает. Сравниваем версии на базовой точке скаффолдера с
// текущими — разошлись, значит опубликованный снимок устарел.
async function pinsStaleSince(root, ref, current) {
  if (!ref) {
    return false;
  }

  const [enginePkg, cargo] = await Promise.all([
    git(root, ['show', `${ref}:packages/engine/package.json`]),
    git(root, ['show', `${ref}:packages/engine/core/Cargo.toml`]),
  ]);

  if (!enginePkg || !cargo) {
    return false;
  }

  const engineMatch = /"version"\s*:\s*"([^"]+)"/.exec(enginePkg);
  const crateMatch = /^version\s*=\s*"([^"]+)"/m.exec(cargo);

  return (
    (engineMatch !== null && engineMatch[1] !== current.engine) ||
    (crateMatch !== null && crateMatch[1] !== current.crate)
  );
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
