#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runScenario } from '../src/devtools/ScenarioRunner.js';
import { builtinScenario } from '../src/devtools/builtinScenario.js';
import {
  loadGameForSim,
  FIXTURE_SOURCE,
} from '../src/devtools/pluginLoader.js';
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

// каждая строка с префиксом: дальше в stderr уходит список падений, и
// грепалки CI не должны путать предупреждение с ними
const BUILTIN_NOTICE =
  'notice: the built-in smoke scenario is running against --game. It only\n' +
  'notice: proves the loop closes on this plugin: key coverage (invariant 2)\n' +
  'notice: and prediction drift (invariant 9) are skipped — both need a\n' +
  'notice: scenario written for your game. See § Scenario format in the\n' +
  "notice: engine's docs/en/debugging.md (github.com/lgick/vimp), then run\n" +
  'notice: vimp-sim --scenario <file>.\n\n';

async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // плагин грузится один раз: второй прогон самопроверки детерминизма
  // обязан идти на том же ядре, иначе он проверял бы загрузчик, а не мир.
  // Загрузка идёт до сборки сценария: встроенный берёт имена модели, команды
  // и клавиши из gameConfig игры
  const plugin = await loadGameForSim({ game: args.game, core: args.core });

  if (!args.scenario && plugin.source !== FIXTURE_SOURCE) {
    process.stderr.write(BUILTIN_NOTICE);
  }

  const scenario = args.scenario
    ? JSON.parse(await readFile(args.scenario, 'utf8'))
    : builtinScenario(plugin);
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
