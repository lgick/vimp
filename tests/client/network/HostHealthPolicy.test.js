import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import HostHealthPolicy from '../../../packages/engine/src/client/network/HostHealthPolicy.js';

// Политика автопередачи хоста (host-migration этап 9b) на фейковых часах:
// сэмпл здоровья — раз в 1 с, передача — фейк с фазами PlannedHandoff.

const CONFIG = {
  enabled: true,
  overloadTickRate: 100,
  overloadWindowMs: 5000,
  criticalTickRate: 60,
  criticalWindowMs: 3000,
  lostWindows: 3,
  recoverTickRate: 110,
  recoverWindowMs: 5000,
  hiddenHandoffMs: 1500,
  autoHandoffCooldownMs: 90000,
  minHostTenureMs: 30000,
};

let handoff;
let policy;

// фейк PlannedHandoff: null | 'deferred' | 'requested'
const makeHandoff = () => ({
  phase: null,
  reason: null,
  calls: [],
  start({ reason, defer }) {
    if (this.phase !== null) {
      return false;
    }

    this.calls.push(['start', reason, defer]);
    this.phase = defer ? 'deferred' : 'requested';
    this.reason = reason;
    return true;
  },
  hurry(reason) {
    if (this.phase !== 'deferred') {
      return false;
    }

    this.calls.push(['hurry', reason]);
    this.phase = 'requested';
    this.reason = reason;
    return true;
  },
  cancelDeferred() {
    if (this.phase !== 'deferred') {
      return false;
    }

    this.calls.push(['cancel']);
    this.phase = null;
    this.reason = null;
    return true;
  },
  deferredReason() {
    return this.phase === 'deferred' ? this.reason : null;
  },
  // передача закончилась (отказ мастера, дедлайн), вкладка — хост
  settle() {
    this.phase = null;
    this.reason = null;
  },
});

const create = (config = {}) =>
  new HostHealthPolicy({
    config: { ...CONFIG, ...config },
    handoff,
    now: () => Date.now(),
  });

// n сэмплов с шагом 1 с
const feed = (tickRate, n = 1, lostMs = 0) => {
  for (let i = 0; i < n; i += 1) {
    vi.advanceTimersByTime(1000);
    policy.addHealth({ tickRate, maxGapMs: 10, lostMs });
  }
};

// хост с бетой, прослуживший minHostTenureMs
const readyHost = config => {
  policy = create(config);
  policy.setHost(true);
  policy.setSuccessor(true);
  vi.advanceTimersByTime(CONFIG.minHostTenureMs);
};

beforeEach(() => {
  vi.useFakeTimers();
  handoff = makeHandoff();
});

afterEach(() => {
  policy?.destroy();
  vi.useRealTimers();
});

describe('HostHealthPolicy: перегрузка', () => {
  it('мягкая: среднее за 5 с < 100 — передача, отложенная до границы', () => {
    readyHost();

    feed(95, 4);
    expect(handoff.calls).toEqual([]);

    feed(95);
    expect(handoff.calls).toEqual([['start', 'overload', true]]);
  });

  it('среднее, а не каждый сэмпл: одиночный провал не срабатывает', () => {
    readyHost();

    feed(120, 4);
    feed(70);
    expect(handoff.calls).toEqual([]);
  });

  it('жёсткая: среднее за 3 с < 60 — передача сразу', () => {
    readyHost();

    feed(50, 3);
    expect(handoff.calls).toEqual([['start', 'overload', false]]);
  });

  it('жёсткая: lostMs > 0 три сэмпла подряд', () => {
    readyHost();

    feed(115, 2, 20);
    feed(115, 1, 0);
    feed(115, 2, 20);
    expect(handoff.calls).toEqual([]);

    feed(115, 1, 20);
    expect(handoff.calls).toEqual([['start', 'overload', false]]);
  });

  it('разрыв потока сэмплов (матч стоял) обнуляет окно', () => {
    readyHost();

    feed(95, 4);
    vi.advanceTimersByTime(5000);
    feed(95);
    expect(handoff.calls).toEqual([]);

    feed(95, 4);
    expect(handoff.calls).toEqual([['start', 'overload', true]]);
  });
});

describe('HostHealthPolicy: отмена отложенной передачи (гистерезис)', () => {
  it('5 сэмплов подряд > 110 — отмена, кулдаун не израсходован', () => {
    readyHost();
    feed(95, 5);
    expect(handoff.deferredReason()).toBe('overload');

    feed(120, 4);
    expect(handoff.calls).toHaveLength(1);

    feed(120);
    expect(handoff.calls.at(-1)).toEqual(['cancel']);

    // перегрузка вернулась — новая попытка без ожидания кулдауна
    feed(95, 4);
    expect(handoff.calls.at(-1)).toEqual(['cancel']);
    feed(95);
    expect(handoff.calls.at(-1)).toEqual(['start', 'overload', true]);
  });

  it('колебания около 100 Гц не отменяют: сэмпл ≤ 110 сбрасывает счёт', () => {
    readyHost();
    feed(95, 5);

    for (let i = 0; i < 6; i += 1) {
      feed(120, 3);
      feed(105);
    }

    expect(handoff.calls).toEqual([['start', 'overload', true]]);
    expect(handoff.deferredReason()).toBe('overload');
  });

  it('ручная «Hand over host» в ожидании — не трогается', () => {
    readyHost();
    handoff.start({ reason: 'handover', defer: true });

    feed(120, 10);
    expect(handoff.calls).toEqual([['start', 'handover', true]]);
  });

  it('передача уже спросила мастера — отменять нечего', () => {
    readyHost();
    feed(95, 5);
    handoff.phase = 'requested';

    feed(120, 5);
    expect(handoff.calls).toEqual([['start', 'overload', true]]);
  });
});

