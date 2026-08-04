// Транспорт хоста, который вместо сети пишет исходящие кадры в память.
// Обобщение FakeSocketManager из tests/host/fixtureHarness.js: одну и ту же
// подмену используют и движковые тесты меты, и headless-runner — иначе
// пришлось бы держать две копии перечня отправителей SocketManager.

// Все отправители SocketManager, которые дёргает host-фасад.
export const SENDER_METHODS = [
  'sendConfig',
  'sendAuthData',
  'sendAuthResult',
  'sendPing',
  'sendClear',
  'sendTechInform',
  'sendMap',
  'sendFirstShot',
  'sendFirstVote',
  'sendShot',
  'sendPanel',
  'sendStat',
  'sendChat',
  'sendVote',
  'sendKeySet',
  'sendPlayerDefaultShot',
  'sendSpectatorDefaultShot',
  'sendConsole',
  'sendGameInform',
  'sendRoundEnd',
  'sendSoundCue',
  'sendName',
];

class RecordingSocketManager {
  /**
   * @param {Object} [options]
   * @param {Function} [options.onFrame] - Вызывается на каждый исходящий кадр
   *   ({ method, socketId, args }) — runner раздаёт их VirtualClient'ам, не
   *   дожидаясь конца прогона.
   */
  constructor({ onFrame = null } = {}) {
    this.frames = []; // [{ method, socketId, args, tick }]

    // номер тика прогона: runner двигает его перед каждым шагом, кадры
    // получают метку — без неё проверки жизненного цикла раунда не могут
    // сказать «кому именно не доехал roundEnd на этом тике»
    this.tick = 0;
    this._onFrame = onFrame;
    this._game = null;
    this._panel = null;
    this._stat = null;

    for (const method of SENDER_METHODS) {
      this[method] = (socketId, ...args) => {
        this._record({ method, socketId, args });
      };
    }

    // Составные отправители боевого SocketManager сами дёргают панель,
    // статистику и keySet. Плоская запись их не раскрывает — тогда клиент
    // headless-прогона живёт с пустой панелью и без keySet, то есть предикт
    // у него не включается никогда. Развёртка обязана повторять
    // host/meta/SocketManager.js.
    this.sendFirstShot = socketId => {
      this._record({ method: 'sendFirstShot', socketId, args: [] });
      this.sendStat(socketId, this._stat?.getFull());
      this.sendPanel(socketId, this._panel?.getEmptyPanel());
      this.sendKeySet(socketId, 0); // наблюдатель
    };

    this.sendPlayerDefaultShot = (socketId, gameId) => {
      this._record({
        method: 'sendPlayerDefaultShot',
        socketId,
        args: [gameId],
      });
      this.sendPanel(socketId, this._panel?.getFullPanel(gameId));
      this.sendKeySet(socketId, 1); // играющий
    };

    this.sendSpectatorDefaultShot = socketId => {
      this._record({ method: 'sendSpectatorDefaultShot', socketId, args: [] });
      this.sendPanel(socketId, this._panel?.getEmptyPanel());
      this.sendKeySet(socketId, 0);
    };
  }

  injectServices(game, panel, stat) {
    this._game = game;
    this._panel = panel;
    this._stat = stat;
  }

  addUser() {}
  removeUser() {}

  close(socketId, code, key, arr) {
    this._record({ method: 'close', socketId, args: [code, key, arr] });
  }

  // все кадры указанного метода
  framesOf(method) {
    return this.frames.filter(frame => frame.method === method);
  }

  clear() {
    this.frames.length = 0;
  }

  _record(frame) {
    frame.tick = this.tick;
    this.frames.push(frame);

    if (this._onFrame) {
      this._onFrame(frame);
    }
  }
}

export default RecordingSocketManager;
