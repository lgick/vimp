import { capture } from './shell.js';
import { compareVersions, isVersion } from './semver.js';

// Опубликованные версии: npm и crates.io. Это и есть источник истины о том,
// что уже уехало — поэтому повторный запуск после сбоя не публикует дважды
// и файл состояния не нужен.

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 180000;

export async function npmVersion(name, options = {}) {
  const { code, output } = await capture(
    'npm',
    ['view', name, 'version', '--json'],
    { allowFailure: true, cwd: options.cwd },
  );

  if (code !== 0) {
    return null; // пакет ещё не опубликован (E404) либо реестр недоступен
  }

  try {
    const value = JSON.parse(output);
    const version = Array.isArray(value) ? value.at(-1) : value;
    return isVersion(version) ? version : null;
  } catch {
    return null;
  }
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
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
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

async function waitFor(read, version, label, log) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  for (;;) {
    const published = await read();

    if (published && compareVersions(published, version) >= 0) {
      return true;
    }

    if (Date.now() > deadline) {
      log(`  ! ${label} ${version} не появился в реестре за 3 минуты`);
      return false;
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export function waitForNpm(name, version, log) {
  return waitFor(() => npmVersion(name), version, name, log);
}

export function waitForCrate(name, version, log) {
  return waitFor(() => crateVersion(name), version, name, log);
}