describe('HostHealthPolicy: эскалация отложенной передачи', () => {
  it('жёсткая перегрузка в ожидании — hurry', () => {
    readyHost();
    feed(95, 5);

    feed(40, 2);
    expect(handoff.calls.at(-1)).toEqual(['hurry', 'overload']);
  });

  it('скрытая вкладка в ожидании — hurry(hidden), даже в кулдауне', () => {
    readyHost();
    feed(95, 5);

    policy.setHidden(true);
    vi.advanceTimersByTime(1500);
    expect(handoff.calls.at(-1)).toEqual(['hurry', 'hidden']);
  });
});

describe('HostHealthPolicy: скрытая вкладка', () => {
  it('скрыта непрерывно 1.5 с — передача сразу', () => {
    readyHost();

    policy.setHidden(true);
    vi.advanceTimersByTime(1499);
    expect(handoff.calls).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(handoff.calls).toEqual([['start', 'hidden', false]]);
  });

  it('мигание видимости короче порога не срабатывает', () => {
    readyHost();

    for (let i = 0; i < 5; i += 1) {
      policy.setHidden(true);
      vi.advanceTimersByTime(1000);
      policy.setHidden(false);
      vi.advanceTimersByTime(100);
    }

    expect(handoff.calls).toEqual([]);
  });

  it('беты не было — передача, как только назначена (вкладка всё ещё скрыта)', () => {
    readyHost();
    policy.setSuccessor(false);

    policy.setHidden(true);
    vi.advanceTimersByTime(5000);
    expect(handoff.calls).toEqual([]);

    policy.setSuccessor(true);
    expect(handoff.calls).toEqual([['start', 'hidden', false]]);
  });

  it('скрыта в первые 30 с роли, матч стоит — передача по истечении срока', () => {
    policy = create();
    policy.setHost(true);
    policy.setSuccessor(true);

    vi.advanceTimersByTime(5000);
    policy.setHidden(true);
    vi.advanceTimersByTime(24999);
    expect(handoff.calls).toEqual([]);

    // без единого сэмпла health
    vi.advanceTimersByTime(1);
    expect(handoff.calls).toEqual([['start', 'hidden', false]]);
  });

  it('скрыта в кулдауне, матч стоит — передача по истечении кулдауна', () => {
    readyHost();
    feed(40, 3);
    handoff.settle();

    policy.setHidden(true);
    vi.advanceTimersByTime(89999 - 1500);
    expect(handoff.calls).toHaveLength(1);

    vi.advanceTimersByTime(1500);
    expect(handoff.calls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(handoff.calls.at(-1)).toEqual(['start', 'hidden', false]);
  });

  it('вкладка скрыта, когда получила роль: отсчёт от получения роли', () => {
    policy = create({ minHostTenureMs: 0 });
    policy.setHidden(true);
    vi.advanceTimersByTime(10000);

    policy.setHost(true);
    policy.setSuccessor(true);
    expect(handoff.calls).toEqual([]);

    // минимальный срок роли — отдельное условие, здесь 0
    vi.advanceTimersByTime(1500);
    expect(handoff.calls).toEqual([['start', 'hidden', false]]);
  });
});

describe('HostHealthPolicy: общие условия', () => {
  it('нет беты — не передаёт', () => {
    readyHost();
    policy.setSuccessor(false);

    feed(40, 5);
    expect(handoff.calls).toEqual([]);
  });

  it('minHostTenureMs: первые 30 с роли не отдаёт', () => {
    policy = create();
    policy.setHost(true);
    policy.setSuccessor(true);

    feed(40, 29);
    expect(handoff.calls).toEqual([]);

    feed(40);
    expect(handoff.calls).toEqual([['start', 'overload', false]]);
  });

  it('кулдаун 90 с от запуска при любом исходе', () => {
    readyHost();
    feed(40, 3);
    handoff.settle(); // мастер отказал

    feed(40, 89);
    expect(handoff.calls).toHaveLength(1);

    feed(40);
    expect(handoff.calls).toHaveLength(2);
  });

  it('кулдаун переживает смену ролей', () => {
    readyHost();
    feed(40, 3);
    handoff.settle();

    policy.setHost(false);
    vi.advanceTimersByTime(40000);
    policy.setHost(true);
    policy.setSuccessor(true);

    feed(40, 45);
    expect(handoff.calls).toHaveLength(1);

    feed(40, 5);
    expect(handoff.calls).toHaveLength(2);
  });

  it('enabled: false — политика молчит', () => {
    readyHost({ enabled: false });

    feed(40, 10);
    policy.setHidden(true);
    vi.advanceTimersByTime(5000);
    expect(handoff.calls).toEqual([]);
  });

  it('не хост — сэмплы и скрытие игнорируются', () => {
    policy = create();
    policy.setSuccessor(true);
    vi.advanceTimersByTime(60000);

    feed(40, 10);
    policy.setHidden(true);
    vi.advanceTimersByTime(5000);
    expect(handoff.calls).toEqual([]);
  });

  it('потеря роли снимает таймер скрытой вкладки', () => {
    readyHost();
    policy.setHidden(true);
    policy.setHost(false);

    vi.advanceTimersByTime(5000);
    expect(handoff.calls).toEqual([]);
  });
});
