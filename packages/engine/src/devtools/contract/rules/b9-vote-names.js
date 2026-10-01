import { ERROR, skip, verdict } from '../result.js';

// Имена голосований mapChange/teamChange принадлежат движку. Своё
// голосование под этим именем не «переопределяет» движковое, а тонет:
// категорию разбирает HostGame раньше плагина. Обратная сторона той же
// ошибки — шаблон с именем категории (mapChange): движок рисует
// mapChangeBySystem/mapChangeByUser, и такой шаблон не показывается никогда.
const ENGINE_MENU = ['teamChange', 'mapChange'];
const ENGINE_TEMPLATES = ['teamChange', 'mapChangeBySystem', 'mapChangeByUser'];

// Имена с '@' — голосования самого движка (host-migration этап 10:
// '@changeHost' — окно «Change host?» от мастера). Ответ на голосование с
// таким именем клиент перехватывает до хоста — игровое голосование под ним
// не дошло бы до игры никогда
const ENGINE_PREFIX = '@';
const isEngineName = name =>
  typeof name === 'string' && name.startsWith(ENGINE_PREFIX);

export default {
  id: 'B9',
  name: 'voteNames',
  level: ERROR,
  title: 'custom votes do not reuse the reserved vote names or the @ prefix',

  check(ctx) {
    const vote = ctx.clientConfig?.modules?.vote?.params;

    if (!vote) {
      return skip('no client vote config');
    }

    const templates = Object.keys(vote.templates ?? {});
    const violations = [];

    for (const name of templates) {
      if (isEngineName(name)) {
        violations.push(
          `vote template "${name}" starts with "${ENGINE_PREFIX}" — names ` +
            `with this prefix are reserved for engine votes`,
        );
        continue;
      }

      if (ENGINE_MENU.includes(name) && !ENGINE_TEMPLATES.includes(name)) {
        violations.push(
          `vote template "${name}" reuses a reserved vote name — the engine ` +
            `renders ${ENGINE_TEMPLATES.join(' / ')}`,
        );
      }
    }

    for (const entry of vote.menu ?? []) {
      const name = Array.isArray(entry) ? entry[0] : entry;

      if (isEngineName(name)) {
        violations.push(
          `vote menu entry "${name}" starts with "${ENGINE_PREFIX}" — names ` +
            `with this prefix are reserved for engine votes`,
        );
        continue;
      }

      if (!ENGINE_MENU.includes(name) && !templates.includes(name)) {
        violations.push(
          `vote menu entry "${name}" has no template — the vote renders empty`,
        );
      }
    }

    return verdict(violations);
  },
};
