#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runScenario } from '../src/devtools/ScenarioRunner.js';
import { loadGameForSim } from '../src/devtools/pluginLoader.js';
import {
  checkDeterminism,
  summarize,
  FAIL,
} from '../src/devtools/invariants.js';
import { writeReport, formatMarkdown } from '../src/devtools/report.js';

// CLI headless-прогона: правка → npm run sim → текстовый вердикт, без
// браузера и без человека.

const USAGE = `Usage: vimp-sim [options]

  --scenario <path>  scenario JSON (default: built-in smoke scenario)
  --game <path>      game package directory or dist/manifest.json
  --core <path>      node build of the game core (overrides entries.wasmNode)
  --out <dir>        report root (default: .debug)
  --no-write         print the report to stdout instead of writing files
  --determinism      run the scenario twice and compare the frame streams
  --help
`;

// минимальный сценарий на фикстуре: один игрок заходит, едет вперёд,
// отпускает клавишу — этого хватает, чтобы контур доказал, что он замкнут
const DEFAULT_SCENARIO = {
  version: 1,
  seed: 3812,
  participants: [{ id: 'p1', name: 'P1', model: 'm1' }],
  timeline: [
    { tick: 0, op: 'join', who: 'p1', team: 'team1' },
    { tick: 10, op: 'key', who: 'p1', action: 'down', name: 'forward' },
    { tick: 60, op: 'key', who: 'p1', action: 'up', name: 'forward' },
  ],
  // событийный ключ фикстуры в этом сценарии не стреляет — объявлено явно,
  // иначе инвариант 2 честно посчитает это «сущность не спавнится»
  unusedSnapshotKeys: ['e1'],
  ticks: 120,
};

async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const scenario = args.scenario
    ? JSON.parse(await readFile(args.scenario, 'utf8'))
    : DEFAULT_SCENARIO;

  // плагин грузится один раз: второй прогон самопроверки детерминизма
  // обязан идти на том же ядре, иначе он проверял бы загрузчик, а не мир
  const plugin = await loadGameForSim({ game: args.game, core: args.core });
  // хеши потока кадров собираются только под --determinism: их единственный
  // потребитель — сравнение двух прогонов, а объём линеен по длине матча
  const captureFrames = args.determinism === true;
  const report = await runScenario(scenario, { plugin, captureFrames });

  if (args.determinism) {
    const second = await runScenario(scenario, { plugin, captureFrames });
    const check = checkDeterminism(report, second);

    report.invariants = report.invariants.map(item =>
      item.name === check.name ? check : item,
    );
    report.invariantSummary = summarize(report.invariants);
  }

  if (args.write === false) {
    process.stdout.write(formatMarkdown(report));
  } else {
    const runDir = await writeReport(report, { outDir: args.out });

    process.stdout.write(formatMarkdown(report));
    process.stdout.write(`\nReport written to ${runDir}\n`);
  }

  const failed = report.invariants.filter(check => check.status === FAIL);

  if (failed.length) {
    process.stderr.write(
      `\n${failed.length} broken contract(s): ` +
        `${failed.map(check => check.name).join(', ')}\n`,
    );

    return 1;
  }

  return 0;
}

function parseArgs(argv) {
  const args = { write: true };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;

      case '--no-write':
        args.write = false;
        break;

      case '--determinism':
        args.determinism = true;
        break;

      case '--scenario':
      case '--game':
      case '--core':
      case '--out':
        i += 1;
        args[arg.slice(2)] = argv[i];
        break;

      default:
        throw new Error(`unknown option '${arg}'\n\n${USAGE}`);
    }
  }

  return args;
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  error => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  },
);
