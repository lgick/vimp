import { describe, it, expect, vi } from 'vitest';
import HiddenHostHealthLog, {
  HIDDEN_HEALTH_CODE,
} from '../../../packages/engine/src/client/network/HiddenHostHealthLog.js';

// сводка здоровья хоста за эпизод скрытой вкладки (host-migration этап 9a)

const sample = (tickRate, maxGapMs, lostMs) => ({
  tickRate,
  maxGapMs,
  lostMs,
  peerRttMedian: 80,
  peerCount: 1,
});

function createLog(hidden = false) {
  let now = 0;
  const warn = vi.fn();
  const log = new HiddenHostHealthLog({ warn, hidden, now: () => now });

  return { log, warn, advance: ms => (now += ms) };
}

describe('HiddenHostHealthLog', () => {
  it('видимая вкладка — метрики не копятся и не пишутся', () => {
    const { log, warn } = createLog();

    log.add(sample(12, 300, 200));
    log.setHidden(false);
    log.flush();

    expect(warn).not.toHaveBeenCalled();
  });

  it('эпизод скрытия — одна сводка при возврате видимости', () => {
    const { log, warn, advance } = createLog();

    log.setHidden(true);
    log.add(sample(118, 12, 0));
    advance(1000);
    log.add(sample(12, 320, 220));
    advance(1500);
    log.add(sample(30, 150, 50));
    log.setHidden(true); // повтор не начинает эпизод заново
    advance(500);
    log.setHidden(false);
    log.setHidden(false);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(HIDDEN_HEALTH_CODE, {
      hiddenMs: 3000,
      samples: 3,
      minTickRate: 12,
      maxGapMs: 320,
      lostMs: 270,
    });
  });

  it('потеря роли хоста (flush) закрывает эпизод, начатый скрытым', () => {
    const { log, warn, advance } = createLog(true);

    advance(2000);
    log.add(sample(40, 100, 0));
    log.flush();
    log.add(sample(10, 900, 800));
    log.flush();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][1]).toMatchObject({ hiddenMs: 2000, samples: 1 });
  });

  it('эпизод без метрик (матч стоял, короткое скрытие) не пишется', () => {
    const { log, warn, advance } = createLog();

    log.setHidden(true);
    advance(400);
    log.setHidden(false);

    expect(warn).not.toHaveBeenCalled();
  });
});
