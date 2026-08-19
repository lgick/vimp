import Publisher from '../../../lib/Publisher.js';

// Singleton ControlsModel

let controlsModel;

export default class ControlsModel {
  constructor(data) {
    if (controlsModel) {
      return controlsModel;
    }

    controlsModel = this;

    this._keySetList = data.keySetList;
    this._modes = data.modes;
    this._cmds = data.cmds;

    this._currentKeySetIndex = 0; // индекс текущего набора клавиш
    this._currentKeySet = this._keySetList[0]; // текущий набор клавиш
    this._currentModes = {}; // статусы режимов
    this._pressedKeys = {}; // объект для хранения состояния зажатых клавиш
    this._areKeysEnabled = false; // статус возможности нажатия клавиш

    // канал указателя: игра, не объявившая modules.controls.pointer, его не
    // получает вовсе — ни одного лишнего сообщения по проводу
    this._pointer = data.pointer
      ? {
          doubleTapMs: data.pointer.doubleTapMs ?? 300,
          doubleTapPx: data.pointer.doubleTapPx ?? 40,
          sendIntervalMs: data.pointer.sendIntervalMs ?? 50,
          // индексы наборов клавиш, в которых указатель живой; по умолчанию
          // все (у наблюдателя рулить нечем, но это дело игры)
          keySets: data.pointer.keySets ?? null,
        }
      : null;

    this._isPointerDown = false; // указатель прижат
    this._isPointerDoubled = false; // нажатие было вторым в двойном тапе
    this._lastTapTime = 0;
    this._lastTapX = 0;
    this._lastTapY = 0;
    this._lastAimTime = 0;

    this.publisher = new Publisher();
  }

  // добавляет команду
  addKey(event) {
    const keyCode = event.keyCode;
    const mode = this._modes[keyCode];
    const cmd = this._cmds[keyCode];

    // если запрет на ввод клавиш,
    // то доступны только stat и chat
    if (
      this._areKeysEnabled === false &&
      mode !== 'stat' &&
      mode !== 'chat' &&
      !this._currentModes.chat
    ) {
      return;
    }

    // если чат активен
    if (this._currentModes.chat) {
      if (cmd) {
        this.publisher.emit('chat', cmd);
      }

      if (mode === 'stat') {
        event.preventDefault();
        this.publisher.emit('mode', mode);
      }
    } else {
      // если клавиша ещё не зажата
      if (!this._pressedKeys[keyCode]) {
        const name = this._currentKeySet[keyCode];

        if (name) {
          this._pressedKeys[keyCode] = true;
          this.publisher.emit('socket', `down:${name}`);
        }
      }

      if (this._currentModes.vote) {
        this.publisher.emit('vote', keyCode);
      }

      if (this._currentModes.stat) {
        event.preventDefault();
      }

      if (mode) {
        event.preventDefault();
        this.publisher.emit('mode', mode);
      }
    }
  }

  // удаляет команду
  removeKey(event) {
    const keyCode = event.keyCode;
    const mode = this._modes[keyCode];

    // если клавиша была зажата
    if (this._pressedKeys[keyCode]) {
      const name = this._currentKeySet[keyCode];

      if (name) {
        this._pressedKeys[keyCode] = false;
        this.publisher.emit('socket', `up:${name}`);
      }
    }

    if (this._currentModes.stat && mode === 'stat') {
      this.publisher.emit('stat');
    }
  }

  // меняет состояние режима
  setMode(mode, status) {
    if (status === 'opened') {
      this._currentModes[mode] = true;

      // иначе змейка так и ехала бы к последней точке, пока игрок набирает
      // сообщение в чат
      this._releasePointer(this._lastTapX, this._lastTapY);
    } else if (status === 'closed') {
      this._currentModes[mode] = false;
    }
  }

  // живой ли сейчас канал указателя: те же правила, что и у клавиш —
  // ввод разрешён, ни один режим не открыт, набор клавиш игровой
  _isPointerLive() {
    if (!this._pointer || this._areKeysEnabled === false) {
      return false;
    }

    if (
      this._currentModes.chat ||
      this._currentModes.stat ||
      this._currentModes.vote
    ) {
      return false;
    }

    const { keySets } = this._pointer;

    return keySets === null || keySets.includes(this._currentKeySetIndex);
  }

  // отпускает указатель (чат открылся, набор сменился, палец ушёл)
  _releasePointer(x, y) {
    if (!this._isPointerDown) {
      return;
    }

    this._isPointerDown = false;
    this._isPointerDoubled = false;
    this._lastAimTime = 0;

    this.publisher.emit('aim', { x, y, flags: 0 });
  }

  // добавляет ввод указателем (мышь/палец/стилус)
  //
  // Канал живёт от нажатия до отпускания: `move` без прижатого указателя не
  // шлётся — иначе любое движение мыши перехватывало бы управление у клавиш
  // и грузило провод. `flags`: бит 0 — прижат, бит 1 — двойной тап.
  addPointer({ type, x, y }) {
    if (!this._pointer) {
      return;
    }

    if (!this._isPointerLive()) {
      this._releasePointer(x, y);

      return;
    }

    const { doubleTapMs, doubleTapPx, sendIntervalMs } = this._pointer;
    const now = Date.now();

    if (type === 'down') {
      // dblclick тач-устройства не гарантируют — распознаём сами: два
      // нажатия в пределах doubleTapMs и doubleTapPx
      const dx = x - this._lastTapX;
      const dy = y - this._lastTapY;

      this._isPointerDoubled =
        now - this._lastTapTime <= doubleTapMs &&
        Math.sqrt(dx * dx + dy * dy) <= doubleTapPx;

      this._isPointerDown = true;
      this._lastTapTime = now;
      this._lastTapX = x;
      this._lastTapY = y;
    } else if (type === 'up') {
      this._releasePointer(x, y);

      return;
    } else if (!this._isPointerDown) {
      return;
    } else if (now - this._lastAimTime < sendIntervalMs) {
      // move приходит с частотой опроса устройства; по проводу он идёт не
      // чаще sendIntervalMs
      return;
    }

    this._lastAimTime = now;

    this.publisher.emit('aim', {
      x,
      y,
      flags: 1 | (this._isPointerDoubled ? 2 : 0),
    });
  }

  // меняет набор клавиш
  changeKeySet(key) {
    this._currentKeySetIndex = key;
    this._currentKeySet = this._keySetList[key];
    this._pressedKeys = {};
    this._releasePointer(this._lastTapX, this._lastTapY);
  }

  // задаёт возможность нажатия клавиш
  // (stat и chat доступны при любом значении)
  setKeysEnabled(isEnabled) {
    this._areKeysEnabled = isEnabled;

    if (isEnabled === false) {
      this._releasePointer(this._lastTapX, this._lastTapY);
    }
  }
}
