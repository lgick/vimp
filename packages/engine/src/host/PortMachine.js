// Хендшейк-машина клиента, вынутая из host.worker.js: автомат по клиентским
// портам 0–10 (см. docs/en/network.md). Изоморфна — ни self, ни postMessage,
// ни DOM: всё, что знает про транспорт, приходит через makeSocket. Поэтому её
// крутит и Worker браузерного хоста, и inline-хост standalone SDK, и
// Node-процесс dedicated-сервера: копий автомата быть не должно, иначе они
// разъедутся ровно так, как разъезжались бы копии createHostRuntime.

import wsports from '../config/wsports.js';
import closeCodes from '../config/closeCodes.js';
import clock from '../lib/clock.js';
import { resumeKeysEqual } from '../lib/resumeKey.js';
import { resolveValidator, validateAuth } from '../lib/validators.js';

// PC (client ports): порты получения данных от клиента
const PC_CONFIG_READY = wsports.client.CONFIG_READY;
const PC_AUTH_RESPONSE = wsports.client.AUTH_RESPONSE;
const PC_MODULES_READY = wsports.client.MODULES_READY;
const PC_MAP_READY = wsports.client.MAP_READY;
const PC_FIRST_SHOT_READY = wsports.client.FIRST_SHOT_READY;
const PC_KEYS_DATA = wsports.client.KEYS_DATA;
const PC_CHAT_DATA = wsports.client.CHAT_DATA;
const PC_VOTE_DATA = wsports.client.VOTE_DATA;
const PC_PONG = wsports.client.PONG;
const PC_RESUME_REQUEST = wsports.client.RESUME_REQUEST;
const PC_LEAVE = wsports.client.LEAVE;

const PORT_COUNT = 11;

// версии формата RESUME_REQUEST, которые понимает хост
const RESUME_VERSION = 1;

// порты игрового состояния (после MODULES_READY, после restore и resume)
const IN_GAME_PORTS = [
  PC_MAP_READY,
  PC_FIRST_SHOT_READY,
  PC_KEYS_DATA,
  PC_CHAT_DATA,
  PC_VOTE_DATA,
  PC_PONG,
  PC_LEAVE,
];

export default class PortMachine {
  /**
   * @param {Object} deps
   * @param {Object} deps.host - HostGame.
   * @param {Object} deps.socketManager - транспорт (per-user send/close).
   * @param {Object} deps.clientCfg - конфиг клиента (порт 0).
   * @param {Object} deps.authSchema - hostPlugin.authSchema.
   * @param {Function} deps.makeSocket - (socketId) => { send, sendBinary, close }.
   * @param {Object} deps.identity - стратегия идентичности (./identity.js).
   * @param {number} [deps.resumeGraceMs] - сколько держать место участника,
   *   чей транспорт оборвался (host-migration этап 4); 0 — снимать сразу
   *   (dedicated, standalone: поведение до этапа 4).
   * @param {number} [deps.resumeRequestTimeoutMs] - сколько ждать
   *   RESUME_REQUEST от возобновляющего соединения.
   */
  constructor({
    host,
    socketManager,
    clientCfg,
    authSchema,
    makeSocket,
    identity,
    resumeGraceMs = 0,
    resumeRequestTimeoutMs = 5000,
  }) {
    this._host = host;
    this._resumeGraceMs = resumeGraceMs > 0 ? resumeGraceMs : 0;
    this._resumeRequestTimeoutMs = resumeRequestTimeoutMs;
    // gameId → таймер истечения ожидания отсоединённого участника
    this._graceTimers = new Map();
    this._socketManager = socketManager;
    this._clientCfg = clientCfg;
    this._authSchema = authSchema;
    this._makeSocket = makeSocket;
    this._identity = identity;

    // поля формы = поля стратегии идентичности + игровые. Один и тот же
    // список уходит клиенту (порт 0) и валидируется на порту 1: гостевой ник
    // доезжает до формы ровно тем же каналом, что игровые поля. Идентичность
    // идёт первой — ник это первое, что заполняет игрок
    this._authParams = [
      ...(identity.params ?? []),
      ...(authSchema.params ?? []),
    ];

    // Правило C10 говорит это статически, но контракт-чекер запускают не
    // все: нерезолвнутое имя валидатора означает поле, которое не проверяет
    // никто (validateAuth пропускает его молча — для клиента это норма)
    for (const { name, options } of this._authParams) {
      if (
        options?.validator &&
        !resolveValidator(options.validator, authSchema.validators)
      ) {
        console.error(
          `PortMachine: authSchema param "${name}" names validator ` +
            `"${options.validator}", which authSchema.validators does not ` +
            'provide — the field is checked by nobody',
        );
      }
    }

    // состояние подключений: socketId → { gameId, methods, enabled }
    this._clients = new Map();
  }

