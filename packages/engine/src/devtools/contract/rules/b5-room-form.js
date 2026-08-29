import { ERROR, WARN, skip, verdict } from '../result.js';
import { anchorPattern } from '../../../lib/formPattern.js';
import {
  formControls,
  ACTIVE_FORM_CONTROLS,
} from '../../../lib/formControls.js';

// roomForm. Поле вне белого списка форма показывает, лобби отправляет, а
// хост молча выбрасывает — правило игры, построенное на своей настройке
// комнаты, не работает и ничего об этом не сообщает. Контрол проверяется по
// реестру (lib/formControls.js): неизвестный пропускается с console.error,
// выведенный из эксплуатации строится алиасом и потому только WARN — новая
// игра его писать не должна, старая продолжает работать. `regExp` едет в
// манифесте строкой и компилируется уже у игрока — некомпилируемая ловится
// здесь.
const HONOURED = [
  'maps',
  'maxPlayers',
  'map',
  'roundTime',
  'mapTime',
  'friendlyFire',
];

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
    const retired = [];

    for (const field of roomForm) {
      if (!HONOURED.includes(field.name)) {
        violations.push(
          `roomForm field "${field.name}" is not read by the host ` +
            `(honoured: ${HONOURED.join(', ')}) — it is silently dropped`,
        );
      }

      if (!formControls.has(field.control)) {
        violations.push(
          `roomForm field "${field.name}": control "${field.control}" does ` +
            `not exist (${ACTIVE_FORM_CONTROLS.join(', ')})`,
        );
      } else if (formControls.isRetired(field.control)) {
        const entry = formControls.get(field.control);

        retired.push(
          `roomForm field "${field.name}": control "${field.control}" was ` +
            `retired in plugin API v${entry.retiredIn} — it still works ` +
            `(the engine builds it as "${formControls.resolve(field.control)}" ` +
            `forever), but a new game should declare ` +
            `"${formControls.resolve(field.control)}" itself`,
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

    if (violations.length === 0 && retired.length > 0) {
      return verdict(
        retired,
        'retired controls still build, via aliases',
        WARN,
      );
    }

    return verdict(violations);
  },
};
