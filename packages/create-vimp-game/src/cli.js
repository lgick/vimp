import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate, GenerateError } from './generator.js';
import { askAnswers } from './prompts.js';
import { checkTools, initGit } from './preflight.js';
import {
  buildTokens,
  defaultPackageName,
  defaultTitle,
  toGameId,
  TokenError,
} from './tokens.js';
import { resolveVersions, toPins } from './versions.js';
import { color, log, nextSteps, warn } from './ui.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(moduleDir, '..');

export class UsageError extends Error {}

export const USAGE = `Usage: create-vimp-game <directory> [options]

  --id <id>          game id, kebab-case (default: directory name)
  --title <title>    human-readable title
  --package <name>   npm package name (default: @vimp-games/<id>)
  --author <name>
  --yes, -y          accept all defaults, no prompts
  --force            allow a non-empty target directory
  --no-git           skip \`git init\`
  --engine-path <p>  dev only: link a local engine checkout
  --core-path <p>    dev only: [patch.crates-io] for vimp-engine-core
  --help, --version
`;

const VALUE_OPTIONS = new Map([
  ['--id', 'id'],
  ['--title', 'title'],
  ['--package', 'packageName'],
  ['--author', 'author'],
  ['--engine-path', 'enginePath'],
  ['--core-path', 'corePath'],
]);

export function parseArgs(argv) {
  const args = { git: true };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (VALUE_OPTIONS.has(arg)) {
      i += 1;

      // значение, начинающееся с '--', — почти всегда забытый аргумент:
      // без проверки следующий флаг тихо стал бы названием игры
      if (argv[i] === undefined || argv[i].startsWith('--')) {
        throw new UsageError(`option '${arg}' needs a value\n\n${USAGE}`);
      }

      args[VALUE_OPTIONS.get(arg)] = argv[i];
      continue;
    }

    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;

      case '--version':
      case '-v':
        args.version = true;
        break;

      case '--yes':
      case '-y':
        args.yes = true;
        break;

      case '--force':
        args.force = true;
        break;

      case '--no-git':
        args.git = false;
        break;

      default:
        if (arg.startsWith('-')) {
          throw new UsageError(`unknown option '${arg}'\n\n${USAGE}`);
        }

        if (args.directory !== undefined) {
          throw new UsageError(`unexpected argument '${arg}'\n\n${USAGE}`);
        }

        args.directory = arg;
    }
  }

  return args;
}

// дефолты для интерактива и для --yes считаются одинаково: ответы человека
// лишь перекрывают их
export function buildDefaults(args) {
  const directory = args.directory ?? 'my-game';
  const id = args.id ?? toGameId(path.basename(path.resolve(directory)));

  return {
    directory,
    id,
    title: args.title ?? defaultTitle(id),
    packageName: args.packageName ?? defaultPackageName(id),
    author: args.author ?? '',
  };
}

async function ownVersion() {
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  );

  return manifest.version;
}

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (args.version) {
    process.stdout.write(`${await ownVersion()}\n`);
    return 0;
  }

  // интерактив имеет смысл только у живого терминала: в CI и под пайпом
  // вопросы повисли бы без ответа
  const interactive = args.yes !== true && process.stdin.isTTY === true;

  if (args.directory === undefined && !interactive) {
    throw new UsageError(`missing <directory>\n\n${USAGE}`);
  }

  const answers = await askAnswers(buildDefaults(args), { interactive });
  const pins = toPins(await resolveVersions());

  const tokens = buildTokens({
    id: answers.id,
    title: answers.title,
    packageName: answers.packageName,
    author: answers.author,
    ...pins,
  });

  const targetDir = path.resolve(answers.directory);

  await generate({
    templateDir: path.join(packageRoot, 'templates', 'default'),
    targetDir,
    tokens,
    force: args.force === true,
    enginePath: args.enginePath,
    corePath: args.corePath,
  });

  if (args.git) {
    await initGit(targetDir);
  }

  for (const tool of await checkTools()) {
    warn(`${color.bold(tool.command)} not found — ${tool.hint}`);
  }

  log(nextSteps({ directory: answers.directory, tokens }));

  return 0;
}

export function reportError(error) {
  const known =
    error instanceof UsageError ||
    error instanceof GenerateError ||
    error instanceof TokenError;

  process.stderr.write(
    known ? `${error.message}\n` : `${error.stack ?? error.message}\n`,
  );
}
