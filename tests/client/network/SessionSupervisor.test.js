import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Publisher from '../../../packages/engine/src/lib/Publisher.js';
import SessionSupervisor, {
  SESSION_STATES as S,
} from '../../../packages/engine/src/client/network/SessionSupervisor.js';
import wsports from '../../../packages/engine/src/config/wsports.js';

// Супервизор сессии (host-migration этап 4): терминальные и нетерминальные
// закрытия, переподключение с resume, RESUME_RESULT, сторожок тишины, окно
// переподключения, игнор сообщений брошенного транспорта. Транспорты — фейки,
// часы — фейковые таймеры vitest.

const makeTransport = () => {
  const transport = {
    publisher: new Publisher(),
    sent: [],
    destroyed: false,
    send: data => transport.sent.push(data),
    close: code => transport.publisher.emit('close', code),
    destroy: () => {
      transport.destroyed = true;
    },
    open: () => transport.publisher.emit('open'),
    receive: data => transport.publisher.emit('message', data),
  };

  return transport;
};

const TIMING = {
  reconnectWindowMs: 15000,
  reconnectBaseDelayMs: 500,
  reconnectMaxDelayMs: 4000,
  hostSilenceMs: 3000,
  migrationWaitMs: 20000,
};

const clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: id => clearInterval(id),
};

