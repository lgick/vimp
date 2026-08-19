#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import * as ui from './release/ui.js';
import {
  createShell,
  capture,
  npmDryRunEnv,
  CommandError,
} from './release/shell.js';
import {
  collect,
  decide,
  readEngineApiVersion,
  CRATE_NAME,
  ENGINE_NAME,
  SCAFFOLD_NAME,
} from './release/plan.js';
import {
  discoverGames,
  validateGame,
  checkGitState,
  collectGameState,
  findCratePatches,
} from './release/games.js';
import { observeLinks, buildLinkPlan } from './release/links.js';
import { ensureNpmLogin, ensureCargoLogin } from './release/auth.js';
import { npmVersion } from './release/registry.js';
import { increment, isVersion, compareVersions } from './release/semver.js';
import {
  publishCrate,
  publishEngine,
  publishScaffold,
  publishGame,
  rollOutProduction,
} from './release/steps.js';

// Одна команда вместо ~25 ручных шагов из docs/en/publishing.md: скрипт сам
// определяет, что и в какой версии публиковать, снимает и возвращает
// локальные npm link, проводит все проверки и останавливается перед пушем в
// main — единственным действием, которое деплоит прод.

class UsageError extends Error {}

const USAGE = `Использование: npm run release -- [флаги]

  --dry-run            всё показать и проверить, ничего не публиковать
  --only=<список>      подмножество шагов: crate,engine,scaffold,games,prod
  --game=<путь>        игра для неинтерактивного режима (можно повторять)
  --relink             только вернуть локальные npm link и выйти; в реестры
                       не ходит, работает без сети
  --yes                принять предложенные версии и план целиком; игры при
                       этом берутся только из --game, а пуш в main всё равно
                       спрашивается отдельно
  --help

Что скрипт решает сам:
  · какие артефакты публиковать — по изменённым путям от базовой точки
    (тег релиза либо коммит с текущей версией), по разнице локальной и
    опубликованной версии и по непустой секции [Unreleased]; у игры те же
    сигналы — своя неопубликованная версия и коммиты после тега vX.Y.Z;
    у скаффолдера сверху обязательная пересборка, когда публикуется крейт
    или движок: prepack вшивает их версии в тарбол шаблона;
  · какой инкремент предложить — по под-заголовкам [Unreleased]:
    ⚠️ Breaking → minor в 0.x (major от 1.0), Added → minor, иначе patch.
    Список заголовков закрыт, ⚠️ Breaking идёт только вместе с Migration —
    нарушение останавливает релиз в preflight (docs/en/publishing.md);
  · какие игры-плагины есть на машине — по npm link и соседним каталогам;
    каждая подтверждается отдельно.

Порядок: крейт → движок → скаффолдер → игры → прод. Проверки (eslint,
тесты, core:test, sim, E2E скаффолдера, тарбол) обязательны, флага их
пропуска нет. Локальные линки снимаются
до сборки и возвращаются при любом исходе, включая Ctrl-C.
`;

const STEPS = ['crate', 'engine', 'scaffold', 'games', 'prod'];

