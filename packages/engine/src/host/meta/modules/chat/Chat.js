import { buildSystemMessage } from './systemMessages.js';

// Singleton Chat

let chat;

class Chat {
  constructor() {
    if (chat) {
      return chat;
    }

    chat = this;

    this._list = [];
    this._userList = {};
  }

  // добавляет пользователя
  addUser(gameId) {
    this._userList[gameId] = [];
  }

  // удаляет пользователя
  removeUser(gameId) {
    delete this._userList[gameId];
  }

  // добавляет сообщение. color ('#rrggbb') — цвет ника, который игра задала
  // через ParticipantManager.setChatColor; без него четвёртого элемента в
  // массиве нет вовсе, и провод игры, которая цвет не задаёт, не меняется
  push(message, name, teamId, color) {
    if (typeof color === 'string') {
      this._list.push([message, name, teamId, color]);
    } else {
      this._list.push([message, name, teamId]);
    }
  }

  // добавляет системное сообщение для всех
  // message может быть:
  // - шаблонным сообщением '<группа шаблонов>:<номер шаблона>:<параметры>'
  // - сообщением в виде массива [<текст сообщения>]
  pushSystem(message, params) {
    if (typeof message === 'string') {
      this._list.push(buildSystemMessage(message, params));
    } else {
      this._list.push(message);
    }
  }

  // добавляет системное сообщение для пользователя
  pushSystemByUser(gameId, message, params) {
    if (typeof message === 'string') {
      this._userList[gameId].push(buildSystemMessage(message, params));
    } else {
      this._userList[gameId].push(message);
    }
  }

  // возвращает сообщение
  shift() {
    return this._list.shift();
  }

  // возвращает сообщение для пользователя
  shiftByUser(gameId) {
    return this._userList[gameId].shift();
  }
}

// Сброс синглтона. Нужен только тем, кто крутит больше одного матча в
// процессе — headless-runner (devtools/resetHostSingletons.js) и тесты;
// в браузерной вкладке матч всегда один, поэтому прод его не зовёт.
export const resetChat = () => {
  chat = null;
};

export default Chat;
