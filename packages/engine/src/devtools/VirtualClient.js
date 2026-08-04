import { buildClientCoreConfig } from '../lib/clientCoreConfig.js';
import { buildSnapshotKeysById, parseHot } from '../lib/reconstructHot.js';
import { HOT_FLAGS } from '../config/opcodes.js';

// Клиент без браузера: настоящее клиентское ядро игры, которое кормится
// реальными байтами кадров, отправленными хостом. Замыкает контур
// «хост → бинарный кадр → ClientCore → hot-буфер → сцена в JSON» в одном
// процессе — без этого отказы тира 1–2 (сущность не спавнится, поля схемы
// перепутаны, панель не обновляется) не видны нигде, кроме чёрного холста.
//
// Рендер-конвейер повторяет client/main.js:renderTick, но hot читается через
// hot_values() (копия), а не hot_ptr()+память WASM: в Node нет смысла в
// zero-copy, а копия не детачится при росте памяти ядра.

// предел числа сохраняемых однотипных нарушений (дальше только счётчик)
const NOTE_LIMIT = 20;

class VirtualClient {
  /**
   * @param {Object} params
   * @param {Object} params.clientPlugin - ClientPlugin игры.
   * @param {Object} params.clientConfig - CONFIG_DATA хоста.
   * @param {string} [params.wasmUrl] - Путь к клиентскому ядру (node-сборка).
   * @param {string} params.socketId
   * @param {number} params.gameId
   * @param {Object} [params.auth] - Данные авторизации участника
   *   ({ name, model }) — то же, что уходит хосту в createUser.
   * @param {Object} [params.divergence] - Пороги детектора рассинхрона
   *   предикта (thresholds/defaultThreshold/capacity); undefined — детектор
   *   выключен, как в боевом конфиге.
   * @returns {Promise<VirtualClient>}
   */
  static async create({
    clientPlugin,
    clientConfig,
    wasmUrl,
    socketId,
    gameId,
    auth,
    divergence,
  }) {
    const { core } = await clientPlugin.createClientCore(
      JSON.stringify(buildClientCoreConfig(clientConfig, { divergence })),
      { wasmUrl },
    );

    const client = new VirtualClient({
      core,
      clientConfig,
      socketId,
      gameId,
      clientPlugin,
    });

    // игровой хук авторизации (в браузере — publisher 'socket' формы auth):
    // без него ядро не знает модель своего актора, а значит и предикт
    // никогда не включается
    if (auth) {
      clientPlugin.hooks?.onAuth?.(core, auth);
    }

    return client;
  }

  constructor({ core, clientConfig, socketId, gameId, clientPlugin }) {
    this.socketId = socketId;
    this.gameId = gameId;
    this.core = core;

    this._plugin = clientPlugin;

    this._snapshotKeysById = buildSnapshotKeysById(clientConfig.snapshot);
    this._gameSets = clientConfig.parts.gameSets;
    this._entitiesOnCanvas = clientConfig.parts.entitiesOnCanvas;

    // накопленная сцена: ключ схемы → id → поля (то, что в браузере ушло бы
    // в parts через Factory)
    this.scene = {};
    this.camera = null;

    // всё, что приехало по не-кадровым портам — материал для проверок
    // инвариантов (этап 3) и для отчёта
    this.received = {
      panel: [],
      stat: [],
      chat: [],
      vote: [],
      keySet: [],
      gameInform: [],
      soundCue: [],
      roundEnd: [],
      techInform: [],
    };

    this.frameCount = 0;
    this.decodeErrors = [];

    // материал проверок инвариантов (devtools/invariants.js): что реально
    // доехало до сцены за весь прогон, а не только к финальному тику —
    // сущность могла появиться и исчезнуть между дампами
    this.observed = {}; // ключ схемы → { rows, ids: Set, widths: Set }
    this.nonFinite = []; // NaN/Infinity в декодированных полях и hot-буфере
    this.hotLayoutErrors = []; // расхождение len ↔ пройденного куска буфера

    // расхождение предикта с авторитетным состоянием (этап 5): записи ядра
    // и накопительные агрегаты; null в stats — детектор выключен или ядро
    // игры собрано против движка без него
    this.divergence = [];
    this.divergenceStats = null;

    // нарушение обычно повторяется каждый тик: в отчёте нужны первые
    // экземпляры и счётчик, а не сотня одинаковых строк
    this.truncated = { nonFinite: 0, hotLayoutErrors: 0, divergence: 0 };
  }

  // байты кадра из sendShot — ровно то, что ушло бы в data channel
  pushFrame(bytes, localNow) {
    const data = toUint8(bytes);

    try {
      this.core.push_frame(data, localNow);
      this.frameCount += 1;
    } catch (e) {
      this.decodeErrors.push({ localNow, message: String(e) });
    }
  }

  // не-кадровые порты (панель, статистика, чат, keyset…). Порты, которые в
  // браузере доходят до ядра (main.js), доводятся и здесь — иначе headless
  // гоняет ядро в режиме, которого в игре не бывает.
  record(kind, data) {
    if (this.received[kind]) {
      this.received[kind].push(data);
    }

    if (kind === 'panel') {
      this._plugin?.hooks?.onPanel?.(this.core, data);
    } else if (kind === 'keySet') {
      // keySet 1 — играющий, иначе спектатор (предикт выключается)
      this.core.set_active?.(data === 1);
    }
  }

