import { levelForBreaking } from './semver.js';

// Разбор и датирование журналов Keep a Changelog (packages/engine/CHANGELOG.md
// и packages/engine/core/CHANGELOG.md). Формат заголовка релиза в обоих
// файлах — `## [X.Y.Z] — YYYY-MM-DD` с длинным тире, ссылки внизу файла.

const EM_DASH = '—';
const UNRELEASED_HEADING = /^##\s+\[Unreleased\]\s*$/;
// секция кончается на любом следующем `## ` или на блоке ссылок внизу:
// в журнале нового пакета релизных заголовков ещё нет вовсе
const NEXT_HEADING = /^##\s+/;
const ANY_LINK_REF = /^\[[^\]]+\]:\s/;
const SUB_HEADING = /^###\s+(.*)$/;
const VERSION_LINK_REF = /^\[\d+\.\d+\.\d+\]:\s/;

// Секция [Unreleased]: её текст, список под-заголовков и признак пустоты.
export function parseUnreleased(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => UNRELEASED_HEADING.test(line));

  if (start === -1) {
    return { present: false, sections: [], body: '', isEmpty: true };
  }

  let end = lines.length;

  for (let index = start + 1; index < lines.length; index += 1) {
    if (NEXT_HEADING.test(lines[index]) || ANY_LINK_REF.test(lines[index])) {
      end = index;
      break;
    }
  }

  const body = lines.slice(start + 1, end).join('\n');
  const sections = [];

  for (const line of lines.slice(start + 1, end)) {
    const match = SUB_HEADING.exec(line);

    if (match) {
      sections.push(match[1].trim());
    }
  }

  return {
    present: true,
    sections,
    body: body.trim(),
    isEmpty: body.trim() === '',
  };
}

// Закрытый список под-заголовков [Unreleased] и уровень, который каждый
// задаёт. Это контракт, а не подсказка: заголовок выбирается в момент правки
// кода и тем самым фиксирует версию релиза (docs/en/publishing.md →
// «Changelog headings set the version»). `Breaking` разрешается в minor или
// major по текущей версии, `Migration` уровня не задаёт вовсе.
export const SECTION_LEVELS = new Map([
  ['Breaking', 'breaking'],
  ['Added', 'minor'],
  ['Changed', 'patch'],
  ['Deprecated', 'patch'],
  ['Removed', 'patch'],
  ['Fixed', 'patch'],
  ['Security', 'patch'],
  ['Migration', null],
]);

// уточнение после ` — ` или в скобках — обе формы в ходу:
// `### ⚠️ Breaking — reset() also clears my_game_id`, `### Migration (game plugins)`
const HEADING_SUFFIX = /\s+[—(].*$/u;

// Имя заголовка без эмодзи-предупреждения и без уточнения. Незнакомое слово
// возвращается как есть — отбраковка это дело validateSections.
export function sectionName(heading) {
  const bare = String(heading)
    .replace(/^(?:⚠️?|\s)+/u, '')
    .replace(HEADING_SUFFIX, '')
    .trim();

  return bare === '' ? null : bare;
}

// Проверка секции против контракта. Незнакомый заголовок молча падал бы в
// patch, то есть занижал релиз, поэтому релиз на нём останавливается
// (release.js → preflight).
export function validateSections(sections) {
  const problems = [];
  const names = [];

  for (const section of sections) {
    const name = sectionName(section);

    if (name === null || !SECTION_LEVELS.has(name)) {
      problems.push(
        `заголовок «### ${section}» не из списка (${[...SECTION_LEVELS.keys()].join(', ')})`,
      );
      continue;
    }

    names.push(name);
  }

  // пара обязательна в обе стороны: миграция без ломающего изменения ничего
  // не описывает, ломающее без миграции оставляет потребителя без инструкции.
  // Проверка по наличию, а не по парности: в core/CHANGELOG.md таких пар две
  if (names.includes('Breaking') && !names.includes('Migration')) {
    problems.push('есть ### ⚠️ Breaking, но нет ### Migration');
  }

  if (names.includes('Migration') && !names.includes('Breaking')) {
    problems.push('есть ### Migration, но нет ### ⚠️ Breaking');
  }

  return problems;
}

// Предложение инкремента по содержимому [Unreleased]: старший заголовок
// секции и решает. Неизвестные имена сюда не доходят — их снимает
// validateSections до начала работ.
export function suggestLevel(sections, version) {
  const names = sections.map(sectionName);

  if (names.includes('Breaking')) {
    return { level: levelForBreaking(version), reason: '### ⚠️ Breaking' };
  }

  if (names.includes('Added')) {
    return { level: 'minor', reason: '### Added' };
  }

  return { level: 'patch', reason: 'без ### Added и ### ⚠️ Breaking' };
}

export function tagFor(artifact, version) {
  return `${artifact}@${version}`;
}

export function releaseLink(repoUrl, artifact, version) {
  return `[${version}]: ${repoUrl}/releases/tag/${artifact}%40${version}`;
}

// Датирует [Unreleased] как релиз и добавляет строку ссылки в блок внизу.
export function releaseUnreleased(text, { version, date, repoUrl, artifact }) {
  const lines = text.split('\n');
  const headingIndex = lines.findIndex(line => UNRELEASED_HEADING.test(line));

  if (headingIndex === -1) {
    throw new Error('CHANGELOG has no "## [Unreleased]" section');
  }

  // [Unreleased] остаётся на месте пустой: это конвенция обоих журналов и
  // третий сигнал детекта для следующего релиза
  lines.splice(
    headingIndex,
    1,
    '## [Unreleased]',
    '',
    `## [${version}] ${EM_DASH} ${date}`,
  );

  const linkLine = releaseLink(repoUrl, artifact, version);
  const firstLinkIndex = lines.findIndex(line => VERSION_LINK_REF.test(line));

  if (firstLinkIndex === -1) {
    // блока ссылок ещё нет — заводим его в конце файла
    while (lines.length && lines.at(-1).trim() === '') {
      lines.pop();
    }
    lines.push('', linkLine, '');
  } else {
    lines.splice(firstLinkIndex, 0, linkLine);
  }

  return lines.join('\n');
}
