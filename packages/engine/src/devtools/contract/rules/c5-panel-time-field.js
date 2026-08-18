import { ERROR, skip, verdict } from '../result.js';

// Панель шлёт время раунда под ключом 't' безусловно. Клиент, не
// объявивший для него поле type: 'time', получает значение с именем
// undefined — время просто не появляется на HUD.
export default {
  id: 'C5',
  name: 'panelTimeField',
  level: ERROR,
  title: "the client panel maps key 't' to a type: 'time' field",

  check(ctx) {
    const panel = ctx.clientConfig?.modules?.panel;

    if (!panel) {
      return skip('no client panel config');
    }

    const name = panel.keys?.t;

    if (name === undefined) {
      return verdict([
        "panel.keys has no 't' — the engine sends the round time under it",
      ]);
    }

    const field = (panel.fields ?? []).find(item => item.name === name);

    if (!field) {
      return verdict([`panel.keys.t maps to "${name}", which has no field`]);
    }

    if (field.type !== 'time') {
      return verdict([
        `panel field "${name}" (key 't') has type "${field.type}", ` +
          "expected 'time'",
      ]);
    }

    return verdict([]);
  },
};
