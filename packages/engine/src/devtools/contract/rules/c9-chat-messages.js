import { ERROR, skip, verdict } from '../result.js';

// Каждому зарегистрированному коду нужен текст на том же индексе в
// клиентском реестре. Недостающий текст рендерится пустотой: событие
// произошло, в чате ничего.
export default {
  id: 'C9',
  name: 'chatMessages',
  level: ERROR,
  title: 'every system message code has a client text',

  check(ctx) {
    const messages = ctx.hostPlugin?.systemMessages;
    const texts = ctx.clientConfig?.modules?.chat?.params?.messages;

    if (!messages || !texts) {
      return skip('no systemMessages or client chat messages');
    }

    const violations = [];

    for (const [name, code] of Object.entries(messages)) {
      const parsed = /^([a-z]):(\d+)$/.exec(String(code));

      if (!parsed) {
        continue;
      }

      const group = texts[parsed[1]];

      if (group?.[Number(parsed[2])] === undefined) {
        violations.push(
          `systemMessages.${name} ("${code}") has no text in ` +
            `chat.params.messages.${parsed[1]}[${parsed[2]}]`,
        );
      }
    }

    return verdict(violations);
  },
};
