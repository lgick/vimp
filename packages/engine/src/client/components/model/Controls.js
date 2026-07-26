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

    this._currentKeySet = this._keySetList[0]; // текущий набор клавиш
    this._currentModes = {}; // статусы режимов
    this._pressedKeys = {}; // объект для хранения состояния зажатых клавиш
    this._areKeysEnabled = false; // статус возможности нажатия клавиш

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
    } else if (status === 'closed') {
      this._currentModes[mode] = false;
    }
  }

  // меняет набор клавиш
  changeKeySet(key) {
    this._currentKeySet = this._keySetList[key];
    this._pressedKeys = {};
  }

  // задаёт возможность нажатия клавиш
  // (stat и chat доступны при любом значении)
  setKeysEnabled(isEnabled) {
    this._areKeysEnabled = isEnabled;
  }
}
