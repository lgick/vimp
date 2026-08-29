import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import wsports from '../../config/wsports.js';
import {
  KNOWN_GAME_CONFIG_PATHS,
  REQUIRED_GAME_CONFIG_PATHS,
} from '../../lib/gameConfigView.js';
import { formControls } from '../../lib/formControls.js';
import { ENGINE_CAPABILITIES } from '../../lib/capabilities.js';
import { clientServices } from '../../config/clientServices.js';
import { abiOps } from '../../config/abiOps.js';
import { SNAPSHOT_FORMAT_VERSION } from '../../config/opcodes.js';
import { parseAbi } from './abiParse.js';

// Слепок плагинной поверхности (этап 1 плана plugin-forward-compat).
// Поверхность — всё, что игра может написать или прочитать: поля gameConfig,
// имена сервисов, контролы форм, номера портов, поля манифеста, члены
// объектов плагина, методы wasm-ABI. Инвариант И1 говорит, что ни одно из
// этих имён не исчезает и не переименовывается, И3 — что форма данных
// (сигнатура ABI, номер порта) не меняется.
//
// Слепок ничего не объявляет сам: каждый раздел собирается из существующего
// модуля движка — импортом там, где имя есть значением, и разбором текста
// там, где его нет (методы внутри `macro_rules!`, поля манифеста, которые
// движок читает точечно). Продублированный руками список устарел бы молча.
//
// Живёт в devtools/, потому что в бандл приложения devtools не попадает
// (граница из CLAUDE.md).

const SRC_DIR = fileURLToPath(new URL('../../', import.meta.url));
const ABI_PATH = fileURLToPath(
  new URL('../../../core/src/abi.rs', import.meta.url),
);

// модули, читающие GameManifest: поля манифеста — их точечные обращения
const MANIFEST_READERS = [
  'master/GameCatalog.js',
  'lib/loadGamePackage.js',
  'lib/gamePlugin.js',
];

/**
 * Собирает поверхность плагинного контракта.
 * @returns {Promise<Object>} JSON-объект слепка (см. contract/surface.json).
 */
export async function collectSurface() {
  const abi = parseAbi(await readFile(ABI_PATH, 'utf8'));
  const sources = await readSources();

  return sortDeep({
    abi,
    // опкоды dispatch: append-only на тех же правилах, что имена (И1) —
    // удаление опкода отнимает возможность, на которую игра уже оперлась
    abiOps: registrySection(abiOps),
    clientPluginMembers: collectMembers(sources, 'clientPlugin'),
    // словари-реестры отдают и активные записи, и выведенные из
    // эксплуатации: вывод алиасом — не удаление (И1), и слепок обязан
    // отличать одно от другого
    clientServices: registrySection(clientServices),
    // возможности движка (этап 5): имя отсюда игра пишет в
    // manifest.requires — исчезнувшее имя отвергает уже опубликованную игру
    // ровно так же, как исчезнувший контрол формы
    engineCapabilities: registrySection(ENGINE_CAPABILITIES),
    formControls: registrySection(formControls),
    // поля gameConfig с умолчаниями (И1): движок читает их через view, а не
    // точечно с плагина, поэтому в hostPluginMembers они уже не видны
    gameConfigFields: [
      ...KNOWN_GAME_CONFIG_PATHS,
      ...REQUIRED_GAME_CONFIG_PATHS,
    ],
    hostPluginMembers: collectMembers(sources, 'hostPlugin'),
    manifestFields: collectManifestFields(sources),
    ports: { server: { ...wsports.server }, client: { ...wsports.client } },
    requiredGameConfig: [...REQUIRED_GAME_CONFIG_PATHS],
    // движковая (не плагинная) величина: плагин её не читает, но смена
    // раскладки кадра разводит хост и клиент разных сборок движка — пусть
    // попадает в diff и меняется осознанно
    snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
  });
}

// запись реестра в слепке: имя плюс механика вывода из эксплуатации.
// `note` не пишем — это пояснение для человека, а не форма данных
function registrySection(registry) {
  return registry.list().map(({ value, since, alias, retiredIn }) => ({
    name: value,
    since,
    ...(alias === undefined ? {} : { alias, retiredIn }),
  }));
}

// текст всех модулей движка без комментариев и строковых литералов: путь
// 'manifest.json' в строке — не чтение поля манифеста, и попади он в слепок,
// раздел жил бы своей жизнью
async function readSources() {
  const files = await listJsFiles(SRC_DIR);
  const sources = new Map();

  for (const file of files) {
    const rel = path.relative(SRC_DIR, file).replaceAll(path.sep, '/');

    sources.set(rel, stripNoise(await readFile(file, 'utf8')));
  }

  return sources;
}

