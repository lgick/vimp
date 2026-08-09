import { levelForBreaking } from './semver.js';

// Разбор и датирование журналов Keep a Changelog (packages/engine/CHANGELOG.md
// и packages/engine/core/CHANGELOG.md). Формат заголовка релиза в обоих
// файлах — `## [X.Y.Z] — YYYY-MM-DD` с длинным тире, ссылки внизу файла.

const EM_DASH = '—';
const UNRELEASED_HEADING = /^##\s+\[Unreleased\]\s*$/;
// секция кончается на любом следующем `## ` или на блоке ссылок внизу:
// в журнале нового пакета релизных заголовков ещё нет вовсе
const NEXT_HEADING = /^##\s+/;
const RELEASE_HEADING = /^##\s+\[/;
const ANY_LINK_REF = /^\[[^\]]+\]:\s/;
const SUB_HEADING = /^###\s+(.*)$/;
const VERSION_LINK_REF = /^\[\d+\.\d+\.\d+\]:\s/;
// ограда блока кода: ``` или ~~~ (CommonMark разрешает до трёх пробелов
// отступа и любую длину от трёх символов)
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// Секция [Unreleased]: её текст, список под-заголовков и признак пустоты.
// `terminator` и `openFence` нужны validateUnreleased.
export function parseUnreleased(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => UNRELEASED_HEADING.test(line));

  if (start === -1) {
    // форма возврата одна на оба выхода: потребитель не должен различать
    // «секции нет» и «поля не заполнены»
    return {
      present: false,
      sections: [],
      body: '',
      isEmpty: true,
      terminator: null,
      openFence: false,
    };
  }

  const sections = [];
  let end = lines.length;
  let fence = null;
  let terminator = null;

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const fenced = FENCE.exec(line)?.[1];

    // внутри блока кода строки не разбираются: пример журнала в Migration
    // иначе читается как настоящие заголовки и меняет уровень релиза
    if (fence) {
      if (fenced && fenced[0] === fence[0] && fenced.length >= fence.length) {
        fence = null;
      }

      continue;
    }

    if (fenced) {
      fence = fenced;
      continue;
    }

    if (NEXT_HEADING.test(line) || ANY_LINK_REF.test(line)) {
      end = index;
      terminator = NEXT_HEADING.test(line) ? line.trim() : null;
      break;
    }

    const match = SUB_HEADING.exec(line);

    if (match) {
      sections.push(match[1].trim());
    }
  }

  const body = lines.slice(start + 1, end).join('\n').trim();

  return {
    present: true,
    sections,
    body,
    isEmpty: body === '',
    terminator,
    openFence: fence !== null,
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
  const bare = heading
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
  let unknown = 0;

  for (const section of sections) {
    const name = sectionName(section);

    if (name === null || !SECTION_LEVELS.has(name)) {
      problems.push(`заголовок «### ${section}» не из списка`);
      unknown += 1;
      continue;
    }

    names.push(name);
  }

  // подсказка одна на секцию, а не хвостом к каждому заголовку: `### added` и
  // `### Added - x` отбраковываются как выдуманное имя, хотя причина у них в
  // регистре и разделителе
  if (unknown > 0) {
    problems.push(
      `допустимые заголовки: ${[...SECTION_LEVELS.keys()].join(', ')}; ` +
        'имя чувствительно к регистру, уточнение отделяется « — » или круглыми скобками',
    );
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

// Проверка секции целиком. Отдельно от validateSections потому, что три
// способа не дать парсеру найти ни одного заголовка — `## Added` вместо
// `### Added`, записи списком без заголовка, отсутствующая секция — молча
// давали бы patch, то есть ровно ту дыру, которую контракт закрывает.
export function validateUnreleased(unreleased) {
  if (!unreleased?.present) {
    return ['нет секции ## [Unreleased] — уровень релиза выводить не из чего'];
  }

  const problems = validateSections(unreleased.sections);

  if (unreleased.openFence) {
    problems.push(
      'в [Unreleased] не закрыт блок кода — секция дочитана до конца файла',
    );
  }

  if (unreleased.terminator && !RELEASE_HEADING.test(unreleased.terminator)) {
    problems.push(
      `секция [Unreleased] оборвана заголовком «${unreleased.terminator}» — вероятно, ### написан как ##`,
    );
  }

  // пустая секция при изменённых файлах законна (правка только фикстур или
  // bin/), а вот текст без единого заголовка уехал бы в patch
  if (!unreleased.isEmpty && unreleased.sections.length === 0) {
    problems.push('в [Unreleased] есть записи, но нет ни одного ### под-заголовка');
  }

  return problems;
}

// Старшинство уровней: старший заголовок секции и решает.
const LEVEL_ORDER = ['patch', 'minor', 'breaking'];

// Предложение инкремента по содержимому [Unreleased]. Уровни берутся из
// SECTION_LEVELS, чтобы новый заголовок заводился одной строкой в карте, а
// не правкой в двух местах. Неизвестные имена сюда не доходят — их снимает
// validateSections до начала работ.
export function suggestLevel(sections, version) {
  let top = 'patch';
  let winner = null;

  for (const section of sections) {
    const name = sectionName(section);
    const level = SECTION_LEVELS.get(name);

    if (level && LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(top)) {
      top = level;
      // заголовок как он написан в журнале, только без уточнения: значок
      // дописывать за автора нельзя — искать он будет свою строку
      winner = section.replace(HEADING_SUFFIX, '').trim();
    }
  }

  return {
    level: top === 'breaking' ? levelForBreaking(version) : top,
    // подписывается победивший заголовок, а не уровень: разработчик пойдёт
    // искать в журнале именно его
    reason: winner ? `### ${winner}` : 'без ### Added и ### ⚠️ Breaking',
  };
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
