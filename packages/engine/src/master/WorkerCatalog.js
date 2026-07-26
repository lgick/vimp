import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Каталог worker-бандла хоста (Этап 5.2): версия кода комнаты для эстафеты
// Worker'ов. Сканирует собранные ассеты на host.worker-<hash>.js; version —
// хеш содержимого (по образцу MapCatalog). Хост сверяет её с codeVersion из
// host_registered и при расхождении скачивает бандл по url из манифеста и
// заменяет Worker эстафетой без разрыва P2P-соединений.
export default class WorkerCatalog {
  /**
   * @param {string|null} assetsDir - директория собранных ассетов
   *   (dist/assets); null или отсутствующая директория — каталог пуст
   *   (dev: Worker раздаёт Vite из исходников, обновлений нет).
   */
  constructor(assetsDir) {
    this._version = null;
    this._url = null;

    const file = assetsDir ? this._findBundle(assetsDir) : null;

    if (file) {
      const content = fs.readFileSync(path.join(assetsDir, file));

      this._version = createHash('sha256')
        .update(content)
        .digest('hex')
        .slice(0, 16);
      this._url = `/assets/${file}`;
    }

    this._manifest = JSON.stringify({
      version: this._version,
      url: this._url,
    });
  }

  // имя файла worker-бандла; несколько (грязный dist) — новейший по mtime
  _findBundle(assetsDir) {
    let files;

    try {
      files = fs
        .readdirSync(assetsDir)
        .filter(name => /^host\.worker-.+\.js$/.test(name));
    } catch (err) {
      return null;
    }

    if (files.length > 1) {
      console.warn(`[worker catalog] multiple bundles found: ${files.join(', ')}`);

      files.sort(
        (a, b) =>
          fs.statSync(path.join(assetsDir, b)).mtimeMs -
          fs.statSync(path.join(assetsDir, a)).mtimeMs,
      );
    }

    return files[0] || null;
  }

  get version() {
    return this._version;
  }

  // манифест — готовая JSON-строка { version, url }
  get manifest() {
    return this._manifest;
  }
}