async function listJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    // `_`-префикс — черновики, которые не коммитятся (CLAUDE.md)
    if (entry.name.startsWith('_')) {
      continue;
    }

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listJsFiles(full)));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }

  return files;
}

// комментарии и литералы вырезаются одним проходом, в порядке появления:
// раздельные проходы спаривают апостроф внутри шаблонной строки с чужим
// апострофом и молча съедают код между ними
const NOISE =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;

function stripNoise(source) {
  return source.replace(NOISE, ' ');
}

// имена, которые движок читает с объекта плагина: точечные обращения
// (`hostPlugin.gameConfig`, `clientPlugin.hooks.onAuth`) и деструктуризация
function collectMembers(sources, holder) {
  const names = new Set();

  for (const source of sources.values()) {
    for (const name of readPaths(source, holder)) {
      names.add(name);
    }
  }

  if (names.size === 0) {
    throw new Error(
      `collectSurface: no member of "${holder}" is read anywhere in ` +
        'src/ — the engine was restructured; fix the collector instead of ' +
        'letting the surface snapshot go silently empty',
    );
  }

  return [...names];
}

function collectManifestFields(sources) {
  const names = new Set();

  for (const file of MANIFEST_READERS) {
    const source = sources.get(file);

    if (source === undefined) {
      throw new Error(
        `collectSurface: manifest reader ${file} is gone — the engine was ` +
          'restructured; fix the collector',
      );
    }

    for (const name of readPaths(source, 'manifest')) {
      names.add(name);
    }
  }

  if (names.size === 0) {
    throw new Error(
      'collectSurface: no GameManifest field is read anywhere in ' +
        `${MANIFEST_READERS.join(', ')} — fix the collector`,
    );
  }

  return [...names];
}

// пути, которые модуль читает с объекта `holder`: `holder.a.b` → 'a.b',
// `const { a, b } = holder` → 'a', 'b'
function readPaths(source, holder) {
  const names = [];
  const dotted = new RegExp(
    `\\b${holder}\\??\\.([A-Za-z_$][\\w$]*(?:\\??\\.[A-Za-z_$][\\w$]*)*)`,
    'g',
  );
  let match;

  while ((match = dotted.exec(source)) !== null) {
    names.push(match[1].replaceAll('?.', '.'));
  }

  // ровно `= holder`, а не `= holder.gameConfig`: во втором случае имена
  // принадлежат не плагину, а его конфигу — у того свой раздел слепка
  const destructured = new RegExp(
    `\\{([^{}]*)\\}\\s*=\\s*${holder}(?![\\w$.])`,
    'g',
  );

  while ((match = destructured.exec(source)) !== null) {
    for (const part of match[1].split(',')) {
      const name = part
        .split(':')[0]
        .trim()
        .replace(/^\.\.\./, '');

      if (/^[A-Za-z_$][\w$]*$/.test(name)) {
        names.push(name);
      }
    }
  }

  return names;
}

// списки, порядок которых сам по себе является контрактом: аргументы
// ABI-метода читаются позиционно, и алфавит здесь тихо переписал бы
// сигнатуру
const ORDERED_LISTS = ['args'];

// стабильный порядок: ключи объектов и строковые списки — по алфавиту,
// записи ABI — по имени. Слепок читается диффом, а не глазами
function sortDeep(value, key = null) {
  if (Array.isArray(value)) {
    const items = value.map(item => sortDeep(item));

    if (ORDERED_LISTS.includes(key)) {
      return items;
    }

    return items.every(item => typeof item === 'string')
      ? items.sort()
      : items.sort((a, b) => String(a?.name).localeCompare(String(b?.name)));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(name => [name, sortDeep(value[name], name)]),
    );
  }

  return value;
}

/**
 * Сериализация слепка для записи в contract/surface.json.
 * @param {Object} surface - Результат collectSurface().
 * @returns {string} JSON с отступом 2 и переводом строки в конце.
 */
export function formatSurface(surface) {
  return `${JSON.stringify(sortDeep(surface), null, 2)}\n`;
}

const INVARIANT_1 =
  'Инвариант И1 (plan/plugin-forward-compat/README.md): имя, которое игра\n' +
  'могла написать, существует вечно. Выведи его из эксплуатации алиасом,\n' +
  'а не удалением. Если это осознанный security-фикс — удали строку из\n' +
  'contract/surface.json тем же коммитом и опиши в CHANGELOG под\n' +
  '⚠️ Breaking + Migration.';

