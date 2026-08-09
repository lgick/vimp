#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import * as ui from './release/ui.js';
import { createShell, capture, CommandError } from './release/shell.js';
import { collect, decide, readEngineApiVersion, CRATE_NAME } from './release/plan.js';
import { discoverGames, validateGame, checkGitState } from './release/games.js';
import { observeLinks, buildLinkPlan } from './release/links.js';
import { ensureNpmLogin, ensureCargoLogin } from './release/auth.js';
import { npmVersion } from './release/registry.js';
import { increment, isVersion } from './release/semver.js';
import {
  publishCrate,
  publishEngine,
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
  --only=<список>      подмножество шагов: crate,engine,games,prod
  --relink             только вернуть локальные npm link и выйти
  --yes                принять предложенные версии (пуш в main всё равно
                       спрашивается отдельно)
  --help

Что скрипт решает сам:
  · какие артефакты публиковать — по изменённым путям от базовой точки
    (тег релиза либо коммит с текущей версией), по разнице локальной и
    опубликованной версии и по непустой секции [Unreleased];
  · какой инкремент предложить — по под-заголовкам [Unreleased]:
    ⚠️ Breaking → minor в 0.x, Added → minor, иначе patch;
  · какие игры-плагины есть на машине — по npm link и соседним каталогам;
    каждая подтверждается отдельно.

Порядок: крейт → движок → игры → прод. Проверки (eslint, тесты, core:test,
sim, тарбол) обязательны, флага их пропуска нет. Локальные линки снимаются
до сборки и возвращаются при любом исходе, включая Ctrl-C.
`;

const STEPS = ['crate', 'engine', 'games', 'prod'];

function parseFlags(argv) {
  let parsed;

  try {
    parsed = parseArgs({
      args: argv,
      options: {
        'dry-run': { type: 'boolean', default: false },
        only: { type: 'string' },
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

async function preflight(root, { needsRust }) {
  const problems = [];

  const branch = await capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: root,
    allowFailure: true,
  });

  if (branch.output.trim() !== 'main') {
    problems.push(`ветка ${branch.output.trim()}, а релиз идёт с main`);
  }

  const status = await capture('git', ['status', '--short'], { cwd: root });

  if (status.output.trim() !== '') {
    problems.push('рабочее дерево не чистое');
  }

  await capture('git', ['fetch'], { cwd: root, allowFailure: true });

  const behind = await capture(
    'git',
    ['rev-list', '--count', 'HEAD..@{u}'],
    { cwd: root, allowFailure: true },
  );

  if (behind.code === 0 && Number(behind.output.trim()) > 0) {
    problems.push(`отставание от remote на ${behind.output.trim()} коммит(ов)`);
  }

  // локальный [patch.crates-io] публикует крейт, собранный против кода,
  // которого нет ни у кого больше
  for (const file of ['Cargo.toml', 'packages/engine/core/Cargo.toml']) {
    try {
      const text = await readFile(path.join(root, file), 'utf8');

      if (text.includes('[patch.crates-io]')) {
        problems.push(`${file} содержит [patch.crates-io]`);
      }
    } catch {
      // отсутствующий файл — не проблема этой проверки
    }
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

async function selectGames(root, { yes }) {
  const candidates = await discoverGames(root);
  const selected = [];

  for (const candidate of candidates) {
    const info = await validateGame(candidate.dir);

    if (!info.valid) {
      ui.log(
        `пропущен ${candidate.dir}: ${info.problems.join(', ')} (${candidate.source})`,
      );
      continue;
    }

    const published = await npmVersion(info.name);
    const git = await checkGitState(info.dir);

    ui.log(
      `игра ${info.name} — ${info.dir}\n` +
        `          локальная ${info.version}, в npm ${published ?? '—'} (${candidate.source})`,
    );

    if (git.problems.length) {
      // публиковать из грязного дерева можно только осознанно: в тарбол
      // уедет то, что лежит на диске, а тег встанет на другой коммит
      ui.error(`  внимание: ${git.problems.join(', ')}`);
    }

    const take = yes
      ? git.problems.length === 0
      : await ui.confirm(
          'Включить эту игру в релиз?',
          git.problems.length === 0,
        );

    if (take) {
      selected.push({ ...info, published });
    }
  }

  if (!yes) {
    const extra = await ui.ask('Путь к ещё одной игре (пусто — пропустить)', '');

    if (extra !== '') {
      const info = await validateGame(path.resolve(extra));

      if (info.valid) {
        selected.push({ ...info, published: await npmVersion(info.name) });
      } else {
        ui.error(`не годится: ${info.problems.join(', ')}`);
      }
    }
  }

  return selected;
}

async function askVersion(label, current, level, reason, { yes }) {
  const suggested = increment(current, level);

  ui.log(`${label}: ${current} → ${suggested} (${reason})`);

  if (yes) {
    return suggested;
  }

  const answer = await ui.ask(
    'Enter — принять, либо patch/minor/major/своя версия',
    suggested,
  );

  if (['patch', 'minor', 'major'].includes(answer)) {
    return increment(current, answer);
  }

  if (!isVersion(answer)) {
    throw new UsageError(`не версия и не уровень инкремента: ${answer}`);
  }

  return answer;
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
  const shell = createShell({ dryRun: args['dry-run'], log: ui.raw });

  if (args['dry-run']) {
    ui.log('режим --dry-run: изменяющие команды не выполняются');
  }

  // --relink: аварийное восстановление после SIGKILL, когда обработчики
  // возврата линков не отработали
  if (args.relink) {
    const games = await selectGames(root, { yes: args.yes });
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
  const games = args.only.includes('games')
    ? await selectGames(root, { yes: args.yes })
    : [];

  const decision = decide({
    crate: args.only.includes('crate') ? collected.crate : null,
    engine: args.only.includes('engine') ? collected.engine : null,
    engineApiChanged: collected.engineApiChanged,
    games,
  });

  const problems = await preflight(root, {
    needsRust: decision.crate.publish || decision.games.some(game => game.publish),
  });

  if (problems.length) {
    ui.error('preflight не пройден:');
    problems.forEach(problem => ui.raw(`  - ${problem}`));
    return 1;
  }

  // версии
  if (decision.crate.publish && decision.crate.bump) {
    decision.crate.target = await askVersion(
      CRATE_NAME,
      decision.crate.current,
      decision.crate.level,
      decision.crate.reason,
      args,
    );
  }

  if (decision.engine.publish && decision.engine.bump) {
    decision.engine.target = await askVersion(
      'vimp-engine',
      decision.engine.current,
      decision.engine.level,
      decision.engine.reason,
      args,
    );
  }

  const selectedGames = decision.games.filter(game => game.publish);

  for (const game of selectedGames) {
    // у игр CHANGELOG нет: предложение опирается на бамп крейта или
    // ENGINE_API_VERSION, и всегда подтверждается
    const level = decision.crate.publish || collected.engineApiChanged
      ? 'minor'
      : 'patch';

    game.target = await askVersion(
      game.name,
      game.version,
      level,
      decision.crate.publish
        ? 'пересборка на новом крейте'
        : collected.engineApiChanged
          ? 'новый ENGINE_API_VERSION'
          : 'изменения игры',
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
        'vimp-engine',
        decision.engine.publish ? 'да' : 'нет',
        decision.engine.target ?? decision.engine.current ?? '—',
        decision.engine.reason,
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

  if (!decision.crate.publish && !decision.engine.publish && !selectedGames.length) {
    ui.log('публиковать нечего');
    return 0;
  }

  if (!args.yes && !(await ui.confirm('Выполняем этот план?', false))) {
    ui.log('отменено');
    return 0;
  }

  // логины — только для реестров, куда реально пойдёт публикация
  if (decision.engine.publish || selectedGames.length) {
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

    const engineApi = await readEngineApiVersion(root);

    for (const game of selectedGames) {
      await publishGame({
        shell,
        game,
        crateVersion: decision.crate.publish ? decision.crate.target : null,
        engineVersion: decision.engine.publish ? decision.engine.target : null,
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
        tags: report.tags.filter(name => !name.includes(': ')),
      });
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await restore();
  }

  ui.log('готово.');
  ui.raw(`  опубликовано: ${report.published.join(', ') || '—'}`);
  ui.raw(`  теги:         ${report.tags.join(', ') || '—'}`);
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
