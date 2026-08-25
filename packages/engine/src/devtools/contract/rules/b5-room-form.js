import { ERROR, skip, verdict } from '../result.js';
import { anchorPattern } from '../../../lib/formPattern.js';

// roomForm. Поле вне белого списка форма показывает, лобби отправляет, а
// хост молча выбрасывает — правило игры, построенное на своей настройке
// комнаты, не работает и ничего об этом не сообщает. Контролов в v3 ровно
// четыре: неизвестный пропускается с console.error. `regExp` едет в манифесте
// строкой и компилируется уже у игрока — некомпилируемая ловится здесь.
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

      if (field.regExp !== undefined) {
        try {
          // ровно та форма, что компилирует клиент (общий anchorPattern):
          // иначе «компилируется» у чекера и у игрока разъедется молча
          anchorPattern(field.regExp);
        } catch (e) {
          violations.push(
            `roomForm field "${field.name}": regExp "${field.regExp}" does ` +
              `not compile (${e.message}) — the client drops the check with ` +
              'a console.error, so the field ends up with no pattern at all',
          );
        }
      }
    }

    return verdict(violations);
  },
};