const INVARIANT_2 =
  'Инвариант И2 (plan/plugin-forward-compat/README.md): ничто новое не\n' +
  'обязательно. Новое обязательное поле gameConfig отвергает КАЖДУЮ уже\n' +
  'опубликованную игру, которая о нём не знает. Заведи поле в FIELDS\n' +
  'модуля lib/gameConfigView.js с безопасным умолчанием — список REQUIRED\n' +
  'может только сокращаться.';

const INVARIANT_3 =
  'Инвариант И3 (plan/plugin-forward-compat/README.md): форма данных\n' +
  'неизменна — рядом добавляется новая. Уже опубликованная сборка игры\n' +
  'вызывает старую форму и не пересоберётся. Если это осознанный слом —\n' +
  'поправь строку в contract/surface.json тем же коммитом и опиши в\n' +
  'CHANGELOG под ⚠️ Breaking + Migration.';

/**
 * Сравнение закоммиченного слепка с собранным.
 * @param {Object} committed - Слепок из contract/surface.json.
 * @param {Object} collected - Результат collectSurface().
 * @returns {{violations: string[], additions: string[]}} Нарушения И1/И3 и
 *   добавления (добавление поверхности совместимость не ломает).
 */
export function diffSurface(committed, collected) {
  const violations = [];
  const additions = [];

  walk(committed, collected, [], violations, additions);

  return { violations, additions };
}

function walk(before, after, trail, violations, additions) {
  const where = trail.join('.') || 'surface';

  if (Array.isArray(before)) {
    walkList(before, after ?? [], where, violations, additions);
    return;
  }

  if (before !== null && typeof before === 'object') {
    for (const key of Object.keys(before)) {
      if (after?.[key] === undefined) {
        violations.push(`surface: '${key}' исчез из ${where}.\n${INVARIANT_1}`);
        continue;
      }

      walk(before[key], after[key], [...trail, key], violations, additions);
    }

    for (const key of Object.keys(after ?? {})) {
      if (before[key] === undefined) {
        additions.push(`${where}.${key}`);
      }
    }

    return;
  }

  if (before !== after) {
    violations.push(
      `surface: ${where} изменился: ${JSON.stringify(before)} → ` +
        `${JSON.stringify(after)}.\n` +
        (ENGINE_VALUES.has(where) ? ENGINE_VALUE_NOTE : INVARIANT_3),
    );
  }
}

// Движковые величины: плагин их не читает, поэтому И3 к ним не относится —
// но менять их молча всё равно нельзя.
const ENGINE_VALUES = new Set(['snapshotFormatVersion']);

const ENGINE_VALUE_NOTE =
  'Это движковая величина, а не плагинная: игра её не читает и от неё не\n' +
  'зависит. Но раскладка кадра разводит хост и клиент разных сборок\n' +
  'движка — если смена осознанна, поправь contract/surface.json тем же\n' +
  'коммитом и убедись, что расхождение ловит codeVersion.';

// Разделы с инвертированным правилом: у них расширение — это слом, а
// сокращение — норма. Пока такой один: список обязательных полей
// gameConfig (И2).
const SHRINK_ONLY = new Set(['requiredGameConfig']);

// требование, которого раньше не было, отвергает старые игры — а снятое
// требование не ломает никого: правило зеркально общему
function walkShrinkOnly(before, after, where, violations, additions) {
  const known = new Set(before);

  for (const name of after) {
    if (!known.has(name)) {
      violations.push(
        `surface: '${name}' добавлен в ${where}.\n${INVARIANT_2}`,
      );
    }
  }

  const kept = new Set(after);

  for (const name of before) {
    if (!kept.has(name)) {
      additions.push(`${where}: снято требование ${name}`);
    }
  }
}

function walkList(before, after, where, violations, additions) {
  if (SHRINK_ONLY.has(where)) {
    walkShrinkOnly(before, after, where, violations, additions);
    return;
  }

  const key = item => (typeof item === 'string' ? item : item?.name);
  const seen = new Map(after.map(item => [key(item), item]));

  for (const item of before) {
    const name = key(item);
    const found = seen.get(name);

    if (found === undefined) {
      violations.push(`surface: '${name}' исчез из ${where}.\n${INVARIANT_1}`);
      continue;
    }

    if (JSON.stringify(found) !== JSON.stringify(item)) {
      violations.push(
        `surface: сигнатура '${name}' в ${where} изменилась: ` +
          `${JSON.stringify(item)} → ${JSON.stringify(found)}.\n${INVARIANT_3}`,
      );
    }
  }

  const known = new Set(before.map(key));

  for (const item of after) {
    if (!known.has(key(item))) {
      additions.push(`${where}: ${key(item)}`);
    }
  }
}

export default collectSurface;
