import { ERROR, skip, verdict } from '../result.js';

// Горячий буфер несёт только indexed8/indexedNoNull8; list16 и indexed32
// приходят через take_frames() и обязаны быть class: 'event' — иначе кадр
// не считается надёжным и может быть выброшен ненадёжным каналом.
const HOT_KINDS = ['indexed8', 'indexedNoNull8'];
const EVENT_KINDS = ['list16', 'indexed32'];

export default {
  id: 'D2',
  name: 'snapshotClasses',
  level: ERROR,
  title: "class 'hot' only on indexed8/indexedNoNull8 blocks",

  check(ctx) {
    const snapshot = ctx.gameConfig?.snapshot;

    if (!snapshot) {
      return skip('no gameConfig.snapshot');
    }

    const violations = [];

    for (const [key, block] of Object.entries(snapshot)) {
      if (block.class === 'hot' && !HOT_KINDS.includes(block.kind)) {
        violations.push(
          `snapshot "${key}": kind "${block.kind}" cannot be class 'hot' ` +
            `(hot buffer carries ${HOT_KINDS.join(' / ')})`,
        );
      }

      if (EVENT_KINDS.includes(block.kind) && block.class !== 'event') {
        violations.push(
          `snapshot "${key}": kind "${block.kind}" must be class 'event', ` +
            `got "${block.class}" — the frame is not classified as reliable`,
        );
      }
    }

    return verdict(violations);
  },
};
