#!/usr/bin/env node
import {
  checkContract,
  hasBlockingFailure,
} from '../src/devtools/contract/index.js';
import { formatContract } from '../src/devtools/contract/format.js';

// CLI статической проверки контракта: правка → npm run check:contract →
// список нарушенных правил, без сборки и без браузера. Дополняет
// vimp-sim: раннер судит по прогону, этот инструмент — по конфигам.

class UsageError extends Error {}

const USAGE = `Usage: vimp-contract [options]

  --game <path>  game package directory (default: .)
  --json         print the machine-readable report instead of text
  --quiet        print only failures and the summary
  --strict       treat warnings as errors (exit code 1)
  --help
`;

async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const game = args.game ?? '.';
  const report = await checkContract(game);

  process.stdout.write(
    args.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatContract(report, { quiet: args.quiet }),
  );

  // ни одного вердикта — обычно опечатка в пути. Нулевой код выхода здесь
  // читался бы как «проверено, всё хорошо», хотя проверено ничего
  if (report.summary.passed === 0 && report.summary.failed === 0) {
    process.stderr.write(
      `nothing to check in '${game}' — no rule found its input; ` +
        'is this a game package directory?\n',
    );

    return 1;
  }

  return hasBlockingFailure(report, args.strict === true) ? 1 : 0;
}

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;

      case '--json':
        args.json = true;
        break;

      case '--quiet':
        args.quiet = true;
        break;

      case '--strict':
        args.strict = true;
        break;

      case '--game':
        i += 1;

        // «--game» без значения тихо проверял бы текущий каталог — то есть
        // сам движок; путь, начинающийся с '--', тем самым запрещён
        if (argv[i] === undefined || argv[i].startsWith('--')) {
          throw new UsageError(`option '${arg}' needs a value\n\n${USAGE}`);
        }

        args.game = argv[i];
        break;

      default:
        throw new UsageError(`unknown option '${arg}'\n\n${USAGE}`);
    }
  }

  return args;
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  error => {
    process.stderr.write(
      error instanceof UsageError
        ? `${error.message}\n`
        : `${error.stack ?? error.message}\n`,
    );
    process.exitCode = 1;
  },
);
