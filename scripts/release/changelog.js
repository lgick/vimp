import { levelForBreaking } from './semver.js';

// Разбор и датирование журналов Keep a Changelog (packages/engine/CHANGELOG.md
// и packages/engine/core/CHANGELOG.md). Формат заголовка релиза в обоих
// файлах — `## [X.Y.Z] — YYYY-MM-DD` с длинным тире, ссылки внизу файла.

const EM_DASH = '—';
const UNRELEASED_HEADING = /^##\s+\[Unreleased\]\s*$/;
const RELEASE_HEADING = /^##\s+\[\d+\.\d+\.\d+\]/;
const SUB_HEADING = /^###\s+(.*)$/;
const LINK_REF = /^\[\d+\.\d+\.\d+\]:\s/;

// Секция [Unreleased]: её текст, список под-заголовков и признак пустоты.
export function parseUnreleased(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => UNRELEASED_HEADING.test(line));

  if (start === -1) {
    return { present: false, sections: [], body: '', isEmpty: true };
  }

  let end = lines.length;

  for (let index = start + 1; index < lines.length; index += 1) {
    if (RELEASE_HEADING.test(lines[index])) {
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

function isBreaking(section) {
  return /^(⚠️\s*)?Breaking/i.test(section.replace(/^⚠️?\s*/, ''));
}

// Предложение инкремента по содержимому [Unreleased]:
//   ⚠️ Breaking → minor для 0.x / major для >=1.0
//   Added       → minor
//   иначе       → patch
export function suggestLevel(sections, version) {
  if (sections.some(isBreaking)) {
    return { level: levelForBreaking(version), reason: '### ⚠️ Breaking' };
  }

  if (sections.some(section => /^Added\b/i.test(section))) {
    return { level: 'minor', reason: '### Added' };
  }

  return { level: 'patch', reason: 'только Changed/Fixed/Removed' };
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

  lines[headingIndex] = `## [${version}] ${EM_DASH} ${date}`;

  const linkLine = releaseLink(repoUrl, artifact, version);
  const firstLinkIndex = lines.findIndex(line => LINK_REF.test(line));

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