function parseFlags(argv) {
  let parsed;

  try {
    parsed = parseArgs({
      args: argv,
      options: {
        'dry-run': { type: 'boolean', default: false },
        only: { type: 'string' },
        game: { type: 'string', multiple: true, default: [] },
        relink: { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error.message);
  }

  const only = parsed.values.only
    ? parsed.values.only.split(',').map(value => value.trim())
    : STEPS;

  for (const step of only) {
    if (!STEPS.includes(step)) {
      throw new UsageError(`неизвестный шаг в --only: ${step}`);
    }
  }

  return { ...parsed.values, only };
}

// Всё, что не зависит от выбора игр: гоняется до опроса, чтобы не заставлять
// отвечать на десяток вопросов ради «дерево не чистое». Проблемы контракта
// заголовков приезжают сюда же — список отказа остаётся одним.
async function preflightRepo(root, { changelog }) {
  const problems = [...changelog];

  // холостой npm из окружения: публикации молча не случатся, а теги и
  // коммиты — да
  if (npmDryRunEnv()) {
    problems.push(
      'в окружении выставлен npm_config_dry_run — `npm publish` пройдёт ' +
        'вхолостую. Похоже на `npm run release --dry-run` без `--`: ' +
        'холостой прогон запускается как `npm run release -- --dry-run`',
    );
  }

  const branch = await capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: root,
    allowFailure: true,
  });

  if (branch.stdout.trim() !== 'main') {
    problems.push(`ветка ${branch.stdout.trim()}, а релиз идёт с main`);
  }

  const status = await capture('git', ['status', '--short'], { cwd: root });

  if (status.stdout.trim() !== '') {
    problems.push('рабочее дерево не чистое');
  }

  await capture('git', ['fetch'], { cwd: root, allowFailure: true });

  // симметрично проверке у игр: без upstream `git push` шага C упадёт
  // последним действием — уже после всех необратимых публикаций, а до того
  // `git log @{u}..HEAD` напечатает «нечего пушить», то есть обратное правде
  const upstream = await capture(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { cwd: root, allowFailure: true },
  );

  if (upstream.code !== 0) {
    problems.push('у main нет upstream (git push в шаге C не сработает)');
  } else {
    const behind = await capture('git', ['rev-list', '--count', 'HEAD..@{u}'], {
      cwd: root,
      allowFailure: true,
    });

    if (behind.code === 0 && Number(behind.stdout.trim()) > 0) {
      problems.push(`отставание от remote на ${behind.stdout.trim()} коммит(ов)`);
    }
  }

  // локальный [patch.crates-io] публикует ядро, собранное против крейта,
  // которого нет ни у кого больше
  problems.push(
    ...(await findCratePatches(root, [
      'Cargo.toml',
      'packages/engine/core/Cargo.toml',
    ])),
  );

  return problems;
}

// Остаток проверок, известный только после выбора игр.
async function preflightGames(games, { needsRust }) {
  const problems = [];

  // [patch.crates-io] проверяется и в каждой игре: скрипт собирает и
  // публикует их WASM-ядра тоже
  for (const game of games) {
    problems.push(
      ...(await findCratePatches(game.dir, ['Cargo.toml', 'core/Cargo.toml'])),
    );
  }

  if (needsRust) {
    for (const tool of ['rustup', 'wasm-pack']) {
      const found = await capture('which', [tool], { allowFailure: true });

      if (found.code !== 0) {
        problems.push(`${tool} не найден в PATH`);
      }
    }
  }

  return problems;
}

// Полное состояние игры: валидация файлов, git, опубликованная версия и
// собственные изменения от тега версии.
async function describeGame(dir, { registry = true } = {}) {
  const info = await validateGame(dir);

  if (!info.valid) {
    return info;
  }

  // для --relink хватает имени и пути: лезть в реестр на аварийном пути
  // значит требовать сеть ровно там, где её может не быть, а линки уже рваны
  if (!registry) {
    return { ...info, published: undefined, git: { problems: [] }, changed: false, base: null };
  }

  const published = await npmVersion(info.name);
  const git = await checkGitState(info.dir);
  const state = await collectGameState(info.dir, info.version);

  return { ...info, published, git, changed: state.changed, base: state.base };
}

// В неинтерактивном режиме (--yes) выбор игр делается только явными --game:
// молча опубликовать всё, что нашлось на машине, — не то, о чём просили.
async function selectGames(root, { yes, explicit, registry = true }) {
  const selected = [];

  for (const dir of explicit) {
    const info = await describeGame(path.resolve(dir), { registry });

    if (!info.valid) {
      throw new UsageError(`--game ${dir}: ${info.problems.join(', ')}`);
    }

    selected.push(info);
  }

  if (yes) {
    if (explicit.length === 0) {
      ui.log('--yes без --game: игры в релиз не включаются');
    }

    return selected;
  }

  const candidates = await discoverGames(root);

  for (const candidate of candidates) {
    if (selected.some(game => game.dir === candidate.dir)) {
      continue;
    }

    const info = await describeGame(candidate.dir, { registry });

    if (!info.valid) {
      ui.log(
        `пропущен ${candidate.dir}: ${info.problems.join(', ')} (${candidate.source})`,
      );
      continue;
    }

    if (registry) {
      ui.log(
        `игра ${info.name} — ${info.dir}\n` +
          `          локальная ${info.version}, в npm ${info.published ?? '—'}, ` +
          `${info.changed ? 'есть' : 'нет'} коммитов после ${info.base ?? 'тега версии (тега нет)'} ` +
          `(${candidate.source})`,
      );
    } else {
      ui.log(`игра ${info.name} — ${info.dir} (${candidate.source})`);
    }

    if (info.git.problems.length) {
      // публиковать из грязного дерева можно только осознанно: в тарбол
      // уедет то, что лежит на диске, а тег встанет на другой коммит
      ui.error(`  внимание: ${info.git.problems.join(', ')}`);
    }

    const question = registry
      ? 'Включить эту игру в релиз?'
      : 'Вернуть линки этой игре?';

    if (await ui.confirm(question, info.git.problems.length === 0)) {
      selected.push(info);
    }
  }

  const extra = await ui.ask('Путь к ещё одной игре (пусто — пропустить)', '');

  if (extra !== '') {
    const info = await describeGame(path.resolve(extra), { registry });

    if (info.valid) {
      selected.push(info);
    } else {
      ui.error(`не годится: ${info.problems.join(', ')}`);
    }
  }

  return selected;
}

async function askVersion(label, { current, level, reason, published }, { yes }) {
  const suggested = increment(current, level);

  ui.log(`${label}: ${current} → ${suggested} (${reason})`);

  const answer = yes
    ? suggested
    : await ui.ask('Enter — принять, либо patch/minor/major/своя версия', suggested);

  const target = ['patch', 'minor', 'major'].includes(answer)
    ? increment(current, answer)
    : answer;

  if (!isVersion(target)) {
    throw new UsageError(`не версия и не уровень инкремента: ${answer}`);
  }

  // опечатка в версии дошла бы до publish и упала там с 403 — уже после
  // правки файлов, коммита и тега, откатывать которые пришлось бы руками
  if (compareVersions(target, current) <= 0) {
    throw new UsageError(`${target} не больше текущей ${current}`);
  }

  if (published && compareVersions(target, published) <= 0) {
    throw new UsageError(`${target} не больше опубликованной ${published}`);
  }

  return target;
}

// Единственный формат отказа до начала работ: список причин и выход с 1.
// Возвращает true, если релиз останавливается
function reportProblems(problems) {
  if (problems.length === 0) {
    return false;
  }

  ui.error('preflight не пройден:');
  problems.forEach(problem => ui.raw(`  - ${problem}`));

  return true;
}

async function runSteps(steps, shell) {
  for (const step of steps) {
    ui.log(`  · ${step.label}`);
    await shell.write(step.command, step.args, { cwd: step.cwd });
  }
}

async function main(argv) {
  const args = parseFlags(argv);

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const root = path.resolve(import.meta.dirname, '..');
  const engineDir = path.join(root, 'packages', 'engine');
  // releaseStdin: перед командой с живым вводом readline закрывается, иначе
  // одноразовый код 2FA прочитает родитель, а не npm
  const shell = createShell({
    dryRun: args['dry-run'],
    log: ui.raw,
    releaseStdin: ui.closePrompts,
  });

  if (args['dry-run']) {
    ui.log('режим --dry-run: изменяющие команды не выполняются');
  }

  // --relink: аварийное восстановление после SIGKILL, когда обработчики
  // возврата линков не отработали
  if (args.relink) {
    const games = await selectGames(root, {
      yes: args.yes,
      explicit: args.game,
      registry: false,
    });
    const plan = buildLinkPlan(
      games.map(game => ({ ...game, gameLinked: true, engineLinked: true })),
      { root, engineDir },
    );

    await runSteps(plan.relink, shell);
    ui.log('линки восстановлены');
    return 0;
  }

  ui.log('сбор состояния репозитория и реестров…');

  const collected = await collect(root);
  const scoped = {
    crate: args.only.includes('crate') ? collected.crate : null,
    engine: args.only.includes('engine') ? collected.engine : null,
    scaffold: args.only.includes('scaffold') ? collected.scaffold : null,
    engineApiChanged: collected.engineApiChanged,
  };

  // Решение по крейту и движку от игр не зависит, а вопросов про игры бывает
  // с десяток: сперва всё, что можно проверить без них. decide() чистая,
  // второй вызов ниже ничего не стоит
  const artifacts = decide({ ...scoped, games: [] });

  // дефект журнала артефакта, который решено не публиковать: не блокирует, но
  // вполне может быть причиной самого решения. Форма как у reportProblems —
  // шапка и пункты, а не длинный хвост в каждой строке
  if (artifacts.warnings.length > 0) {
    ui.error('журнал артефакта, который не публикуется — возможно, поэтому и не публикуется:');
    artifacts.warnings.forEach(problem => ui.raw(`  - ${problem}`));
  }

  // нарушения контракта заголовков [Unreleased] собраны в decide(), который
  // под тестами. Контракт описан в docs/en/publishing.md
  const repoProblems = await preflightRepo(root, { changelog: artifacts.problems });

  if (reportProblems(repoProblems)) {
    return 1;
  }

  const games = args.only.includes('games')
    ? await selectGames(root, { yes: args.yes, explicit: args.game })
    : [];

  const decision = decide({ ...scoped, games });
  const publishedGames = decision.games.filter(game => game.publish);

  const gameProblems = await preflightGames(publishedGames, {
    // скаффолдеру rust нужен не меньше: его E2E разворачивает шаблон и
    // собирает ядро сгенерированной игры
    needsRust:
      decision.crate.publish ||
      decision.scaffold.publish ||
      publishedGames.length > 0,
  });

  if (reportProblems(gameProblems)) {
    return 1;
  }

  // версии
  if (decision.crate.publish && decision.crate.bump) {
    decision.crate.target = await askVersion(
      CRATE_NAME,
      { ...decision.crate, published: collected.crate.published },
      args,
    );
  }

  if (decision.engine.publish && decision.engine.bump) {
    decision.engine.target = await askVersion(
      ENGINE_NAME,
      { ...decision.engine, published: collected.engine.published },
      args,
    );
  }

  if (decision.scaffold.publish && decision.scaffold.bump) {
    decision.scaffold.target = await askVersion(
      SCAFFOLD_NAME,
      { ...decision.scaffold, published: collected.scaffold.published },
      args,
    );
  }

  const selectedGames = decision.games.filter(game => game.publish);

  for (const game of selectedGames) {
    // версия уже поднята руками — публикуем как есть, вопроса нет
    if (game.bump === false) {
      game.target = game.version;
      ui.log(`${game.name}: публикуется как есть, ${game.version}`);
      continue;
    }

    // уровень и причина посчитаны в decide() — единственном месте, где
    // сигналы игры сводятся вместе; у игр CHANGELOG нет, и версия всегда
    // подтверждается руками
    game.target = await askVersion(
      game.name,
      {
        current: game.version,
        level: game.level,
        published: game.published,
        reason: game.reason,
      },
      args,
    );
  }

  ui.table(
    ['артефакт', 'публикуем', 'версия', 'почему'],
    [
      [
        CRATE_NAME,
        decision.crate.publish ? 'да' : 'нет',
        decision.crate.target ?? decision.crate.current ?? '—',
        decision.crate.reason,
      ],
      [
        ENGINE_NAME,
        decision.engine.publish ? 'да' : 'нет',
        decision.engine.target ?? decision.engine.current ?? '—',
        decision.engine.reason,
      ],
      [
        SCAFFOLD_NAME,
        decision.scaffold.publish
          ? decision.scaffold.required
            ? 'да (обязательно)'
            : 'да'
          : 'нет',
        decision.scaffold.target ?? decision.scaffold.current ?? '—',
        decision.scaffold.reason,
      ],
      ...decision.games.map(game => [
        game.name,
        game.publish ? (game.required ? 'да (обязательно)' : 'да') : 'нет',
        game.target ?? game.version,
        game.reason,
      ]),
      [
        'прод (push в main)',
        decision.prod.push && args.only.includes('prod') ? 'да' : 'нет',
        '—',
        decision.prod.reason,
      ],
    ],
  );

  if (
    !decision.crate.publish &&
    !decision.engine.publish &&
    !decision.scaffold.publish &&
    !selectedGames.length
  ) {
    ui.log('публиковать нечего');
    return 0;
  }

  if (!args.yes && !(await ui.confirm('Выполняем этот план?', false))) {
    ui.log('отменено');
    return 0;
  }

  // логины — только для реестров, куда реально пойдёт публикация
  if (decision.engine.publish || decision.scaffold.publish || selectedGames.length) {
    if (!(await ensureNpmLogin())) {
      return 1;
    }
  }

  if (decision.crate.publish && !(await ensureCargoLogin(CRATE_NAME))) {
    return 1;
  }

  const report = { published: [], tags: [], pushed: false, remaining: [] };

  // состояние линков снимается ДО первого unlink; возврат гарантируется
  // finally и обработчиками сигналов
  const observed = await observeLinks(root, decision.games);
  const linkPlan = buildLinkPlan(observed, { root, engineDir });
  let restored = false;

  const restore = async () => {
    if (restored || linkPlan.relink.length === 0) {
      return;
    }

    restored = true;
    ui.log('возврат локальных линков…');
    await runSteps(linkPlan.relink, shell);
  };

  const onSignal = () => {
    restore().finally(() => process.exit(130));
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    if (linkPlan.unlink.length) {
      ui.log('снятие локальных линков…');
      await runSteps(linkPlan.unlink, shell);
    }

    if (decision.crate.publish) {
      await publishCrate({ shell, root, decision: decision.crate, report });
    }

    if (decision.engine.publish) {
      await publishEngine({
        shell,
        root,
        decision: decision.engine,
        games: decision.games,
        report,
      });
    }

    // строго после A1/A2: prepack снимает пины с локальных файлов движка,
    // которые эти шаги только что подняли
    if (decision.scaffold.publish) {
      await publishScaffold({
        shell,
        root,
        decision: decision.scaffold,
        report,
      });
    }

    const engineApi = await readEngineApiVersion(root);

    for (const game of selectedGames) {
      await publishGame({
        shell,
        game,
        // не «что публикуется в этом прогоне», а что реально лежит в
        // реестрах: после прерванного прогона крейт уже опубликован, и игра
        // собралась бы на старом ядре со старым пином в тарболе
        crateVersion: decision.crateVersion,
        engineVersion: decision.engineVersion,
        engineApi,
        report,
      });
    }

    if (args.only.includes('prod') && decision.prod.push) {
      await rollOutProduction({
        shell,
        root,
        games: selectedGames,
        report,
        // из vimp пушатся только его собственные теги: теги игр уже уехали
        // вместе с `git push --tags` в их репозиториях
        tags: report.tags
          .filter(entry => entry.repo === root)
          .map(entry => entry.name),
      });
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await restore();
  }

  ui.log('готово.');
  ui.raw(`  опубликовано: ${report.published.join(', ') || '—'}`);
  const tags = report.tags
    .map(entry => `${path.basename(entry.repo)}/${entry.name}`)
    .join(', ');

  ui.raw(`  теги:         ${tags || '—'}`);
  ui.raw(`  прод:         ${report.pushed ? 'запушен' : 'не пушился'}`);

  if (report.remaining.length) {
    ui.raw(`  осталось:     ${report.remaining.join('; ')}`);
  }

  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    ui.error(error.message);
    process.stdout.write(`\n${USAGE}`);
    process.exitCode = 1;
  } else if (error instanceof CommandError) {
    ui.error('шаг упал, публикация не выполнена:');
    process.stderr.write(`${error.format()}\n`);
    process.exitCode = 1;
  } else {
    ui.error(error.message);
    process.exitCode = 1;
  }
} finally {
  ui.closePrompts();
}