  /**
   * Новое подключение клиента: регистрация сокета и старт хендшейка.
   * @param {string} socketId
   * @param {Object} [opts]
   * @param {boolean} [opts.resume] - переподключение к матчу: CONFIG_DATA
   *   не шлётся, ждём RESUME_REQUEST (только при включённом resumeGraceMs).
   */
  connect(socketId, { resume = false } = {}) {
    if (this._clients.has(socketId)) {
      return;
    }

    this._socketManager.addUser(socketId, this._makeSocket(socketId));

    // место уже занято участником — полнота комнаты его не касается
    if (resume && this._resumeGraceMs > 0) {
      this._connectForResume(socketId);
      return;
    }

    // комната заполнена (люди + боты) — отказ без порт-машины
    // (очереди ожидания легаси-сервера в P2P-комнате нет)
    if (this._host.isFull) {
      // причину доставит close (TECH_INFORM перед close_client)
      this._socketManager.close(socketId, closeCodes.roomFull, 'roomFull', [
        this._host.maxPlayers,
      ]);
      this._socketManager.removeUser(socketId);
      return;
    }

    const state = {
      gameId: undefined,
      enabled: new Array(PORT_COUNT).fill(false),
    };

    this._clients.set(socketId, state);
    state.methods = this._buildPortMethods(socketId, state);

    state.enabled[PC_CONFIG_READY] = true;
    this._socketManager.sendConfig(socketId, this._clientCfg);
  }

  // соединение ждёт RESUME_REQUEST; молчание дольше таймаута — закрыть
  _connectForResume(socketId) {
    const state = {
      gameId: undefined,
      enabled: new Array(PORT_COUNT).fill(false),
      resumeTimer: null,
    };

    this._clients.set(socketId, state);
    state.methods = this._buildPortMethods(socketId, state);
    state.enabled[PC_RESUME_REQUEST] = true;

    state.resumeTimer = clock.setTimeout(() => {
      state.resumeTimer = null;
      this._dropConnection(socketId, closeCodes.handshakeTimeout);
    }, this._resumeRequestTimeoutMs);
  }

  // закрывает соединение без участника (отказ возобновления, таймаут)
  _dropConnection(socketId, code) {
    const state = this._clients.get(socketId);

    if (!state) {
      return;
    }

    this._clearResumeTimer(state);
    this._socketManager.close(socketId, code);
    this._socketManager.removeUser(socketId);
    this._clients.delete(socketId);
  }

  _clearResumeTimer(state) {
    if (state.resumeTimer) {
      clock.clearTimeout(state.resumeTimer);
      state.resumeTimer = null;
    }
  }

  _enableInGame(state) {
    for (const port of IN_GAME_PORTS) {
      state.enabled[port] = true;
    }
  }

  /**
   * Подключение участника, уже восстановленного в HostGame (эстафета
   * Worker'ов, Этап 5.2): порт-машина поднимается сразу в игровом
   * состоянии, хендшейк не повторяется.
   * @param {string} socketId
   * @param {number} gameId
   */
  restore(socketId, gameId) {
    if (this._clients.has(socketId)) {
      return;
    }

    this._socketManager.addUser(socketId, this._makeSocket(socketId));

    const state = {
      gameId,
      enabled: new Array(PORT_COUNT).fill(false),
    };

    state.methods = this._buildPortMethods(socketId, state);
    this._enableInGame(state);

    this._clients.set(socketId, state);
  }

  /**
   * Входящее сообщение клиента (wire-кадр [port, payload] строкой).
   * @param {string} socketId
   * @param {string} data
   */
  message(socketId, data) {
    const state = this._clients.get(socketId);

    if (!state) {
      return;
    }

    let msg;

    try {
      msg = JSON.parse(data);
    } catch (e) {
      return;
    }

    if (msg && state.enabled[msg[0]]) {
      state.methods[msg[0]](msg[1]);
    }
  }

