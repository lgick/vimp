import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Приёмник выгрузок браузерной половины отладочного контура (этап 6 плана
// plan/ai-debug): вкладка хоста пишет сюда записанный сценарий и дампы, файл
// ложится в тот же `.debug/`, куда пишет headless-runner — нейросеть читает
// оба источника одинаково и гоняет записанное через `npm run sim:replay`.
//
// Маршрут регистрируется только в dev (см. master/main.js): в проде это была
// бы запись на диск по запросу произвольного клиента.

// вид выгрузки → префикс файла. Закрытый список: имя файла собирается из
// пришедших данных, и свободная строка здесь означала бы запись куда угодно
const KINDS = {
  scenario: 'scenario',
  dump: 'dump',
  divergence: 'divergence',
};

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export default class DebugReportStore {
  /**
   * @param {string} rootDir - Корень выгрузок (обычно `.debug`).
   * @param {Object} [options]
   * @param {number} [options.maxBytes] - Предел размера одной выгрузки.
   */
  constructor(rootDir, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this._rootDir = rootDir;
    this._maxBytes = maxBytes;
    this._counter = 0;
  }

  /**
   * Сохраняет выгрузку.
   * @param {Object} body - { kind, payload, note }.
   * @param {Object} [options]
   * @param {string} [options.stamp] - Метка времени в имени файла.
   * @returns {Promise<Object>} { file, bytes } — путь относительно rootDir.
   * @throws {Error} С полем `status` (400/413) — маршрут отдаёт его как код.
   */
  async save(body, { stamp } = {}) {
    if (!body || typeof body !== 'object') {
      throw badRequest('body must be an object');
    }

    const prefix = KINDS[body.kind];

    if (!prefix) {
      throw badRequest(`unknown kind '${body.kind}'`);
    }

    if (body.payload === undefined || body.payload === null) {
      throw badRequest('payload is required');
    }

    const content = `${JSON.stringify(
      {
        kind: body.kind,
        note: typeof body.note === 'string' ? body.note : null,
        receivedAt: new Date().toISOString(),
        payload: body.payload,
      },
      null,
      2,
    )}\n`;

    const bytes = Buffer.byteLength(content);

    if (bytes > this._maxBytes) {
      throw withStatus(
        new Error(`payload too large: ${bytes} > ${this._maxBytes}`),
        413,
      );
    }

    this._counter += 1;

    const runStamp = stamp ?? new Date().toISOString().replace(/[:.]/g, '-');
    const file = `${prefix}-${runStamp}-${this._counter}.json`;

    await mkdir(this._rootDir, { recursive: true });
    await writeFile(path.join(this._rootDir, file), content);

    return { file, bytes };
  }
}

function badRequest(message) {
  return withStatus(new Error(message), 400);
}

function withStatus(error, status) {
  error.status = status;

  return error;
}
