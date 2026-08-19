import { readFile, readdir, realpath, stat, lstat } from 'node:fs/promises';
import path from 'node:path';

import { capture } from './shell.js';
import { isVersion } from './semver.js';

// Обнаружение локальных чекаутов игр-плагинов. Ничего не публикуется «само»:
// найденный кандидат обязан пройти валидацию и получить подтверждение
// человека — список ниже только сокращает ручной ввод путей.

const SCOPE = '@vimp-games';
// `vimp-engine-core = "0.3.0"` — форма, которую умеет переписывать шаг B
const CORE_PIN = /^\s*vimp-engine-core\s*=\s*"([^"]+)"/m;
// Пин живёт либо прямо в крейте игры, либо (workspace-раскладка, где
// core/Cargo.toml пишет `{ workspace = true }`) в корневом Cargo.toml —
// порядок важен: литеральный пин в крейте перебивает workspace-овый
const CORE_PIN_FILES = [path.join('core', 'Cargo.toml'), 'Cargo.toml'];

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

// Чекаут — это каталог с git и исходниками, а не установленная копия из
// реестра: отличаем по .git внутри.
async function isCheckout(dir) {
  return isDirectory(path.join(dir, '.git'));
}

async function fromScopeDir(scopeDir, source) {
  const found = [];

  let entries;

  try {
    entries = await readdir(scopeDir);
  } catch {
    return found;
  }

  for (const entry of entries) {
    const target = path.join(scopeDir, entry);

    try {
      const link = await lstat(target);
      const resolved = link.isSymbolicLink() ? await realpath(target) : target;

      if (await isCheckout(resolved)) {
        found.push({ dir: resolved, source });
      }
    } catch {
      // недоступный кандидат просто выпадает из списка
    }
  }

  return found;
}

async function fromSiblings(root) {
  const parent = path.dirname(root);
  const found = [];

  let entries;

  try {
    entries = await readdir(parent);
  } catch {
    return found;
  }

  for (const entry of entries) {
    const dir = path.join(parent, entry);

    if (dir === root || !(await isDirectory(dir))) {
      continue;
    }

    const pkg = await readJson(path.join(dir, 'package.json'));

    if (pkg?.name?.startsWith(`${SCOPE}/`)) {
      found.push({ dir, source: 'соседний каталог' });
    }
  }

  return found;
}

export async function discoverGames(root) {
  const globalRoot = await capture('npm', ['root', '-g'], {
    allowFailure: true,
  });

  const sources = [
    ...(await fromScopeDir(
      path.join(root, 'node_modules', SCOPE),
      'npm link в vimp',
    )),
    ...(globalRoot.code === 0
      ? await fromScopeDir(
          path.join(globalRoot.output.trim(), SCOPE),
          'глобальный npm link',
        )
      : []),
    ...(await fromSiblings(root)),
  ];

  const unique = new Map();

  for (const candidate of sources) {
    if (!unique.has(candidate.dir)) {
      unique.set(candidate.dir, candidate);
    }
  }

  return [...unique.values()];
}

