// Хендшейк-машина клиента, вынутая из host.worker.js: автомат по клиентским
// портам 0–8 (см. docs/en/network.md). Изоморфна — ни self, ни postMessage,
// ни DOM: всё, что знает про транспорт, приходит через makeSocket. Поэтому её
// крутит и Worker браузерного хоста, и inline-хост standalone SDK, и
// Node-процесс dedicated-сервера: копий автомата быть не должно, иначе они
// разъедутся ровно так, как разъезжались бы копии createHostRuntime.

import wsports from '../config/wsports.js';
import closeCodes from '../config/closeCodes.js';
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

const PORT_COUNT = 9;

export default class PortMachine {
  /**
   * @param {Object} deps
   * @param {Object} deps.host - HostGame.
   * @param {Object} deps.socketManager - транспорт (per-user send/close).
   * @param {Object} deps.clientCfg - конфиг клиента (порт 0).
   * @param {Object} deps.authSchema - hostPlugin.authSchema.
   * @param {Function} deps.makeSocket - (socketId) => { send, sendBinary, close }.
   * @param {Object} deps.identity - стратегия идентичности (./identity.js).
   */
  constructor({ host, socketManager, clientCfg, authSchema, makeSocket, identity }) {
    this._host = host;
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
   */
  connect(socketId) {
    if (this._clients.has(socketId)) {
      return;
    }

    this._socketManager.addUser(socketId, this._makeSocket(socketId));

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
    state.enabled[PC_MAP_READY] = true;
    state.enabled[PC_FIRST_SHOT_READY] = true;
    state.enabled[PC_KEYS_DATA] = true;
    state.enabled[PC_CHAT_DATA] = true;
    state.enabled[PC_VOTE_DATA] = true;
    state.enabled[PC_PONG] = true;

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

    this._socketManager.removeUser(socketId);

    if (state.gameId !== undefined) {
      this._host.removeUser(state.gameId);
    }

    this._clients.delete(socketId);
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
        state.enabled[PC_MAP_READY] = true;
        state.enabled[PC_FIRST_SHOT_READY] = true;
        state.enabled[PC_KEYS_DATA] = true;
        state.enabled[PC_CHAT_DATA] = true;
        state.enabled[PC_VOTE_DATA] = true;
        state.enabled[PC_PONG] = true;

        host.sendMap(state.gameId);
      },

      // 3: map ready
      () => host.mapReady(state.gameId),

      // 4: first shot ready
      () => host.firstShotReady(state.gameId),

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
    ];
  }
}
