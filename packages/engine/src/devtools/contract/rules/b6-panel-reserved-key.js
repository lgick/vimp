import { ERROR, skip, verdict } from '../result.js';

// Ключ панели 't' зарезервирован движком под время раунда (Panel шлёт его
// сама). Игра, занявшая 't' своим полем, получает ячейку, которую движок
// перезаписывает секундами — без единого предупреждения.
export default {
  id: 'B6',
  name: 'panelReservedKey',
  level: ERROR,
  title: "host panel.fields does not use the engine key 't'",

  check(ctx) {
    const fields = ctx.gameConfig?.panel?.fields;

    if (!fields) {
      return skip('no gameConfig.panel.fields');
    }

    const violations = Object.entries(fields)
      .filter(([, field]) => field?.key === 't')
      .map(
        ([name]) =>
          `panel field "${name}" uses key 't' — reserved by the engine for ` +
          'the round time',
      );

    return verdict(violations);
  },
};