  /**
   * Отключение клиента: снятие участника и чистка транспорта.
   * @param {string} socketId
   */
  disconnect(socketId) {
    const state = this._clients.get(socketId);

    if (!state) {
      return;
    }

    this._clearResumeTimer(state);
    this._socketManager.removeUser(socketId);
    this._clients.delete(socketId);

    if (state.gameId === undefined) {
      return;
    }

    // обрыв без LEAVE (host-migration этап 4): место держится resumeGraceMs,
    // если участнику есть куда вернуться (он вошёл в матч и получил ключ)
    if (this._resumeGraceMs > 0 && this._host.detachUser(state.gameId)) {
      this._startGrace(state.gameId);
      return;
    }

    this._host.removeUser(state.gameId);
  }

  // ожидание возврата отсоединённого участника; не дождались — снять
  _startGrace(gameId) {
    this._stopGrace(gameId);

    this._graceTimers.set(
      gameId,
      clock.setTimeout(() => {
        this._graceTimers.delete(gameId);

        if (this._host.isDetached(gameId)) {
          this._host.removeUser(gameId);
        }
      }, this._resumeGraceMs),
    );
  }

  /**
   * Ожидание возврата людей, поднятых из контрольной точки отсоединёнными
   * (host-migration этап 7.4): у них не было обрыва на этом хосте, и
   * таймер им никто не заводил — не вернувшийся занимал бы слот вечно.
   * Отсчёт — со старта восстановленного матча.
   * @param {Iterable<number>} gameIds
   */
  startGraceFor(gameIds) {
    for (const gameId of gameIds) {
      if (!this._host.isDetached(gameId) || this._graceTimers.has(gameId)) {
        continue;
      }

      if (this._resumeGraceMs > 0) {
        this._startGrace(gameId);
      } else {
        this._host.removeUser(gameId);
      }
    }
  }

  _stopGrace(gameId) {
    const timer = this._graceTimers.get(gameId);

    if (timer) {
      clock.clearTimeout(timer);
      this._graceTimers.delete(gameId);
    }
  }

  // RESUME_REQUEST { v, gameId, resumeKey, token }: проверки по порядку —
  // версия формата, место (существует, ключ совпал), личность по токену
  _resume(socketId, state, data) {
    const reject = reason => {
      if (!this._clients.has(socketId)) {
        return;
      }

      this._socketManager.sendResumeResult(socketId, { ok: false, reason });
      this._dropConnection(socketId);
    };

    if (!data || typeof data !== 'object' || data.v !== RESUME_VERSION) {
      reject('version');
      return;
    }

    const { gameId } = data;
    const target = this._host.getResumeTarget(gameId);

    // неизвестный участник и чужой ключ неразличимы снаружи: перебором
    // gameId нельзя узнать, чьё место существует
    if (!target || !resumeKeysEqual(data.resumeKey, target.resumeKey)) {
      reject('unknown');
      return;
    }

    this._identity
      .resolve(data, socketId)
      .then(name => {
        // клиент отключился, пока проверялась личность
        if (!this._clients.has(socketId)) {
          return;
        }

        if (name !== target.identityName) {
          reject('auth');
          return;
        }

        // место могли снять, пока проверялась личность (истекло ожидание)
        const current = this._host.getResumeTarget(gameId);

        if (!current || !resumeKeysEqual(data.resumeKey, current.resumeKey)) {
          reject('unknown');
          return;
        }

        this._takeOver(gameId, socketId);
        this._clearResumeTimer(state);
        this._stopGrace(gameId);

        state.gameId = gameId;
        state.enabled[PC_RESUME_REQUEST] = false;
        this._enableInGame(state);

        this._host.resumeUser(gameId, socketId, data.token);
      })
      .catch(() => reject('auth'));
  }

  // перехват полуоткрытой сессии: участник ещё числится за прежним
  // соединением (обрыв, которого хост не заметил) — закрыть его, не снимая
  // участника; его поздний disconnect уже ничего не найдёт
  _takeOver(gameId, socketId) {
    for (const [otherId, other] of this._clients) {
      if (otherId !== socketId && other.gameId === gameId) {
        this._clients.delete(otherId);
        this._clearResumeTimer(other);
        this._socketManager.close(otherId);
        this._socketManager.removeUser(otherId);
      }
    }
  }

