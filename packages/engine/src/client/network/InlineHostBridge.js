import wsports from '../../config/wsports.js';
import { createHostRuntime } from '../../lib/createHostRuntime.js';
import { offlinePlayerData } from '../../lib/offlinePlayerData.js';
import PortMachine from '../../host/PortMachine.js';
import { createGuestIdentity } from '../../host/identity.js';

// Замена HostController для solo-режима (Этап 2 плана standalone-sdk): тот же
// интерфейс, который дёргает LoopbackTransport (open/send/disconnect), но
// вместо Worker'а хост крутится в этом же потоке.
//
// Почему inline, а не Worker: HostPlugin принципиально непередаваем в Worker
// (postMessage не несёт функции), а standalone SDK получает от репозитория
// игры именно живой объект плагина. Прод-путь (хост в Worker'е) не меняется —
// расхождение dev/prod осознанное, см. plan/standalone-sdk/README.md.
//
// Мастера в этом контуре нет: личность гостевая (ник из формы, identity.js),
// профиль offline-заглушкой (lib/offlinePlayerData.js).

const PS_TECH_INFORM_DATA = wsports.server.TECH_INFORM_DATA;

export default class InlineHostBridge {
  /**
   * @param {Object} room - Описание комнаты (game.wasmUrl, hostSocketId, …).
   * @param {Object} deps
   * @param {Object} deps.hostPlugin - Живой HostPlugin игры.
   * @param {Function} [deps.onMapChange] - Уведомление о смене карты.
   */
  constructor(room, { hostPlugin, onMapChange } = {}) {
    // socketId → { onMessage, onClose } транспорта
    this._clients = new Map();
    this._runtime = null;
    this._portMachine = null;
    this._destroyed = false;

    // хост поднимается асинхронно (ядро игры + WASM): open() до готовности
    // потерял бы хендшейк, поэтому вызывающий обязан дождаться ready
    this.ready = this._init(room, { hostPlugin, onMapChange });
  }

  /**
   * Новое соединение клиента: регистрация обработчиков и старт хендшейка.
   * @param {string} socketId
   * @param {Object} handlers - { onMessage, onClose }.
   */
  open(socketId, handlers) {
    this._assertReady();
    this._clients.set(socketId, handlers);
    this._portMachine.connect(socketId);
  }

  /**
   * Кадр клиента хосту (wire-строка [port, payload]).
   * @param {string} socketId
   * @param {string} data
   */
  send(socketId, data) {
    this._assertReady();
    this._portMachine.message(socketId, data);
  }

  /**
   * Отключение клиента.
   * @param {string} socketId
   */
  disconnect(socketId) {
    if (!this._clients.delete(socketId)) {
      return;
    }

    this._portMachine.disconnect(socketId);
  }

  /**
   * Останов матча: таймеры хоста держали бы вкладку живой и после выхода.
   * @returns {Promise} Завершение teardown хоста.
   */
  destroy() {
    this._destroyed = true;
    this._clients.clear();

    // ready может быть ещё в полёте — без ожидания хост поднялся бы уже
    // после teardown и остался бы во вкладке со своим игровым циклом
    return this.ready.catch(() => {}).then(() => this._runtime?.host.destroy());
  }

  async _init(room, { hostPlugin, onMapChange }) {
    const runtime = await createHostRuntime(room, {
      // плагин уже живой объект — динамического import'а по URL нет
      loadHostPlugin: async () => hostPlugin,
      hostOptions: {
        playerDataFetch: offlinePlayerData(),
        onMapChange,
      },
    });

    // stop() успел прийти раньше готовности: поднятый хост нужно погасить
    // здесь, иначе его таймеры останутся во вкладке навсегда
    if (this._destroyed) {
      await runtime.host.destroy();
      return;
    }

    this._runtime = runtime;

    this._portMachine = new PortMachine({
      host: runtime.host,
      socketManager: runtime.socketManager,
      clientCfg: runtime.clientCfg,
      authSchema: runtime.hostPlugin.authSchema,
      makeSocket: socketId => this._makeSocket(socketId),
      identity: createGuestIdentity(),
    });
  }

  // хост поднимается асинхронно: без ready порт-машины ещё нет, и вызов
  // упал бы сырым TypeError на null. После destroy() порт-машина остаётся, но
  // хост уже погашен — кадр создал бы участника без таймеров матча
  _assertReady() {
    if (this._destroyed) {
      throw new Error('InlineHostBridge: the host is destroyed');
    }

    if (!this._portMachine) {
      throw new Error('InlineHostBridge: await ready first');
    }
  }

  // wire-сокет пользователя: кладёт кадр прямо в onMessage транспорта —
  // ровно те же форматы, что makeWorkerSocket отправляет постмесседжем
  _makeSocket(socketId) {
    return {
      send: (port, data) =>
        this._deliver(socketId, JSON.stringify([port, data])),

      sendBinary: buffer => this._deliver(socketId, buffer),

      // причина закрытия доставляется отдельным TECH_INFORM до закрытия —
      // как в Worker'е (порядок гарантирован синхронной доставкой)
      close: (code, data) => {
        if (data !== undefined) {
          this._deliver(socketId, JSON.stringify([PS_TECH_INFORM_DATA, data]));
        }

        this._clients.get(socketId)?.onClose();
      },
    };
  }

  _deliver(socketId, payload) {
    this._clients.get(socketId)?.onMessage(payload);
  }
}
