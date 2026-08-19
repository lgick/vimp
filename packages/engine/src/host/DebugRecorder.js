import clock from '../lib/clock.js';

// Рекордер живого матча (этап 6 плана plan/done/ai-debug): пишет то, что headless
// не воспроизводит — реальный WebRTC, PixiJS и живой ввод человека — ровно в
// формат сценария headless-runner'а (devtools/ScenarioRunner.js). Баг,
// пойманный человеком в браузере, догоняется потом `npm run sim:replay`
// без браузера и без человека.
//
// Worker-safe: только clock (Date/performance), никаких Node-глобалов.
// Включается флагом gameConfig.isDevMode — в проде HostGame его не создаёт.

// Кап записи: живой матч на 120 Гц за десять минут — 72k тиков, и без
// границы вкладка хоста платила бы памятью за бесконечную ленту. Переполнение
// не молчит: счётчики уезжают в meta сценария.
const DEFAULT_LIMITS = {
  maxOps: 20000,
  maxDtSamples: 4000,
};

export default class DebugRecorder {
  /**
   * @param {Object} [limits]
   * @param {number} [limits.maxOps] - Предел операций таймлайна.
   * @param {number} [limits.maxDtSamples] - Предел записанных шагов цикла.
   */
  constructor(limits = {}) {
    this._limits = { ...DEFAULT_LIMITS, ...limits };
    this._reset();
  }

  get isRecording() {
    return this._recording;
  }

  // номер тика с начала записи: сценарий адресует ввод именно границей тика
  // (очереди у HostGame нет, updateKeys применяется синхронно)
  get tickCount() {
    return this._tick;
  }

  /**
   * Начинает запись. Уже вошедшие участники превращаются в join-операции
   * нулевого тика — иначе реплей стартовал бы с пустой комнатой.
   * @param {Object} params
   * @param {number|null} params.seed - Seed мира (room.seed / 'ready').
   * @param {string} params.map - Текущая карта.
   * @param {number} [params.networkSendRate] - Частота отправки кадров.
   * @param {Array} [params.participants] - [{ gameId, name, model, socketId,
   *   team }] — люди, уже находящиеся в комнате.
   */
  start({ seed = null, map = null, networkSendRate = null, participants = [] }) {
    this._reset();

    this._recording = true;
    this._seed = seed;
    this._map = map;
    this._networkSendRate = networkSendRate;
    this._startedAt = clock.now();

    for (const participant of participants) {
      this.noteJoin(participant);
    }
  }

  // шаг игрового цикла: номер тика — единственная временная координата
  // сценария, dt пишется справочно (runner крутит фиксированный timeStep)
  tick(dt) {
    if (!this._recording) {
      return;
    }

    this._tick += 1;

    if (this._dt.length < this._limits.maxDtSamples) {
      this._dt.push(dt);
    } else {
      this._droppedDt += 1;
    }
  }

  /**
   * Вход участника. Идентификатор сценария выдаётся свой (p1, p2, …):
   * gameId переиспользуется после выхода, и два разных человека получили бы
   * в реплее одну запись.
   * @param {Object} participant - { gameId, name, model, socketId, team }.
   */
  noteJoin({ gameId, name, model, socketId, team = null }) {
    if (!this._recording) {
      return;
    }

    const who = `p${this._participants.length + 1}`;

    this._participants.push({ id: who, name, model, socketId });
    this._byGameId.set(gameId, who);

    this._push({ op: 'join', who, ...(team ? { team } : {}) });
  }

  noteLeave(gameId) {
    const who = this._byGameId.get(gameId);

    if (who === undefined) {
      return;
    }

    this._byGameId.delete(gameId);
    this._push({ op: 'leave', who });
  }

  noteKey(gameId, action, name) {
    this._pushFor(gameId, who => ({ op: 'key', who, action, name }));
  }

  noteAim(gameId, x, y, flags) {
    this._pushFor(gameId, who => ({ op: 'aim', who, x, y, flags }));
  }

  noteChat(gameId, text) {
    this._pushFor(gameId, who => ({ op: 'chat', who, text }));
  }

  noteVote(gameId, data) {
    this._pushFor(gameId, who => ({ op: 'vote', who, data }));
  }

  /**
   * Останавливает запись и отдаёт готовый сценарий (parseScenario его
   * принимает как есть).
   * @returns {Object|null} Сценарий или null, если записи не было.
   */
  stop() {
    if (!this._recording) {
      return null;
    }

    const scenario = {
      version: 1,
      seed: this._seed,
      map: this._map,
      // таймеры сценария живут только в config.timers: верхний уровень
      // config — это ключи конфига игры, и раньше запись подсовывала туда
      // таймер в расчёте на неявный роутинг
      config: this._networkSendRate
        ? { timers: { networkSendRate: this._networkSendRate } }
        : {},
      participants: this._participants,
      timeline: this._timeline,
      ticks: this._tick,
      dumpTicks: [this._tick],
      // не поле формата: parseScenario его игнорирует, а человеку/нейросети
      // нужно понимать, откуда взялся файл и не обрезан ли он
      meta: {
        source: 'browser',
        recordedAt: this._startedAt,
        stoppedAt: clock.now(),
        droppedOps: this._droppedOps,
        dt: this._dtStats(),
      },
    };

    this._reset();

    return scenario;
  }

  _reset() {
    this._recording = false;
    this._tick = 0;
    this._seed = null;
    this._map = null;
    this._networkSendRate = null;
    this._startedAt = null;
    this._participants = [];
    this._byGameId = new Map();
    this._timeline = [];
    this._dt = [];
    this._droppedOps = 0;
    this._droppedDt = 0;
  }

  _push(op) {
    if (this._timeline.length >= this._limits.maxOps) {
      this._droppedOps += 1;
      return;
    }

    this._timeline.push({ tick: this._tick, ...op });
  }

  _pushFor(gameId, build) {
    if (!this._recording) {
      return;
    }

    const who = this._byGameId.get(gameId);

    // участник вошёл до старта записи и не попал в participants — операция
    // без адресата сломала бы реплей, поэтому не пишется вовсе
    if (who !== undefined) {
      this._push(build(who));
    }
  }

  _dtStats() {
    const samples = this._dt;

    if (!samples.length) {
      return { count: 0, dropped: this._droppedDt };
    }

    let min = samples[0];
    let max = samples[0];
    let sum = 0;

    for (const value of samples) {
      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
    }

    return {
      count: samples.length,
      dropped: this._droppedDt,
      min,
      max,
      mean: sum / samples.length,
      samples,
    };
  }
}
