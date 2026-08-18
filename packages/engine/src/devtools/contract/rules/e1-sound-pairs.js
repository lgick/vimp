import { ERROR, skip, verdict } from '../result.js';

// Клиент перебирает codecList ['webm', 'mp3'] и берёт первый поддержанный
// браузером. Отсутствующий .mp3 не ломает Chrome и ломает Safari — то есть
// проявляется у части игроков и никогда у автора.
export default {
  id: 'E1',
  name: 'soundPairs',
  level: ERROR,
  title: 'every declared sound ships as a webm + mp3 pair',

  check(ctx) {
    const sounds = ctx.clientConfig?.parts?.sounds?.sounds;

    if (!ctx.distFiles) {
      return skip('not built — no dist/');
    }

    if (!sounds) {
      return skip('no sound registry');
    }

    const violations = [];

    for (const [name, sound] of Object.entries(sounds)) {
      const file = sound?.file ?? name;

      for (const codec of ctx.clientConfig.parts.sounds.codecList ?? [
        'webm',
        'mp3',
      ]) {
        if (!ctx.distFiles.has(`sounds/${file}.${codec}`)) {
          violations.push(`sound "${name}": dist/sounds/${file}.${codec} is missing`);
        }
      }
    }

    return verdict(violations);
  },
};