  // LEAVE: игрок уходит сам — снять сразу, без ожидания возврата
  _leave(socketId, state) {
    const { gameId } = state;

    this._socketManager.close(socketId);
    this._socketManager.removeUser(socketId);
    this._clients.delete(socketId);

    if (gameId !== undefined) {
      this._host.removeUser(gameId);
    }
  }

  /**
   * @param {string} socketId
   * @returns {boolean} Есть ли порт-машина у этого соединения.
   */
  has(socketId) {
    return this._clients.has(socketId);
  }

  /**
   * @param {string} socketId
   * @returns {boolean} Дошёл ли клиент до созданного участника матча.
   */
  hasParticipant(socketId) {
    return this._clients.get(socketId)?.gameId !== undefined;
  }

  /**
   * @returns {Iterator<string>} socketId живых соединений (для
   *   host.completeHandoff(new Set(...))).
   */
  get socketIds() {
    return this._clients.keys();
  }

  // порт-обработчики клиента (замыкание над gameId через state)
  _buildPortMethods(socketId, state) {
    const host = this._host;
    const socketManager = this._socketManager;

    return [
      // 0: config ready
      () => {
        state.enabled[PC_AUTH_RESPONSE] = true;

        // validators — код, по проводу не передаётся (форма клиента берёт
        // игровые валидаторы из своего бандла); texts — заголовок и
        // help-секции игры для нейтрального каркаса auth.pug
        socketManager.sendAuthData(socketId, {
          elems: this._authSchema.elems,
          params: this._authParams,
          texts: this._authSchema.texts,
        });
        state.enabled[PC_CONFIG_READY] = false;
      },

      // 1: auth response. Ник — не свободный ввод игровой формы, а результат
      // стратегии идентичности (claim проверенного токена в лобби, поле
      // формы в гостевом контуре)
      data => {
        if (!data || typeof data !== 'object') {
          return;
        }

        const err = validateAuth(
          data,
          this._authParams,
          this._authSchema.validators,
        );

        if (err) {
          socketManager.sendAuthResult(socketId, err);
          return;
        }

        this._identity
          .resolve(data, socketId)
          .then(name => {
            // клиент мог отключиться, пока проверялась личность
            if (!this._clients.has(socketId)) {
              return;
            }

            state.enabled[PC_AUTH_RESPONSE] = false;
            state.enabled[PC_MODULES_READY] = true;

            host.createUser({ ...data, name }, socketId, createdId => {
              state.gameId = createdId;
            });

            socketManager.sendTechInform(socketId, 'loading');
            socketManager.sendAuthResult(socketId, undefined);
          })
          .catch(() => {
            socketManager.sendAuthResult(socketId, [
              { name: this._identity.errorField ?? 'token', error: 'invalid' },
            ]);
          });
      },

      // 2: modules ready
      () => {
        state.enabled[PC_MODULES_READY] = false;
        this._enableInGame(state);

        host.sendMap(state.gameId);
      },

      // 3: map ready
      () => host.mapReady(state.gameId),

      // 4: first shot ready. Участник вошёл в матч — с этого момента ему
      // есть куда вернуться после обрыва: секрет места (SESSION_DATA)
      () => {
        host.firstShotReady(state.gameId);

        if (this._resumeGraceMs > 0) {
          const resumeKey = host.issueResumeKey(state.gameId);

          // gameId — клиенту для RESUME_REQUEST: наблюдатель свой id
          // больше ниоткуда не узнаёт
          if (resumeKey) {
            socketManager.sendSessionData(socketId, {
              resumeKey,
              gameId: state.gameId,
            });
          }
        }
      },

      // 5: keys data ('seq:action:name'; указатель — 'seq:aim:x:y:flags')
      keyEventString => {
        if (typeof keyEventString === 'string') {
          host.updateKeys(state.gameId, keyEventString);
        }
      },

      // 6: chat data
      message => host.pushMessage(state.gameId, message),

      // 7: vote data
      data => {
        if (data) {
          host.parseVote(state.gameId, data);
        }
      },

      // 8: pong
      pingId => host.updateRTT(state.gameId, pingId),

      // 9: resume request — попытка одна на соединение
      data => {
        state.enabled[PC_RESUME_REQUEST] = false;
        this._resume(socketId, state, data);
      },

      // 10: leave
      () => this._leave(socketId, state),
    ];
  }
}
