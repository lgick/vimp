import { describe, it, expect, beforeAll } from 'vitest';
import {
  runScenario,
  parseScenario,
} from '../../packages/engine/src/devtools/ScenarioRunner.js';
import { loadGameForSim } from '../../packages/engine/src/devtools/pluginLoader.js';

// Сценарий-смоук на фикстуре: игрок заходит, едет вперёд, отпускает клавишу.
const scenario = () => ({
  version: 1,
  seed: 3812,
  config: { timers: { networkSendRate: 1 } },
  participants: [{ id: 'p1', name: 'P1', model: 'm1' }],
  timeline: [
    { tick: 0, op: 'join', who: 'p1', team: 'team1' },
    { tick: 5, op: 'key', who: 'p1', action: 'down', name: 'forward' },
    { tick: 40, op: 'key', who: 'p1', action: 'up', name: 'forward' },
  ],
  ticks: 60,
  dumpTicks: [6, 60],
  // событийный ключ схемы фикстуры в этом сценарии не стреляет
  unusedSnapshotKeys: ['e1'],
});

describe('parseScenario', () => {
  it('отвергает чужую версию формата', () => {
    expect(() => parseScenario({ version: 2, participants: [{}] })).toThrow(
      /unsupported version/,
    );
  });

  it('требует участников', () => {
    expect(() => parseScenario({ version: 1, participants: [] })).toThrow(
      /participants/,
    );
  });

  it('сортирует таймлайн по тикам и подставляет дефолты', () => {
    const parsed = parseScenario({
      version: 1,
      participants: [{ id: 'p1' }],
      timeline: [{ tick: 10 }, { tick: 2 }],
    });

    expect(parsed.timeline.map(op => op.tick)).toEqual([2, 10]);
    expect(parsed.seed).toBe(1);
    expect(parsed.ticks).toBe(600);
  });
});

