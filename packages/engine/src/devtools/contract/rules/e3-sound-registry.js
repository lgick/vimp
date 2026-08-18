import { WARN, skip, verdict } from '../result.js';

// Игра без единого звука собирается и играется — это законная стадия
// разработки, а не отказ. Но пустой реестр почти всегда означает
// «забыли», поэтому warn: под --strict он становится ошибкой.
export default {
  id: 'E3',
  name: 'soundRegistry',
  level: WARN,
  title: 'the sound registry is not empty',

  check(ctx) {
    if (!ctx.distFiles) {
      return skip('not built — no dist/');
    }

    const sounds = ctx.clientConfig?.parts?.sounds?.sounds;

    if (sounds && Object.keys(sounds).length) {
      return verdict([]);
    }

    return verdict(['no sounds are registered in client parts.sounds']);
  },
};
