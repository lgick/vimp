import fs from 'node:fs';
import path from 'node:path';
import { checkPluginCompatibility } from '../lib/gamePlugin.js';

// Структурная проверка распакованного dist/ игрового пакета (направление
// master-game-registry). Игровой код НЕ импортируется и не исполняется:
// полный vimp-contract поднимает обе половины плагина живыми модулями, а
// vimp-sim исполняет wasm-ядро — для пакета из npm это исполнение
// недоверенного кода в процессе мастера. Оба остаются инструментами
// разработчика и его CI.
//
// Эталон проверок — devtools/contract/rules/a6-manifest.js; он скопирован по
// смыслу, а не импортирован: devtools/ не попадает в прод-образ и не должен
// туда попасть.
//
// В тарболле лежит только dist/ (files: ["dist"]), поэтому проверять здесь
// можно ровно то, что доехало до диска: манифест, entries, карты и форму
// комнаты.

const ENTRIES = ['client', 'host', 'wasm'];

/**
 * Структурная проверка распакованного dist/ игрового пакета.
 * @param {string} distDir - Каталог с содержимым package/dist.
 * @param {Object} options - Ожидания вызывающего.
 * @param {string} options.id - Идентификатор игры в каталоге мастера.
 * @returns {{ok: boolean, manifest: Object|null, compat: Object|null,
 *   errors: string[]}} Вердикт. Проверки не прерываются на первой ошибке —
 *   разработчику нужен полный список.
 */
export function checkGamePackage(distDir, { id }) {
  const errors = [];
  let manifest;

  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'),
    );
  } catch (err) {
    return {
      ok: false,
      manifest: null,
      compat: null,
      errors: [`dist/manifest.json is unreadable: ${err.message}`],
    };
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return {
      ok: false,
      manifest: null,
      compat: null,
      errors: ['dist/manifest.json: expected an object'],
    };
  }

  // статик-маунт мастера раздаёт dist/ по id каталога — при расхождении с
  // manifest.id он бьёт мимо (тот же инвариант, что в GameCatalog)
  if (manifest.id !== id) {
    errors.push(
      `manifest.id "${manifest.id}" does not match the requested "${id}"`,
    );
  }

  if (!Number.isInteger(manifest.engineApi)) {
    errors.push('manifest.engineApi: expected an integer');
  }

  for (const field of ['title', 'version']) {
    if (typeof manifest[field] !== 'string' || manifest[field] === '') {
      errors.push(`manifest.${field}: expected a non-empty string`);
    }
  }

  const { assetsBase } = manifest;

  if (typeof assetsBase !== 'string' || !assetsBase.endsWith('/')) {
    errors.push('manifest.assetsBase: expected a string ending with "/"');
  }

  checkEntries(manifest, distDir, errors);
  checkMaps(manifest, distDir, errors);
  checkRoomForm(manifest, errors);

  // несовместимость по requires — не ошибка пакета, а признак «движок
  // старый»: она едет отдельным полем, чтобы админ видел разницу между
  // «игра сломана» и «обновите движок»
  const compat = checkPluginCompatibility(manifest);

  return { ok: errors.length === 0, manifest, compat, errors };
}

function checkEntries(manifest, distDir, errors) {
  const entries = manifest.entries ?? {};

  for (const name of ENTRIES) {
    if (typeof entries[name] !== 'string' || entries[name] === '') {
      errors.push(`manifest.entries.${name}: not declared`);
    }
  }

  for (const [name, entry] of Object.entries(entries)) {
    if (typeof entry !== 'string' || entry === '') {
      continue;
    }

    // wasmNode публикуется как есть (docs/ai/02-packaging.md): это
    // относительный путь внутрь dist/, а не адрес на origin мастера
    if (name === 'wasmNode' && /^[a-z][a-z\d+.-]*:|^\/\//i.test(entry)) {
      errors.push(
        `manifest.entries.wasmNode ("${entry}"): expected a relative path ` +
          'inside dist/, not a URL',
      );
      continue;
    }

    const rel =
      name === 'wasmNode' ? entry : stripBase(entry, manifest.assetsBase);
    const inside = path
      .normalize(rel)
      .replace(/^\.\//, '')
      .replaceAll(path.sep, '/');

    if (inside.startsWith('../') || path.isAbsolute(inside)) {
      errors.push(
        `manifest.entries.${name} ("${entry}") points outside dist/ — ` +
          'only dist/ is published',
      );
      continue;
    }

    if (!fs.existsSync(path.join(distDir, inside))) {
      errors.push(`manifest.entries.${name} ("${entry}") is missing from dist/`);
    }
  }
}

function checkMaps(manifest, distDir, errors) {
  const list = manifest.maps?.list;

  if (!Array.isArray(list) || list.length === 0) {
    errors.push('manifest.maps.list: expected a non-empty array of map names');

    return;
  }

  for (const name of list) {
    if (typeof name !== 'string' || name === '') {
      errors.push('manifest.maps.list: a map name must be a non-empty string');
      continue;
    }

    if (!fs.existsSync(path.join(distDir, 'maps', `${name}.json`))) {
      errors.push(`map "${name}" is declared, but dist/maps/${name}.json is missing`);
    }
  }
}

function checkRoomForm(manifest, errors) {
  const roomForm = manifest.roomForm ?? [];
  const defaults = manifest.roomDefaults ?? {};

  if (!Array.isArray(roomForm)) {
    errors.push('manifest.roomForm: expected an array of fields');

    return;
  }

  for (const field of roomForm) {
    // источник значения бывает и вне roomDefaults: select по картам
    // засеивается списком карт манифеста
    if (defaults[field?.name] === undefined && field?.source !== 'maps') {
      errors.push(
        `roomForm field "${field?.name}" has no value in roomDefaults`,
      );
    }
  }
}

function stripBase(entry, assetsBase) {
  if (assetsBase && entry.startsWith(assetsBase)) {
    return entry.slice(assetsBase.length);
  }

  return entry.replace(/^\/+/, '');
}