describe('SessionSupervisor', () => {
  let attempts;
  let hooks;
  let first;

  const makeSupervisor = (opts = {}) =>
    new SessionSupervisor({
      onMessage: hooks.onMessage,
      onTerminal: hooks.onTerminal,
      onStateChange: hooks.onStateChange,
      onResumed: hooks.onResumed,
      onResumeRejected: hooks.onResumeRejected,
      onHostLost: hooks.onHostLost,
      onColdRestart: hooks.onColdRestart,
      reconnect: {
        createTransport: () => {
          const transport = makeTransport();

          attempts.push(transport);

          return transport;
        },
        getToken: () => 'tok',
      },
      timing: TIMING,
      clock,
      ...opts,
    });

  // сессия в игре с выданным секретом места
  const inGame = (opts = {}) => {
    const supervisor = makeSupervisor(opts);

    supervisor.attach(first);
    first.open();
    supervisor.enterGame();
    supervisor.setSession({ resumeKey: 'k1', gameId: 7 });

    return supervisor;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    attempts = [];
    first = makeTransport();
    hooks = {
      onMessage: vi.fn(),
      onTerminal: vi.fn(),
      onStateChange: vi.fn(),
      onResumed: vi.fn(),
      onResumeRejected: vi.fn(),
      onHostLost: vi.fn(),
      onColdRestart: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('проводит сообщения транспорта и ведёт состояния входа', () => {
    const supervisor = makeSupervisor();

    supervisor.attach(first);
    expect(supervisor.state).toBe(S.connecting);

    first.open();
    expect(supervisor.state).toBe(S.handshake);

    first.receive('[0,{}]');
    expect(hooks.onMessage).toHaveBeenCalledWith('[0,{}]');

    supervisor.send('[4,null]');
    expect(first.sent).toEqual(['[4,null]']);

    supervisor.enterGame();
    expect(supervisor.state).toBe(S.inGame);
  });

  describe('терминальные закрытия', () => {
    it('до входа в матч', () => {
      const supervisor = makeSupervisor();

      supervisor.attach(first);
      first.open();
      first.close();

      expect(supervisor.state).toBe(S.closed);
      expect(hooks.onTerminal).toHaveBeenCalledTimes(1);
      expect(attempts).toHaveLength(0);
    });

    it('в матче без секрета места', () => {
      const supervisor = makeSupervisor();

      supervisor.attach(first);
      supervisor.enterGame();
      first.close();

      expect(hooks.onTerminal).toHaveBeenCalled();
      expect(attempts).toHaveLength(0);
    });

    it('без reconnect (solo, dedicated, вкладка-хост) — код закрытия наверх', () => {
      inGame({ reconnect: null });
      first.close(4006);

      expect(hooks.onTerminal).toHaveBeenCalledWith(4006);
    });

    it('закрытие по политике/кику', () => {
      inGame({ isTerminalClose: () => true });
      first.close();

      expect(hooks.onTerminal).toHaveBeenCalled();
      expect(attempts).toHaveLength(0);
    });

    it('пользователь ушёл сам', () => {
      const supervisor = inGame();

      supervisor.close();

      expect(hooks.onTerminal).toHaveBeenCalledTimes(1);
      expect(attempts).toHaveLength(0);
    });
  });

  describe('переподключение', () => {
    it('обрыв в матче — новая попытка и RESUME_REQUEST после открытия', () => {
      const supervisor = inGame();

      first.close();

      expect(supervisor.state).toBe(S.reconnecting);
      expect(hooks.onTerminal).not.toHaveBeenCalled();
      expect(attempts).toHaveLength(1);

      attempts[0].open();

      expect(JSON.parse(attempts[0].sent[0])).toEqual([
        wsports.client.RESUME_REQUEST,
        { v: 1, gameId: 7, resumeKey: 'k1', token: 'tok' },
      ]);
    });

    it('RESUME_RESULT ok — снова в игре, пакет до SESSION_DATA', () => {
      const supervisor = inGame();

      first.close();
      attempts[0].open();
      supervisor.resumeResult({ ok: true, gameId: 7, epoch: 1 });

      expect(supervisor.state).toBe(S.inGame);
      expect(supervisor.resuming).toBe(true);
      expect(hooks.onResumed).toHaveBeenCalledWith({
        ok: true,
        gameId: 7,
        epoch: 1,
      });

      // SESSION_DATA закрывает пакет возобновления
      expect(supervisor.setSession({ resumeKey: 'k2', gameId: 7 })).toBe(true);
      expect(supervisor.resuming).toBe(false);
      expect(supervisor.setSession({ resumeKey: 'k3', gameId: 7 })).toBe(false);

      // окно переподключения снято: живой хост (кадры идут) — сессия не
      // закроется сама
      for (let i = 0; i < 20; i += 1) {
        vi.advanceTimersByTime(1000);
        attempts[0].receive('[10,1]');
      }

      expect(hooks.onTerminal).not.toHaveBeenCalled();
      expect(supervisor.state).toBe(S.inGame);
    });

    it('следующий обрыв предъявляет новый ключ', () => {
      const supervisor = inGame();

      first.close();
      attempts[0].open();
      supervisor.resumeResult({ ok: true, gameId: 7 });
      supervisor.setSession({ resumeKey: 'k2', gameId: 7 });

      attempts[0].close();
      attempts[1].open();

      expect(JSON.parse(attempts[1].sent[0])[1].resumeKey).toBe('k2');
    });

    it('RESUME_RESULT !ok — сессия закрыта, причина наверх', () => {
      const supervisor = inGame();

      first.close();
      attempts[0].open();
      supervisor.resumeResult({ ok: false, reason: 'unknown' });

      expect(supervisor.state).toBe(S.closed);
      expect(hooks.onResumeRejected).toHaveBeenCalledWith('unknown');
      expect(hooks.onTerminal).not.toHaveBeenCalled();
      expect(attempts[0].destroyed).toBe(true);

      vi.advanceTimersByTime(TIMING.reconnectWindowMs);
      expect(attempts).toHaveLength(1);
    });

    it('провалившаяся попытка повторяется с бэкоффом', () => {
      inGame();
      first.close();

      attempts[0].close();
      expect(attempts).toHaveLength(1);

      vi.advanceTimersByTime(499);
      expect(attempts).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(attempts).toHaveLength(2);

      attempts[1].close();
      vi.advanceTimersByTime(999);
      expect(attempts).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(attempts).toHaveLength(3);
    });

    it('окно переподключения истекло — терминально', () => {
      const supervisor = inGame();

      first.close();

      vi.advanceTimersByTime(TIMING.reconnectWindowMs);

      expect(supervisor.state).toBe(S.closed);
      expect(hooks.onTerminal).toHaveBeenCalledTimes(1);
      expect(attempts[0].destroyed).toBe(true);
    });

    it('сообщения брошенного транспорта игнорируются', () => {
      const supervisor = inGame();

      first.close();
      hooks.onMessage.mockClear();

      first.receive('[5,"late"]');
      attempts[0].receive('[20,{"ok":true}]');

      expect(hooks.onMessage.mock.calls).toEqual([['[20,{"ok":true}]']]);

      // поздний close старого транспорта ничего не ломает
      first.close();
      expect(supervisor.state).toBe(S.reconnecting);
      expect(attempts).toHaveLength(1);
    });

    it('RESUME_RESULT вне переподключения игнорируется', () => {
      const supervisor = inGame();

      supervisor.resumeResult({ ok: false, reason: 'unknown' });

      expect(supervisor.state).toBe(S.inGame);
      expect(hooks.onResumeRejected).not.toHaveBeenCalled();
    });

    it('уход пользователя посреди переподключения — терминально', () => {
      const supervisor = inGame();

      first.close();
      supervisor.close();

      expect(supervisor.state).toBe(S.closed);
      expect(hooks.onTerminal).toHaveBeenCalledTimes(1);
      expect(attempts[0].destroyed).toBe(true);
    });
  });

  describe('свидетельство мастеру (host-migration 7.2)', () => {
    it('обрыв в матче — onHostLost до первой попытки', () => {
      inGame();
      first.close();

      expect(hooks.onHostLost).toHaveBeenCalledTimes(1);
      expect(attempts).toHaveLength(1);
    });

    it('молчание хоста — тоже свидетельство', () => {
      inGame();
      vi.advanceTimersByTime(4100);

      expect(hooks.onHostLost).toHaveBeenCalledTimes(1);
    });

    it('терминальное закрытие — не свидетельство', () => {
      inGame({ isTerminalClose: () => true });
      first.close();

      expect(hooks.onHostLost).not.toHaveBeenCalled();
    });
  });

  describe('смена хоста (host-migration 7.2)', () => {
    it('host_migrating — старый транспорт брошен сразу, его кадры отброшены', () => {
      const supervisor = inGame();

      expect(supervisor.migrate()).toBe(true);
      expect(supervisor.state).toBe(S.migrating);
      expect(first.destroyed).toBe(true);
      expect(supervisor.transport).toBeNull();
      expect(hooks.onStateChange).toHaveBeenLastCalledWith(
        S.migrating,
        S.inGame,
      );

      // зомби-хост ещё шлёт кадры эпохи N
      hooks.onMessage.mockClear();
      first.receive('[10,1]');
      first.close();

      expect(hooks.onMessage).not.toHaveBeenCalled();
      expect(supervisor.state).toBe(S.migrating);
      expect(attempts).toHaveLength(0);
      expect(hooks.onHostLost).not.toHaveBeenCalled();

      // сторожок тишины в ожидании не срабатывает
      vi.advanceTimersByTime(10000);
      expect(supervisor.state).toBe(S.migrating);
    });

    it('host_changed checkpoint — RESUME у нового хоста без свидетельства', () => {
      const supervisor = inGame();

      supervisor.migrate();
      supervisor.hostChanged({ mode: 'checkpoint' });

      expect(supervisor.state).toBe(S.reconnecting);
      expect(hooks.onStateChange).toHaveBeenLastCalledWith(
        S.reconnecting,
        S.migrating,
      );
      expect(attempts).toHaveLength(1);
      expect(hooks.onHostLost).not.toHaveBeenCalled();

      attempts[0].open();
      expect(JSON.parse(attempts[0].sent[0])).toEqual([
        wsports.client.RESUME_REQUEST,
        { v: 1, gameId: 7, resumeKey: 'k1', token: 'tok' },
      ]);

      supervisor.resumeResult({ ok: true, gameId: 7, epoch: 2 });
      expect(supervisor.state).toBe(S.inGame);
      expect(hooks.onResumed).toHaveBeenCalled();

      // таймер ожидания снят: живой хост (кадры идут) — сессия не
      // закроется сама
      for (let i = 0; i < 25; i += 1) {
        vi.advanceTimersByTime(1000);
        attempts[0].receive('[10,1]');
      }

      expect(hooks.onTerminal).not.toHaveBeenCalled();
      expect(supervisor.state).toBe(S.inGame);
    });

    it('host_changed без предшествующего host_migrating бросает старый транспорт', () => {
      const supervisor = inGame();

      supervisor.hostChanged({ mode: 'planned' });

      expect(first.destroyed).toBe(true);
      expect(supervisor.state).toBe(S.reconnecting);
      expect(attempts).toHaveLength(1);
    });

    it('host_changed cold — возобновлять нечего', () => {
      const supervisor = inGame();

      supervisor.migrate();
      supervisor.hostChanged({ mode: 'cold' });

      expect(supervisor.state).toBe(S.closed);
      expect(hooks.onColdRestart).toHaveBeenCalledTimes(1);
      expect(hooks.onTerminal).not.toHaveBeenCalled();
      expect(attempts).toHaveLength(0);

      vi.advanceTimersByTime(TIMING.migrationWaitMs);
      expect(hooks.onTerminal).not.toHaveBeenCalled();
    });

    it('reclaimed в ожидании — возобновление к тому же хосту', () => {
      const supervisor = inGame();

      supervisor.migrate();
      supervisor.hostChanged({ mode: 'reclaimed' });

      expect(supervisor.state).toBe(S.reconnecting);
      expect(attempts).toHaveLength(1);
    });

    it('reclaimed без ожидания — живой транспорт не трогается', () => {
      const supervisor = inGame();

      supervisor.hostChanged({ mode: 'reclaimed' });

      expect(supervisor.state).toBe(S.inGame);
      expect(first.destroyed).toBe(false);
      expect(attempts).toHaveLength(0);
    });

    it('без секрета места — чистый вход в комнату', () => {
      const supervisor = makeSupervisor();

      supervisor.attach(first);
      first.open();
      supervisor.migrate();
      supervisor.hostChanged({ mode: 'checkpoint' });

      expect(supervisor.state).toBe(S.closed);
      expect(hooks.onResumeRejected).toHaveBeenCalledWith('noSession');
      expect(attempts).toHaveLength(0);
    });

    it('host_changed не пришёл за migrationWaitMs — терминально', () => {
      const supervisor = inGame();

      supervisor.migrate();
      vi.advanceTimersByTime(TIMING.migrationWaitMs - 1);
      expect(supervisor.state).toBe(S.migrating);

      vi.advanceTimersByTime(1);
      expect(supervisor.state).toBe(S.closed);
      expect(hooks.onTerminal).toHaveBeenCalledTimes(1);
    });

    it('room_closed в ожидании (close) — терминально один раз', () => {
      const supervisor = inGame();

      supervisor.migrate();
      supervisor.close();

      expect(supervisor.state).toBe(S.closed);
      expect(hooks.onTerminal).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(TIMING.migrationWaitMs);
      expect(hooks.onTerminal).toHaveBeenCalledTimes(1);
    });

    it('посреди переподключения — попытки сняты, ждём нового хоста', () => {
      const supervisor = inGame();

      first.close();
      expect(attempts).toHaveLength(1);

      supervisor.migrate();
      expect(attempts[0].destroyed).toBe(true);

      // окно переподключения больше не закрывает сессию
      vi.advanceTimersByTime(TIMING.reconnectWindowMs);
      expect(supervisor.state).toBe(S.migrating);
      expect(attempts).toHaveLength(1);
    });

    it('без reconnect (вкладка-хост, solo, dedicated) — не мигрирует', () => {
      const supervisor = inGame({ reconnect: null });

      expect(supervisor.migrate()).toBe(false);
      supervisor.hostChanged({ mode: 'cold' });

      expect(supervisor.state).toBe(S.inGame);
      expect(first.destroyed).toBe(false);
      expect(hooks.onColdRestart).not.toHaveBeenCalled();
    });
  });

  describe('сторожок тишины', () => {
    it('хост молчит дольше hostSilenceMs — транспорт закрыт, переподключение', () => {
      const supervisor = inGame();

      vi.advanceTimersByTime(2000);
      first.receive('[10,1]');
      vi.advanceTimersByTime(2999);
      expect(supervisor.state).toBe(S.inGame);

      vi.advanceTimersByTime(1100);
      expect(supervisor.state).toBe(S.reconnecting);
      expect(attempts).toHaveLength(1);
    });

    it('во время загрузки карты молчание законно', () => {
      const supervisor = inGame();

      supervisor.setLoading(true);
      vi.advanceTimersByTime(10000);
      expect(supervisor.state).toBe(S.inGame);

      supervisor.setLoading(false);
      vi.advanceTimersByTime(3000);
      expect(supervisor.state).toBe(S.inGame);
      vi.advanceTimersByTime(1100);
      expect(supervisor.state).toBe(S.reconnecting);
    });

    it('без reconnect сторожка нет', () => {
      const supervisor = inGame({ reconnect: null });

      vi.advanceTimersByTime(60000);
      expect(supervisor.state).toBe(S.inGame);
    });
  });

  describe('смена роли вкладки: resumeWith (host-migration этап 7.4/7.5)', () => {
    const resumeRequest = transport => JSON.parse(transport.sent[0])[1];

    it('преемник: loopback возобновляет место, других попыток и сторожка нет', () => {
      const supervisor = inGame();

      supervisor.migrate();

      const loopback = makeTransport();

      expect(
        supervisor.resumeWith(loopback, {
          reconnect: null,
          getToken: () => 'host-tok',
        }),
      ).toBe(true);
      expect(supervisor.state).toBe(S.reconnecting);
      expect(hooks.onHostLost).not.toHaveBeenCalled();

      loopback.open();

      expect(JSON.parse(loopback.sent[0])[0]).toBe(
        wsports.client.RESUME_REQUEST,
      );
      expect(resumeRequest(loopback)).toMatchObject({
        gameId: 7,
        resumeKey: 'k1',
        token: 'host-tok',
      });

      supervisor.resumeResult({ ok: true, gameId: 7 });

      expect(supervisor.state).toBe(S.inGame);
      expect(hooks.onResumed).toHaveBeenCalled();

      // свой Worker: молчание не повод рвать loopback
      vi.advanceTimersByTime(60000);
      expect(supervisor.state).toBe(S.inGame);

      // ожидание смены хоста снято — его таймер сессию не закроет
      expect(hooks.onTerminal).not.toHaveBeenCalled();
    });

    it('без фабрики попыток закрытие транспорта терминально', () => {
      const supervisor = inGame();
      const loopback = makeTransport();

      supervisor.resumeWith(loopback, { reconnect: null });
      loopback.close();

      expect(supervisor.state).toBe(S.closed);
      expect(hooks.onTerminal).toHaveBeenCalledTimes(1);
      expect(attempts).toHaveLength(0);
    });

    it('бывший хост: первая попытка — данный транспорт, следующие — фабрика', () => {
      const supervisor = inGame({ reconnect: null });
      const guest = makeTransport();
      const reconnect = {
        createTransport: () => {
          const transport = makeTransport();

          attempts.push(transport);

          return transport;
        },
        getToken: () => 'tok',
      };

      supervisor.resumeWith(guest, { reconnect });

      expect(first.destroyed).toBe(true);

      guest.close();
      vi.advanceTimersByTime(500);

      expect(attempts).toHaveLength(1);

      attempts[0].open();
      expect(resumeRequest(attempts[0])).toMatchObject({ token: 'tok' });
    });

    it('без секрета места — чистый вход', () => {
      const supervisor = makeSupervisor();

      supervisor.attach(first);
      first.open();
      supervisor.enterGame();

      const loopback = makeTransport();

      supervisor.resumeWith(loopback, { reconnect: null });

      expect(supervisor.state).toBe(S.closed);
      expect(hooks.onResumeRejected).toHaveBeenCalledWith('noSession');
    });

    describe('onFailed: сбой своего игрока не гасит комнату преемника', () => {
      it('нет секрета места — onFailed, не onResumeRejected', () => {
        const supervisor = makeSupervisor();
        const onFailed = vi.fn();

        supervisor.attach(first);
        first.open();
        supervisor.enterGame();

        expect(supervisor.hasSession).toBe(false);

        supervisor.resumeWith(makeTransport(), { reconnect: null, onFailed });

        expect(onFailed).toHaveBeenCalledWith('noSession');
        expect(hooks.onResumeRejected).not.toHaveBeenCalled();
        expect(hooks.onTerminal).not.toHaveBeenCalled();
        expect(supervisor.state).toBe(S.closed);
      });

      it('RESUME_RESULT !ok — onFailed с причиной', () => {
        const supervisor = inGame();
        const onFailed = vi.fn();
        const loopback = makeTransport();

        expect(supervisor.hasSession).toBe(true);

        supervisor.resumeWith(loopback, { reconnect: null, onFailed });
        loopback.open();
        supervisor.resumeResult({ ok: false, reason: 'unknown' });

        expect(onFailed).toHaveBeenCalledWith('unknown');
        expect(hooks.onResumeRejected).not.toHaveBeenCalled();
        expect(supervisor.state).toBe(S.closed);
      });

      it('loopback закрыт (таймаут RESUME у Worker’а) — onFailed, не onTerminal', () => {
        const supervisor = inGame();
        const onFailed = vi.fn();
        const loopback = makeTransport();

        supervisor.resumeWith(loopback, { reconnect: null, onFailed });
        loopback.close();

        expect(onFailed).toHaveBeenCalledWith('closed');
        expect(hooks.onTerminal).not.toHaveBeenCalled();
      });

      it('окно возврата истекло — onFailed', () => {
        const supervisor = inGame();
        const onFailed = vi.fn();

        supervisor.resumeWith(makeTransport(), { reconnect: null, onFailed });
        vi.advanceTimersByTime(TIMING.reconnectWindowMs);

        expect(onFailed).toHaveBeenCalledWith('timeout');
        expect(hooks.onTerminal).not.toHaveBeenCalled();
      });

      it('успешный возврат снимает колбэк: дальнейшие закрытия — как обычно', () => {
        const supervisor = inGame();
        const onFailed = vi.fn();
        const loopback = makeTransport();

        supervisor.resumeWith(loopback, { reconnect: null, onFailed });
        loopback.open();
        supervisor.resumeResult({ ok: true, gameId: 7 });
        loopback.close();

        expect(onFailed).not.toHaveBeenCalled();
        expect(hooks.onTerminal).toHaveBeenCalledTimes(1);
      });
    });

    it('закрытая сессия роль не меняет', () => {
      const supervisor = inGame();

      supervisor.close();

      expect(supervisor.resumeWith(makeTransport())).toBe(false);
    });
  });
});
