import path from 'node:path';
import { ERROR, skip, verdict } from '../result.js';

// dist/manifest.json — единственное, что мастер читает о собранной игре.
// Расхождение id или битая ссылка в entries не ломает сборку: игра просто
// не появляется в лобби (мастер пропускает её с console.warn).
// entries.wasmNode обязан указывать внутрь dist/ — публикуется только он.
export default {
  id: 'A6',
  name: 'manifestShape',
  level: ERROR,
  title: 'dist/manifest.json: id, entries on disk, roomDefaults coverage',

  check(ctx) {
    if (!ctx.manifest) {
      return skip('not built — no dist/manifest.json');
    }

    const { manifest } = ctx;
    const violations = [];

    for (const [half, plugin] of [
      ['host', ctx.hostPlugin],
      ['client', ctx.clientPlugin],
    ]) {
      if (plugin && plugin.id !== manifest.id) {
        violations.push(
          `manifest id "${manifest.id}" differs from the ${half} plugin id ` +
            `"${plugin.id}"`,
        );
      }
    }

    for (const [name, entry] of Object.entries(manifest.entries ?? {})) {
      const rel =
        name === 'wasmNode' ? entry : stripBase(entry, manifest.assetsBase);
      const inside = path
        .normalize(rel)
        .replace(/^\.\//, '')
        .replaceAll(path.sep, '/');

      if (inside.startsWith('../')) {
        violations.push(
          `entries.${name} points outside dist/ ("${entry}") — only dist/ ` +
            'is published',
        );
        continue;
      }

      if (!ctx.distFiles?.has(inside)) {
        violations.push(`entries.${name} ("${entry}") is not in dist/`);
      }
    }

    const roomForm = manifest.roomForm ?? [];
    const defaults = manifest.roomDefaults ?? {};

    for (const field of roomForm) {
      // источник значения у поля бывает и вне roomDefaults: select по картам
      // засеивается списком карт манифеста
      if (defaults[field.name] === undefined && field.source !== 'maps') {
        violations.push(
          `roomForm field "${field.name}" has no roomDefaults value`,
        );
      }
    }

    return verdict(violations);
  },
};

function stripBase(entry, assetsBase) {
  if (assetsBase && entry.startsWith(assetsBase)) {
    return entry.slice(assetsBase.length);
  }

  return entry.replace(/^\/+/, '');
}