// Где у игры лежит переписываемый пин на ядро и какой он.
async function findCorePin(dir) {
  for (const file of CORE_PIN_FILES) {
    let text;

    try {
      text = await readFile(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }

    const version = CORE_PIN.exec(text)?.[1];

    if (version) {
      return { version, file };
    }
  }

  return { version: null, file: null };
}

// Валидация кандидата по файлам на диске (без сети и без git — состояние
// репозитория проверяется отдельно, checkGitState).
export async function validateGame(dir) {
  const pkg = await readJson(path.join(dir, 'package.json'));
  const problems = [];

  if (!pkg) {
    return { dir, valid: false, problems: ['нет package.json'] };
  }

  const name = pkg.name ?? '(без имени)';

  if (!name.startsWith(`${SCOPE}/`)) {
    problems.push(`имя ${name} вне scope ${SCOPE}/*`);
  }

  // без версии вида X.Y.Z план дойдёт до `git tag vnull`, а пререлиз уронит
  // compareVersions посреди планирования — обе ошибки уже после сборки и
  // коммита, то есть ловить их надо здесь
  if (!isVersion(pkg.version)) {
    problems.push(`version=${pkg.version ?? '—'} не вида X.Y.Z`);
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };

  if (!deps['vimp-engine']) {
    problems.push('vimp-engine отсутствует в зависимостях');
  }

  for (const script of ['build', 'core:build']) {
    if (!pkg.scripts?.[script]) {
      problems.push(`нет скрипта ${script}`);
    }
  }

  // Rust-ядро обязательно: тарбол проверяется на dist/core-node/*.wasm,
  // то есть игра без своего крейта нерелизуема этим скриптом в принципе
  const cargoPath = path.join(dir, 'core', 'Cargo.toml');
  let cargo = null;

  try {
    cargo = await readFile(cargoPath, 'utf8');
  } catch {
    problems.push('нет core/Cargo.toml');
  }

  if (cargo && !/^\s*vimp-engine-core\s*=/m.test(cargo)) {
    problems.push('core/Cargo.toml не зависит от vimp-engine-core');
  }

  const pin = cargo ? await findCorePin(dir) : { version: null, file: null };

  return {
    dir,
    name,
    version: pkg.version ?? null,
    scripts: pkg.scripts ?? {},
    // пин на крейт: по нему видно, собрана ли игра на актуальном ядре.
    // Форма ровно та, которую умеет переписывать шаг B (steps.js), иначе
    // отставание нашлось бы, а починить его скрипт бы не смог
    corePin: pin.version,
    // шаг B переписывает именно этот файл
    corePinFile: pin.file,
    valid: problems.length === 0,
    problems,
  };
}

// Третий сигнал детекта для игры: `dist/` под .gitignore, поэтому диффать
// по путям бессмысленно — считаем коммиты после тега текущей версии.
export async function collectGameState(dir, version) {
  const tag = await capture(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}^{commit}`],
    { cwd: dir, allowFailure: true },
  );

  if (tag.code !== 0) {
    // тега нет — судить не по чему, считаем изменённой и говорим об этом
    return { changed: true, base: null };
  }

  const since = await capture(
    'git',
    ['rev-list', '--count', `${tag.stdout.trim()}..HEAD`],
    { cwd: dir, allowFailure: true },
  );

  return {
    changed: since.code === 0 && Number(since.stdout.trim()) > 0,
    base: `тег v${version}`,
  };
}

// Состояние git-репозитория игры: чистое дерево и настроенный remote.
export async function checkGitState(dir) {
  const problems = [];

  const status = await capture('git', ['status', '--short'], {
    cwd: dir,
    allowFailure: true,
  });

  if (status.code !== 0) {
    return { problems: ['не git-репозиторий'] };
  }

  if (status.stdout.trim() !== '') {
    problems.push('рабочее дерево не чистое');
  }

  const remote = await capture('git', ['remote'], { cwd: dir, allowFailure: true });

  if (remote.stdout.trim() === '') {
    problems.push('нет remote');
  }

  // без upstream `git push` упадёт уже после npm publish — то есть
  // необратимый шаг сделан, а коммит и тег остались локально
  const upstream = await capture(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { cwd: dir, allowFailure: true },
  );

  if (upstream.code !== 0) {
    problems.push('у текущей ветки нет upstream (git push не сработает)');
  }

  return { problems };
}

// Локальный [patch.crates-io] публикует ядро, собранное против крейта,
// которого нет ни у кого больше — первый пункт «Pitfalls» в publishing.md.
export async function findCratePatches(dir, files) {
  const problems = [];

  for (const file of files) {
    try {
      const text = await readFile(path.join(dir, file), 'utf8');

      if (text.includes('[patch.crates-io]')) {
        problems.push(`${path.join(dir, file)} содержит [patch.crates-io]`);
      }
    } catch {
      // отсутствующий файл — не проблема этой проверки
    }
  }

  return problems;
}
