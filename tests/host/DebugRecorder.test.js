import { describe, it, expect, afterEach } from 'vitest';
import DebugRecorder from '../../packages/engine/src/host/DebugRecorder.js';
import { parseScenario } from '../../packages/engine/src/devtools/ScenarioRunner.js';
import {
  createFixtureHost,
  connectPlayer,
  joinTeam,
  pressKey,
  tick,
} from './fixtureHarness.js';

// Рекордер живого матча (этап 6 плана plan/done/ai-debug): записанное вкладкой
// хоста должно быть принято parseScenario без правок — иначе браузерный баг
// не догнать headless-прогоном.

describe('DebugRecorder', () => {
  it('до start() ничего не пишет', () => {
    const recorder = new DebugRecorder();

    recorder.tick(1 / 120);
    recorder.noteKey(1, 'down', 'forward');

    expect(recorder.isRecording).toBe(false);
    expect(recorder.stop()).toBeNull();
  });

  it('уже вошедшие участники становятся join-операциями нулевого тика', () => {
    const recorder = new DebugRecorder();

    recorder.start({
      seed: 7,
      map: 'arena',
      networkSendRate: 4,
      participants: [
        { gameId: 1, name: 'P1', model: 'm1', socketId: 's1', team: 'team1' },
      ],
    });

    const scenario = recorder.stop();

    expect(scenario.participants).toEqual([
      { id: 'p1', name: 'P1', model: 'm1', socketId: 's1' },
    ]);
    expect(scenario.timeline).toEqual([
      { tick: 0, op: 'join', who: 'p1', team: 'team1' },
    ]);
    expect(scenario.seed).toBe(7);
    expect(scenario.map).toBe('arena');
    expect(scenario.config).toEqual({ networkSendRate: 4 });
  });

  it('операции адресуются номером тика', () => {
    const recorder = new DebugRecorder();

    recorder.start({ seed: 1, map: 'arena' });
    recorder.noteJoin({ gameId: 1, name: 'P1', model: 'm1', socketId: 's1' });

    tickTimes(recorder, 10);
    recorder.noteKey(1, 'down', 'forward');
    tickTimes(recorder, 5);
    recorder.noteChat(1, '/nr');
    recorder.noteVote(1, ['teamChange', 'team2']);

    const scenario = recorder.stop();

    expect(scenario.timeline).toEqual([
      { tick: 0, op: 'join', who: 'p1' },
      { tick: 10, op: 'key', who: 'p1', action: 'down', name: 'forward' },
      { tick: 15, op: 'chat', who: 'p1', text: '/nr' },
      { tick: 15, op: 'vote', who: 'p1', data: ['teamChange', 'team2'] },
    ]);
    expect(scenario.ticks).toBe(15);
    expect(scenario.dumpTicks).toEqual([15]);
  });

  it('переиспользованный gameId не склеивает двух участников', () => {
    const recorder = new DebugRecorder();

    recorder.start({ seed: 1, map: 'arena' });
    recorder.noteJoin({ gameId: 1, name: 'P1', model: 'm1', socketId: 's1' });
    recorder.noteLeave(1);
    recorder.noteJoin({ gameId: 1, name: 'P2', model: 'm2', socketId: 's2' });
    recorder.noteKey(1, 'down', 'forward');

    const scenario = recorder.stop();

    expect(scenario.participants.map(p => p.id)).toEqual(['p1', 'p2']);
    expect(scenario.timeline.at(-1)).toMatchObject({ op: 'key', who: 'p2' });
  });

  it('операция участника, вошедшего до записи, не пишется без адресата', () => {
    const recorder = new DebugRecorder();

    recorder.start({ seed: 1, map: 'arena' });
    recorder.noteKey(42, 'down', 'forward');

    expect(recorder.stop().timeline).toEqual([]);
  });

  it('переполнение таймлайна не молчит', () => {
    const recorder = new DebugRecorder({ maxOps: 2, maxDtSamples: 1 });

    recorder.start({ seed: 1, map: 'arena' });
    recorder.noteJoin({ gameId: 1, name: 'P1', model: 'm1', socketId: 's1' });
    tickTimes(recorder, 3);
    recorder.noteKey(1, 'down', 'forward');
    recorder.noteKey(1, 'up', 'forward');

    const scenario = recorder.stop();

    expect(scenario.timeline).toHaveLength(2);
    expect(scenario.meta.droppedOps).toBe(1);
    expect(scenario.meta.dt).toMatchObject({ count: 1, dropped: 2 });
  });

  it('stop() сбрасывает состояние — вторая запись начинается с нуля', () => {
    const recorder = new DebugRecorder();

    recorder.start({ seed: 1, map: 'arena' });
    tickTimes(recorder, 5);
    recorder.stop();

    recorder.start({ seed: 2, map: 'arena2' });
    tickTimes(recorder, 2);

    const scenario = recorder.stop();

    expect(scenario.seed).toBe(2);
    expect(scenario.ticks).toBe(2);
    expect(scenario.timeline).toEqual([]);
  });
});

describe('HostGame: запись живого матча', () => {
  afterEach(() => {
    delete globalThis.__vimpFixtureHost;
  });

  it('записанный матч принимается parseScenario', async () => {
    const { host } = await createFixtureHost({ opts: { seed: 3812 } });

    const gameId = await connectPlayer(host);

    expect(host.startRecording()).toBe(true);
    expect(host.isRecording).toBe(true);

    joinTeam(host, gameId, 'team1');
    tick(host, 10);
    pressKey(host, gameId, 'forward');
    tick(host, 20);
    pressKey(host, gameId, 'forward', 'up');

    const scenario = host.stopRecording();

    expect(host.isRecording).toBe(false);
    expect(scenario.seed).toBe(3812);
    expect(scenario.ticks).toBe(30);

    const parsed = parseScenario(scenario);

    expect(parsed.participants).toHaveLength(1);
    expect(parsed.timeline.map(op => op.op)).toEqual([
      'join',
      'vote',
      'key',
      'key',
    ]);
    // ввод адресован границей тика — очереди у HostGame нет
    expect(parsed.timeline.filter(op => op.op === 'key').map(op => op.tick)).toEqual(
      [10, 30],
    );
  });

  it('без dev-режима рекордера нет, и это не тишина', async () => {
    const { host } = await createFixtureHost({ game: { isDevMode: false } });

    expect(host.startRecording()).toBe(false);
    expect(host.isRecording).toBe(false);
    expect(host.stopRecording()).toBeNull();
  });

  it('дамп кладёт мету хоста рядом с миром ядра', async () => {
    const { host } = await createFixtureHost({ opts: { seed: 11 } });
    const gameId = await connectPlayer(host);

    joinTeam(host, gameId, 'team1');
    tick(host, 3);

    const dump = host.debugSnapshot();

    expect(dump.seed).toBe(11);
    expect(dump.recording).toBe(false);
    expect(dump.currentMap).toBe(host.currentMap);
    expect(dump.participants.humans).toHaveLength(1);
    expect(dump.participants.activeList).toContain(gameId);
    expect(dump.core).not.toBeNull();
  });

  it('хостовые логи уходят клиенту портом CONSOLE', async () => {
    const { host, socket } = await createFixtureHost();

    await connectPlayer(host);
    host.startRecording();
    host.stopRecording();

    const logs = socket.framesOf('sendConsole');

    expect(logs).toHaveLength(2);
    expect(logs[0].args[0]).toContain('recording started');
    expect(logs[1].args[0]).toContain('recording stopped');
  });
});

function tickTimes(recorder, n) {
  for (let i = 0; i < n; i += 1) {
    recorder.tick(1 / 120);
  }
}