  /**
   * MAP_DATA: мир raycast в ядре и сброс предикта — зеркало main.js.
   * @param {Object} data - Данные карты, как их шлёт хост.
   */
  setMap(data) {
    if (typeof this.core.set_map !== 'function') {
      return;
    }

    try {
      this.core.set_map(
        JSON.stringify({
          map: data.map,
          step: data.step,
          scale: data.scale,
          physicsStatic: data.physicsStatic,
          physicsDynamic: data.physicsDynamic,
        }),
      );
    } catch (e) {
      this.decodeErrors.push({ localNow: null, message: `set_map: ${e}` });
    }
  }

  /**
   * Рендер-тик: зеркало client/main.js:renderTick без PixiJS.
   * @param {number} localNow - Локальное время клиента (мс).
   */
  render(localNow) {
    // записи копятся в ядре на push_frame, поэтому вычерпываются до sample —
    // иначе тик с пустым hot-буфером (ранний выход ниже) их бы потерял
    this._drainDivergence();

    const len = this.core.sample(localNow);

    if (!len) {
      return;
    }

    const hot = this.core.hot_values();
    const flags = hot[0];

    for (let i = 0; i < len; i += 1) {
      if (!Number.isFinite(hot[i])) {
        this._note('nonFinite', {
          key: 'hot',
          id: 'buffer',
          index: i,
          value: String(hot[i]),
        });
      }
    }

    if (flags & HOT_FLAGS.FRAMES) {
      for (const frame of JSON.parse(this.core.take_frames())) {
        this._applyGameData(frame.game);

        if (frame.camera && frame.camera !== 0) {
          this.camera = [frame.camera[0], frame.camera[1]];
        }
      }
    }

    if (flags & (HOT_FLAGS.GAME | HOT_FLAGS.PREDICTED)) {
      let parsed;

      try {
        parsed = parseHot(hot, this._snapshotKeysById);
      } catch (e) {
        this._note('hotLayoutErrors', { len, message: String(e) });
        return;
      }

      // раскладку буфера диктует схема игры: разошлась ширина записи или
      // порядок групп — обход упрётся не в конец буфера
      if (parsed.consumed !== len) {
        this._note('hotLayoutErrors', { len, consumed: parsed.consumed });
      }

      this._applyGameData(parsed.game);
    }

    if (flags & HOT_FLAGS.CAMERA) {
      this.camera = [hot[1], hot[2]];
    }
  }

  /**
   * Дамп клиентского ядра (сетевой буфер, окно seq, оффсет) — зеркало
   * серверного `debug_json`. null, если ядро игры собрано против движка
   * без этого метода.
   * @returns {Object|null}
   */
  debug() {
    if (typeof this.core.debug_json !== 'function') {
      return null;
    }

    return JSON.parse(this.core.debug_json());
  }

  // Записи детектора рассинхрона предикта из ядра. Агрегаты накопительные,
  // поэтому просто перезаписываются; записи — вычерпываются.
  _drainDivergence() {
    if (typeof this.core.take_divergence !== 'function') {
      return;
    }

    const dump = JSON.parse(this.core.take_divergence());

    if (!dump) {
      return;
    }

    const { records = [], ...stats } = dump;

    this.divergenceStats = stats;

    for (const record of records) {
      this._note('divergence', record);
    }
  }

  // Срез сцены для дампа и для дифа между тиками. Копия обязательна: сцена
  // живая, и срез по ссылке «догонял» бы последующие тики — все дампы вышли
  // бы одинаковыми.
  snapshot() {
    return {
      socketId: this.socketId,
      gameId: this.gameId,
      camera: this.camera ? [...this.camera] : null,
      frameCount: this.frameCount,
      entities: structuredClone(this.scene),
      debug: this.debug(),
      // накопительные агрегаты дрейфа предикта на момент среза
      divergence: this.divergenceStats,
    };
  }

  // зеркало applyGameData клиента: ключ схемы → parts через gameSets;
  // отсутствие ключа в gameSets — это и есть «чёрный холст», поэтому
  // фиксируется, а не игнорируется
  _applyGameData(game) {
    for (const [key, instances] of Object.entries(game)) {
      const names = this._gameSets[key];

      if (!names) {
        this.decodeErrors.push({
          message: `snapshot key '${key}' is missing from parts.gameSets`,
        });
        continue;
      }

      for (const name of names) {
        if (!this._entitiesOnCanvas[name]) {
          this.decodeErrors.push({
            message: `part '${name}' is missing from parts.entitiesOnCanvas`,
          });
        }
      }

      const bucket = (this.scene[key] ??= {});
      const seen = (this.observed[key] ??= {
        rows: 0,
        ids: new Set(),
        widths: new Set(),
      });

      for (const [id, fields] of Object.entries(instances)) {
        if (fields === null) {
          delete bucket[id];
          continue;
        }

        bucket[id] = fields;
        seen.rows += 1;
        seen.ids.add(String(id));
        seen.widths.add(Array.isArray(fields) ? fields.length : -1);

        this._checkFinite(key, id, fields);
      }
    }
  }

  // NaN/Infinity в поле — самый тихий из отказов: холст просто перестаёт
  // рисовать сущность, ошибки нет нигде
  _checkFinite(key, id, fields) {
    const values = Array.isArray(fields) ? fields : [fields];

    values.forEach((value, index) => {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        this._note('nonFinite', {
          key,
          id: String(id),
          index,
          value: String(value),
        });
      }
    });
  }

  _note(name, entry) {
    if (this[name].length < NOTE_LIMIT) {
      this[name].push(entry);
    } else {
      this.truncated[name] += 1;
    }
  }
}

// кадр приходит как ArrayBuffer (боевой транспорт) либо Uint8Array (ядро)
function toUint8(bytes) {
  if (bytes instanceof Uint8Array) {
    return bytes;
  }

  return new Uint8Array(bytes);
}

export default VirtualClient;
