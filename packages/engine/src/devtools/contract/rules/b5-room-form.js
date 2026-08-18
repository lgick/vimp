import { ERROR, skip, verdict } from '../result.js';

// roomForm. Поле вне белого списка форма показывает, лобби отправляет, а
// хост молча выбрасывает — правило игры, построенное на своей настройке
// комнаты, не работает и ничего об этом не сообщает. Контролов в v3 ровно
// четыре: неизвестный пропускается с console.error.
const HONOURED = ['maps', 'maxPlayers', 'map', 'roundTime', 'mapTime', 'friendlyFire'];
const CONTROLS = ['text', 'select', 'checkbox', 'radio'];

export default {
  id: 'B5',
  name: 'roomForm',
  level: ERROR,
  title: 'roomForm uses honoured field names and existing controls',

  check(ctx) {
    const roomForm = ctx.gameConfig?.roomForm ?? ctx.manifest?.roomForm;

    if (!Array.isArray(roomForm)) {
      return skip('no roomForm');
    }

    const violations = [];

    for (const field of roomForm) {
      if (!HONOURED.includes(field.name)) {
        violations.push(
          `roomForm field "${field.name}" is not read by the host ` +
            `(honoured: ${HONOURED.join(', ')}) — it is silently dropped`,
        );
      }

      if (!CONTROLS.includes(field.control)) {
        violations.push(
          `roomForm field "${field.name}": control "${field.control}" does ` +
            `not exist (${CONTROLS.join(', ')})`,
        );
      }
    }

    return verdict(violations);
  },
};
