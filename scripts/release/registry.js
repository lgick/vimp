import { capture } from './shell.js';
import { compareVersions, isVersion } from './semver.js';

// Опубликованные версии: npm и crates.io. Это и есть источник истины о том,
// что уже уехало — поэтому повторный запуск после сбоя не публикует дважды
// и файл состояния не нужен.

const POLL_INTERVAL_MS = 3000;
// Публикация ушла в CI (release.yml, запускается пушем тега, OIDC Trusted
// Publishing) — это ожидание теперь покрывает не только CDN-пропагацию уже
// случившегося publish, а весь прогон: checkout, установку тулчейна, сборку
// (для игр — ещё и wasm-pack), сам publish. 10 минут с запасом на холодный
// cargo-кэш и очередь GitHub-раннеров.
const POLL_TIMEOUT_MS = 600000;

// Разбор ответа `npm view --json` отдельно от вызова: «пакета нет» (E404)
// обязано отличаться от «реестр не ответил». Иначе сетевой сбой читается как
// «ещё не публиковался» и скрипт публикует поверх уже опубликованного.
export function parseNpmView(name, { code, stdout, stderr }) {
  let parsed = null;

  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    parsed = null;
  }

  if (code !== 0) {
    if (parsed?.error?.code === 'E404') {
      return null;
    }

    throw new Error(
      `npm view ${name} не ответил (код ${code}): ` +
        `${(stderr || stdout).trim() || 'без вывода'}`,
    );
  }

  const version = Array.isArray(parsed) ? parsed.at(-1) : parsed;

  return isVersion(version) ? version : null;
}

export async function npmVersion(name, options = {}) {
  // без --prefer-online npm до 5 минут отдаёт манифест из кеша, и
  // ожидание свежей версии истекало, хотя она давно в реестре
  const result = await capture('npm', ['view', name, 'version', '--json', '--prefer-online'], {
    allowFailure: true,
    cwd: options.cwd,
  });

  return parseNpmView(name, result);
}

// Путь в sparse-индексе crates.io: 1/2/3 символа — особые случаи, дальше
// первые две пары букв. index.crates.io выбран вместо api/v1/crates: он не
// требует User-Agent и отдаёт построчный JSON.
export function crateIndexPath(name) {
  const lower = name.toLowerCase();

  if (lower.length === 1) {
    return `1/${lower}`;
  }
  if (lower.length === 2) {
    return `2/${lower}`;
  }
  if (lower.length === 3) {
    return `3/${lower[0]}/${lower}`;
  }

  return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

export async function crateVersion(name) {
  const url = `https://index.crates.io/${crateIndexPath(name)}`;

  let response;

  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`index.crates.io недоступен (${name}): ${error.message}`);
  }

  // 404 — крейта в индексе нет, это валидный ответ; всё остальное значит,
  // что мы просто не знаем опубликованную версию, и молчать нельзя
  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`index.crates.io ответил ${response.status} на ${name}`);
  }

  const body = await response.text();
  const versions = body
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(entry => entry && entry.yanked !== true && isVersion(entry.vers))
    .map(entry => entry.vers);

  if (versions.length === 0) {
    return null;
  }

  return versions.sort(compareVersions).at(-1);
}

// Опрос идёт в фоне, пока скрипт занят другими шагами, поэтому он молчит:
// строка о таймауте легла бы посреди чужого вопроса. О результате говорит тот,
// кто ждёт (steps.js: awaitPublished). signal обрывает опрос, когда прогон
// упал: иначе фоновые таймеры держали бы процесс до 10 минут после ошибки.
async function waitFor(read, version, signal) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (!signal?.aborted) {
    // пока ждём, отказ реестра — это не приговор, а повод повторить
    const published = await read().catch(() => null);

    if (published && compareVersions(published, version) >= 0) {
      return true;
    }

    if (Date.now() > deadline) {
      return false;
    }

    await sleep(POLL_INTERVAL_MS, signal);
  }

  return false;
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function waitForNpm(name, version, signal) {
  return waitFor(() => npmVersion(name), version, signal);
}

export function waitForCrate(name, version, signal) {
  return waitFor(() => crateVersion(name), version, signal);
}

// Все запущенные опросы: cancelWaits() обрывает их, когда прогон падает.
const active = new Set();

// Опрос реестра стартует сразу после пуша тега, а ждут его там, где версия
// действительно нужна (release.js): CI публикует минутами, и последовательное
// ожидание каждого артефакта простаивало бы, пока скрипт мог работать дальше.
// promise не бросает и ни о чём не спрашивает — решение «продолжать ли без
// версии» принимает тот, кто ждёт (steps.js: awaitPublished). wait получает
// AbortSignal.
export function startWait(label, wait, ci = null) {
  const controller = new AbortController();

  active.add(controller);

  return {
    label,
    ci,
    done: false,
    // true — версия в реестре; false — не дождались (решение принял awaitPublished)
    published: null,
    promise: Promise.resolve()
      .then(() => wait(controller.signal))
      .catch(() => false)
      .finally(() => active.delete(controller)),
  };
}

export function cancelWaits() {
  for (const controller of active) {
    controller.abort();
  }

  active.clear();
}