describe('runScenario (фикстура miniGame)', () => {
  let plugin;
  let report;

  beforeAll(async () => {
    plugin = await loadGameForSim({});
    report = await runScenario(scenario(), { plugin });
  });

  it('замыкает контур: хост → байты кадра → клиентское ядро → сцена', () => {
    const client = report.clients[0];

    expect(report.frameCounts.sendShot).toBeGreaterThan(0);
    expect(client.frameCount).toBe(report.frameCounts.sendShot);
    // ключ снапшот-схемы фикстуры доехал до сцены со своим актором
    expect(Object.keys(client.entities)).toEqual(['a1']);
    expect(Object.keys(client.entities.a1)).toHaveLength(1);
  });

  it('поля записи разложены по схеме игры (x, y, angle, team)', () => {
    const [fields] = Object.values(report.clients[0].entities.a1);

    expect(fields).toHaveLength(4);
    expect(fields.every(Number.isFinite)).toBe(true);
  });

  it('ввод доезжает до симуляции: игрок сместился вперёд', () => {
    const [before] = report.scenes;
    const after = report.scenes[report.scenes.length - 1];
    const y = scene => Object.values(scene.clients[0].entities.a1)[0][1];

    expect(before.tick).toBe(6);
    expect(after.tick).toBe(60);
    expect(y(after)).toBeLessThan(y(before));
  });

  it('срез сцены несёт дамп мира ядра и клиентского буфера', () => {
    const scene = report.scenes[report.scenes.length - 1];

    expect(scene.core.bodies).toHaveLength(1);
    expect(scene.core.map.setId).toBe('m1');
    expect(scene.clients[0].debug.interpolator.lastFrame.seq).toBeGreaterThan(0);
  });

  it('нет нарушений контракта клиентской раскладки', () => {
    expect(report.clients[0].decodeErrors).toEqual([]);
  });

  it('seed сценария доезжает до ядра', () => {
    expect(report.seed).toBe(3812);
  });

  it('config сценария переопределяет таймеры игры', () => {
    // networkSendRate: 1 — кадр на каждый тик
    expect(report.frameCounts.sendShot).toBe(60);
  });

  it('прогон на фикстуре не нарушает ни одного инварианта', () => {
    const failed = report.invariants.filter(check => check.status === 'fail');

    expect(failed).toEqual([]);
    expect(report.invariantSummary.violations).toBe(0);
  });

  it('детектор рассинхрона сравнивает предикт с player-блоком каждого кадра', async () => {
    const drift = report.clients[0].divergence;
    const check = report.invariants.find(
      item => item.name === 'predictionDrift',
    );

    expect(drift.samples).toBe(report.frameCounts.sendShot - 1);
    expect(drift.violations).toBe(0);
    expect(check.status).toBe('pass');
  });

  it('инвариант 9 ловит дрейф, как только порог опущен ниже него', async () => {
    const strict = scenario();

    // проверка самой проверки: предикт фикстуры сходится с хостом лишь до
    // ошибки округления — нулевой порог обязан это увидеть
    strict.divergence = { defaultThreshold: 0 };

    const result = await runScenario(strict, { plugin });
    const check = result.invariants.find(
      item => item.name === 'predictionDrift',
    );

    expect(check.status).toBe('fail');
    expect(check.violations[0]).toMatch(/source 'state'/);
    expect(check.violations[0]).toMatch(/replayed \d+ input\(s\)/);
  });

  it('divergence: null отключает детектор — прогон остаётся боевым', async () => {
    const off = scenario();

    off.divergence = null;

    const result = await runScenario(off, { plugin });

    expect(result.clients[0].divergence).toBeNull();
    expect(
      result.invariants.find(item => item.name === 'predictionDrift').status,
    ).toBe('skip');
  });

  it('инвариант 2 ловит ключ схемы, не давший ни одной строки', async () => {
    const broken = scenario();

    delete broken.unusedSnapshotKeys;

    const result = await runScenario(broken, { plugin });
    const check = result.invariants.find(
      item => item.name === 'snapshotKeysUsed',
    );

    expect(check.status).toBe('fail');
    expect(check.violations[0]).toMatch(/snapshot key 'e1' never produced a row/);
  });

  it('два прогона одного сценария дают одинаковый поток кадров', async () => {
    const first = await runScenario(scenario(), {
      plugin,
      captureFrames: true,
    });
    const second = await runScenario(scenario(), {
      plugin,
      captureFrames: true,
    });

    expect(first.shotHashes).toHaveLength(first.frameCounts.sendShot);
    expect(second.shotHashes).toEqual(first.shotHashes);
  });

  it('без captureFrames поток кадров в отчёт не попадает', () => {
    // на длинном матче это была бы линейная по числу тиков нагрузка в
    // report.json, нужная одной-единственной проверке
    expect(report.shotHashes).toBeNull();
  });

  it('таймеры сценария едут только через config.timers', async () => {
    const custom = scenario();

    custom.config = { timers: { networkSendRate: 2 } };

    const result = await runScenario(custom, { plugin });

    expect(result.frameCounts.sendShot).toBe(30);
  });

  it('join неизвестного участника — внятная ошибка, а не молчание', async () => {
    const broken = scenario();

    broken.timeline = [{ tick: 0, op: 'join', who: 'ghost' }];

    await expect(runScenario(broken, { plugin })).rejects.toThrow(
      /unknown participant 'ghost'/,
    );
  });

  it('ввод от неприсоединившегося участника — внятная ошибка', async () => {
    const broken = scenario();

    broken.timeline = [
      { tick: 0, op: 'key', who: 'p1', action: 'down', name: 'forward' },
    ];

    await expect(runScenario(broken, { plugin })).rejects.toThrow(
      /has not joined yet/,
    );
  });

  it('неизвестная операция таймлайна не проглатывается', async () => {
    const broken = scenario();

    broken.timeline = [{ tick: 0, op: 'teleport', who: 'p1' }];

    await expect(runScenario(broken, { plugin })).rejects.toThrow(
      /unknown op 'teleport'/,
    );
  });
});
