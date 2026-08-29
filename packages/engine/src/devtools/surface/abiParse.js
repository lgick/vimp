// Разбор `core/src/abi.rs` — единственный раздел слепка плагинной
// поверхности, который нельзя собрать импортом: методы wasm-ABI живут внутри
// `macro_rules!`, раскрывающихся уже в крейте игры. Слепок читает файл как
// текст и вытаскивает имена и нормализованные сигнатуры `pub fn`.
//
// Разбор обязан ПАДАТЬ, а не возвращать пустоту: молчаливо пустой раздел
// слепка пропустит любое нарушение И1/И3 (plan/plugin-forward-compat).

// имя макроса → раздел слепка (`abi.game` / `abi.client`)
const MACRO_SECTIONS = {
  // имена макросов Rust — строками: camelCase к ним неприменим
  'export_game_core_abi': 'game',
  'export_client_core_abi': 'client',
};

/**
 * @param {string} source - Содержимое `core/src/abi.rs`.
 * @returns {{game: Object[], client: Object[]}} Методы ABI по разделам,
 *   каждый — { name, args, ret }, отсортированные по имени.
 */
export function parseAbi(source) {
  const blocks = splitMacros(source);

  if (blocks.length === 0) {
    throw new Error(
      'abiParse: no macro_rules! block found in core/src/abi.rs — the file ' +
        'was restructured; fix the parser instead of letting the surface ' +
        'snapshot go silently empty',
    );
  }

  const sections = {};

  for (const block of blocks) {
    const section = MACRO_SECTIONS[block.macro];

    if (!section) {
      continue; // макрос вне ABI плагина — не часть поверхности
    }

    const methods = parseMethods(block.body);

    if (methods.length === 0) {
      throw new Error(
        `abiParse: macro_rules! ${block.macro} yielded no "pub fn" — the ` +
          'file was restructured; fix the parser',
      );
    }

    sections[section] = methods.sort((a, b) => a.name.localeCompare(b.name));
  }

  for (const [macro, section] of Object.entries(MACRO_SECTIONS)) {
    if (!sections[section]) {
      throw new Error(
        `abiParse: macro_rules! ${macro} not found in core/src/abi.rs`,
      );
    }
  }

  return sections;
}

// тело каждого `macro_rules! <name> { … }` — от имени до парной скобке
function splitMacros(source) {
  const re = /macro_rules!\s+([a-z_0-9]+)\s*\{/g;
  const blocks = [];
  let match;

  while ((match = re.exec(source)) !== null) {
    const open = re.lastIndex - 1;
    const close = matchBrace(source, open, '{', '}');

    blocks.push({
      macro: match[1],
      body: source.slice(open + 1, close),
    });
  }

  return blocks;
}

// `pub fn name(args) -> ret` внутри тела макроса; тело метода пропускается
function parseMethods(body) {
  const re = /pub\s+fn\s+([a-z_0-9]+)\s*\(/g;
  const methods = [];
  let match;

  while ((match = re.exec(body)) !== null) {
    const open = re.lastIndex - 1;
    const close = matchBrace(body, open, '(', ')');
    const tail = body.slice(close + 1);
    const arrow = /^\s*->([^{;]+)/.exec(tail);

    methods.push({
      name: match[1],
      args: splitArgs(body.slice(open + 1, close)).map(normalizeType),
      ret: arrow ? normalizeType(arrow[1]) : '()',
    });
  }

  return methods;
}

// индекс скобки, парной открывающей на позиции `open`
function matchBrace(source, open, openChar, closeChar) {
  let depth = 0;

  for (let i = open; i < source.length; i += 1) {
    if (source[i] === openChar) {
      depth += 1;
    } else if (source[i] === closeChar) {
      depth -= 1;

      if (depth === 0) {
        return i;
      }
    }
  }

  throw new Error(`abiParse: unbalanced ${openChar} at offset ${open}`);
}

// список аргументов по запятым верхнего уровня; получатель (`&self`,
// `&mut self`) в сигнатуру не входит — он не часть бинарного контракта
function splitArgs(list) {
  const args = [];
  let depth = 0;
  let current = '';

  for (const ch of list) {
    if (ch === '<' || ch === '(' || ch === '[') {
      depth += 1;
    } else if (ch === '>' || ch === ')' || ch === ']') {
      depth -= 1;
    }

    if (ch === ',' && depth === 0) {
      args.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  args.push(current);

  return args
    .map(arg => arg.trim())
    .filter(arg => arg.length > 0 && !/^&?\s*(mut\s+)?self$/.test(arg))
    .map(arg => {
      const colon = arg.indexOf(':');

      // аргумент без имени в этих макросах не встречается: имя есть всегда
      return colon === -1 ? arg : arg.slice(colon + 1);
    });
}

// Стабильная строка типа: меняется тогда и только тогда, когда меняется
// бинарный контракт. Ссылка/`mut`/пробелы/путь до wasm-bindgen на него не
// влияют; `Result<T, JsError>` сворачивается в `Result<T>` — вариант ошибки
// у всех методов один.
function normalizeType(type) {
  const flat = type
    .replaceAll('::wasm_bindgen::', '')
    .replaceAll('wasm_bindgen::', '')
    .replace(/\bmut\b/g, '')
    .replaceAll('&', '')
    .replace(/\s+/g, '');

  return flat.replace(/^Result<(.*),JsError>$/, 'Result<$1>');
}

export default parseAbi;
