// Минимальный semver без зависимостей: релиз-скрипту нужны разбор, сравнение
// и инкремент по правилу проекта «в 0.x ломающее изменение — это minor».

// пререлизы (`1.2.3-rc.1`) намеренно не поддерживаются: сравнивать их
// честно этот модуль не умеет, а проект их не выпускает — лучше отказ,
// чем «1.2.3-rc.1 равно 1.2.3»
const PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(value) {
  const match = PATTERN.exec(String(value).trim());

  if (!match) {
    throw new Error(`not a semver version: ${value}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function isVersion(value) {
  return PATTERN.test(String(value ?? '').trim());
}

export function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);

  return (
    left.major - right.major || left.minor - right.minor || left.patch - right.patch
  );
}

export function increment(version, level) {
  const { major, minor, patch } = parseVersion(version);

  if (level === 'major') {
    return formatVersion({ major: major + 1, minor: 0, patch: 0 });
  }

  if (level === 'minor') {
    return formatVersion({ major, minor: minor + 1, patch: 0 });
  }

  if (level === 'patch') {
    return formatVersion({ major, minor, patch: patch + 1 });
  }

  throw new Error(`unknown bump level: ${level}`);
}

// «Ломающее» в 0.x — это minor, а не major: правило зафиксировано в шапке
// обоих CHANGELOG и в docs/en/publishing.md
export function levelForBreaking(version) {
  return parseVersion(version).major === 0 ? 'minor' : 'major';
}
