import { describe, it, expect } from 'vitest';
import {
  checkInvariants,
  checkDeterminism,
  summarize,
  PASS,
  FAIL,
  SKIP,
} from '../../packages/engine/src/devtools/invariants.js';

// Проверка самих проверок: каждый инвариант обязан ловить свой класс
// молчаливого отказа и не срабатывать на здоровом прогоне. Контекст здесь
// синтетический — прогон целиком через runScenario стоит дорого, а нужен
// именно точечный разлом контракта.

const schema = {
  a1: {
    id: 1,
    kind: 'indexed8',
    class: 'hot',
    fields: [{ name: 'x' }, { name: 'y' }, { name: 'angle' }, { name: 'team' }],
  },
};

const game = () => ({
  snapshot: schema,
  panel: { fields: { energy: { key: 'h', value: 100 } }, activeKey: null },
  playerKeys: { forward: {}, back: {} },
  spectatorKeys: { nextPlayer: 'nextPlayer', prevPlayer: 'prevPlayer' },
  teams: { team1: 1, spectators: 2 },
  timers: { roundRestartDelay: 5000 },
});

const clientConfig = () => ({
  parts: {
    gameSets: { a1: ['Actor'] },
    entitiesOnCanvas: { Actor: 'vimp' },
  },
  modules: {
    panel: {
      keys: { h: 'energy', t: 'time' },
      fields: [{ name: 'energy' }, { name: 'time' }],
    },
    controls: { keySetList: [{}, { 87: 'forward', 83: 'back' }] },
  },
});

const client = (overrides = {}) => ({
  socketId: 'sock-p1',
  observed: { a1: { rows: 10, ids: new Set(['0']), widths: new Set([4]) } },
  nonFinite: [],
  hotLayoutErrors: [],
  decodeErrors: [],
  truncated: { nonFinite: 0, hotLayoutErrors: 0 },
  received: { panel: [['t:60', 'h:100']] },
  core: { decode_frame: () => '{"port":5}' },
  ...overrides,
});

// кадр в движковом фрейминге: порт SHOT_DATA + версия формата
const frame = (port = 5, version = 3) => ({
  method: 'sendShot',
  socketId: 'sock-p1',
  tick: 0,
  args: [new Uint8Array([port, version, 0, 0, 0, 1])],
});

const socketManager = (frames = [frame()]) => ({
  frames,
  framesOf: method => frames.filter(item => item.method === method),
});

const context = (overrides = {}) => ({
  scenario: {
    ticks: 120,
    timeline: [{ tick: 5, op: 'key', who: 'p1', action: 'down', name: 'forward' }],
    unusedSnapshotKeys: [],
  },
  game: game(),
  clientConfig: clientConfig(),
  clients: [client()],
  socketManager: socketManager(),
  core: { players_data: () => '[{"id":0}]' },
  hostState: { activeList: ['0'], humans: ['0'], scripted: [], total: 1 },
  participantLog: [
    { who: 'p1', socketId: 'sock-p1', gameId: '0', joinTick: 0, leaveTick: null },
  ],
  stepMs: 16,
  ...overrides,
});

const check = (name, ctx) => checkInvariants(ctx).find(item => item.name === name);

describe('checkInvariants — здоровый прогон', () => {
  it('не выдумывает нарушений', () => {
    const results = checkInvariants(context());
    const summary = summarize(results);

    expect(results).toHaveLength(12);
    expect(summary.failed).toBe(0);
    expect(summary.violations).toBe(0);
    // 9 — без данных детектора рассинхрона, 10 — без конца раунда,
    // 12 — без второго прогона
    expect(summary.skipped).toBe(3);
  });
});

describe('1. finiteValues', () => {
  it('ловит NaN в декодированном поле', () => {
    const broken = client({
      nonFinite: [{ key: 'a1', id: '0', index: 1, value: 'NaN' }],
    });
    const result = check('finiteValues', context({ clients: [broken] }));

    expect(result.status).toBe(FAIL);
    expect(result.violations[0]).toMatch(/'a1' id 0 field #1 is NaN/);
  });
});

describe('2. snapshotKeysUsed', () => {
  it('ловит ключ схемы, не давший ни одной строки', () => {
    const ctx = context();

    ctx.game.snapshot = { ...schema, e1: { id: 2, fields: [] } };

    const result = check('snapshotKeysUsed', ctx);

    expect(result.status).toBe(FAIL);
    expect(result.violations[0]).toMatch(/'e1' never produced a row/);
  });

  it('молчит, если ключ объявлен неиспользуемым', () => {
    const ctx = context();

    ctx.game.snapshot = { ...schema, e1: { id: 2, fields: [] } };
    ctx.scenario.unusedSnapshotKeys = ['e1'];

    expect(check('snapshotKeysUsed', ctx).status).toBe(PASS);
  });

  it('ловит и обратное: объявлен неиспользуемым, но приехал', () => {
    const ctx = context();

    ctx.scenario.unusedSnapshotKeys = ['a1'];

    expect(check('snapshotKeysUsed', ctx).violations[0]).toMatch(
      /declared unused but did produce rows/,
    );
  });
});

describe('3. fieldWidths', () => {
  it('ловит расхождение числа полей со схемой', () => {
    const broken = client({
      observed: { a1: { rows: 5, ids: new Set(['0']), widths: new Set([3]) } },
    });
    const result = check('fieldWidths', context({ clients: [broken] }));

    expect(result.status).toBe(FAIL);
    expect(result.violations[0]).toMatch(
      /'a1' decoded 3 field\(s\), schema declares 4/,
    );
  });
});

describe('4. frameFormat', () => {
  it('ловит чужую версию формата кадра', () => {
    const ctx = context({ socketManager: socketManager([frame(5, 2)]) });
    const result = check('frameFormat', ctx);

    expect(result.status).toBe(FAIL);
    expect(result.violations[0]).toMatch(/version byte 2 != SNAPSHOT_FORMAT_VERSION/);
  });

  it('ловит отказ decode_frame', () => {
    const broken = client({ core: { decode_frame: () => 'null' } });
    const result = check('frameFormat', context({ clients: [broken] }));

    expect(result.violations[0]).toMatch(/decode_frame\(\) rejected/);
  });

  it('пропускает ядро с собственным фреймингом, но не глотает ошибки декода', () => {
    const ctx = context({ socketManager: socketManager([frame(123, 0)]) });

    expect(check('frameFormat', ctx).status).toBe(SKIP);

    ctx.clients = [client({ decodeErrors: [{ message: 'boom' }] })];

    expect(check('frameFormat', ctx).status).toBe(FAIL);
  });

  it('ловит прогон, в котором хост не отправил ни кадра', () => {
    const ctx = context({ socketManager: socketManager([]) });

    expect(check('frameFormat', ctx).violations[0]).toMatch(/no frames at all/);
  });
});

describe('5. hotLayout', () => {
  it('ловит дрейф раскладки hot-буфера', () => {
    const broken = client({ hotLayoutErrors: [{ len: 12, consumed: 10 }] });
    const result = check('hotLayout', context({ clients: [broken] }));

    expect(result.status).toBe(FAIL);
    expect(result.violations[0]).toMatch(/len 12, traversal consumed 10/);
  });
});

describe('6. panelContract', () => {
  it('ловит поле панели, которое ни разу не доехало', () => {
    const broken = client({ received: { panel: [] } });
    const result = check('panelContract', context({ clients: [broken] }));

    expect(result.violations[0]).toMatch(/'energy' \(key 'h'\) never reached/);
  });

  it('ловит ключ панели, которого нет в клиентском конфиге', () => {
    const ctx = context();

    delete ctx.clientConfig.modules.panel.keys.t;

    expect(check('panelContract', ctx).violations.join()).toMatch(
      /panel key 't' was sent but is missing/,
    );
  });

  it('ловит ключ, разложенный в несуществующую ячейку панели', () => {
    const ctx = context();

    // имя ячейки на клиенте своё (не обязано совпадать с именем поля
    // хоста), но оно обязано быть в modules.panel.fields
    ctx.clientConfig.modules.panel.keys.h = 'health';

    expect(check('panelContract', ctx).violations.join()).toMatch(
      /maps to 'health', which is missing from modules\.panel\.fields/,
    );
  });

  it('не считает нарушением собственное имя ячейки на клиенте', () => {
    const ctx = context();

    ctx.clientConfig.modules.panel.keys.h = 'health';
    ctx.clientConfig.modules.panel.fields.push({ name: 'health' });

    expect(check('panelContract', ctx).status).toBe(PASS);
  });
});

describe('7. renderCoverage', () => {
  it('ловит живой ключ, не покрытый gameSets («чёрный холст»)', () => {
    const ctx = context();

    delete ctx.clientConfig.parts.gameSets.a1;

    expect(check('renderCoverage', ctx).violations[0]).toMatch(
      /missing from parts.gameSets/,
    );
  });

  it('ловит part без записи в entitiesOnCanvas', () => {
    const ctx = context();

    delete ctx.clientConfig.parts.entitiesOnCanvas.Actor;

    expect(check('renderCoverage', ctx).violations[0]).toMatch(
      /missing from parts.entitiesOnCanvas/,
    );
  });
});

describe('8. keyBindings', () => {
  it('ловит клавишу сценария, неизвестную хосту', () => {
    const ctx = context();

    ctx.scenario.timeline = [{ tick: 1, op: 'key', name: 'jump' }];

    expect(check('keyBindings', ctx).violations[0]).toMatch(
      /key 'jump' at tick 1, which the host does not know/,
    );
  });

  it('ловит playerKeys без привязки в keyset клиента', () => {
    const ctx = context();

    ctx.clientConfig.modules.controls.keySetList = [{}, { 87: 'forward' }];

    expect(check('keyBindings', ctx).violations[0]).toMatch(
      /'back', but no client keyset binds it/,
    );
  });

  it('ловит keyset, привязанный к несуществующему действию', () => {
    const ctx = context();

    ctx.clientConfig.modules.controls.keySetList = [
      {},
      { 87: 'forward', 83: 'back', 74: 'fire' },
    ];

    expect(check('keyBindings', ctx).violations[0]).toMatch(/binds 'fire'/);
  });
});

describe('9. predictionDrift', () => {
  const drifted = (records, stats = {}) =>
    client({
      divergence: records,
      divergenceStats: {
        samples: 30,
        violations: records.length,
        dropped: 0,
        ...stats,
      },
      truncated: { nonFinite: 0, hotLayoutErrors: 0, divergence: 0 },
    });

  const record = {
    source: 'state',
    serverTime: 1200,
    offset: 30,
    delta: [12.5, 0],
    predicted: [112.5, 0],
    authoritative: [100, 0],
    thresholds: [1, 1],
    exceeded: [0],
    replayed: { from: 1100, to: 1200, count: 3 },
  };

  it('без данных детектора — skip, а не молчаливый pass', () => {
    const result = check('predictionDrift', context());

    expect(result.status).toBe(SKIP);
    expect(result.note).toMatch(/no divergence data/);
  });

  it('детектор включён, но player-блоков не было — skip', () => {
    const ctx = context({
      clients: [drifted([], { samples: 0, violations: 0 })],
    });

    expect(check('predictionDrift', ctx).status).toBe(SKIP);
  });

  it('прогон без расхождений — pass с числом реконсиляций', () => {
    const ctx = context({ clients: [drifted([])] });
    const result = check('predictionDrift', ctx);

    expect(result.status).toBe(PASS);
    expect(result.note).toMatch(/30 reconciliation\(s\) compared by frame time/);
  });

  it('ловит дрейф компонента: индекс, порог и окно переигранного ввода', () => {
    const ctx = context({ clients: [drifted([record])] });
    const result = check('predictionDrift', ctx);

    expect(result.status).toBe(FAIL);
    expect(result.violations[0]).toMatch(/serverTime 1200, offset 30/);
    expect(result.violations[0]).toMatch(
      /#0 Δ12.5 > 1 \(predicted 112.5, authoritative 100\)/,
    );
    expect(result.violations[0]).toMatch(
      /replayed 3 input\(s\) in \[1100, 1200\]/,
    );
  });

  it('вытесненные и урезанные записи не теряются — они счётчиком', () => {
    const ctx = context({
      clients: [
        client({
          divergence: [record],
          divergenceStats: { samples: 30, violations: 25, dropped: 4 },
          truncated: { nonFinite: 0, hotLayoutErrors: 0, divergence: 2 },
        }),
      ],
    });

    expect(check('predictionDrift', ctx).violations[1]).toMatch(
      /\+6 more divergence record\(s\)/,
    );
  });
});

describe('10. roundLifecycle', () => {
  const roundEnd = (tick, winner) => ({
    method: 'sendRoundEnd',
    socketId: 'sock-p1',
    tick,
    args: [winner],
  });
  const roundStart = tick => ({
    method: 'sendGameInform',
    socketId: 'sock-p1',
    tick,
    args: ['roundStart'],
  });

  it('без завершившегося раунда проверять нечего', () => {
    expect(check('roundLifecycle', context()).status).toBe(SKIP);
  });

  it('ловит неизвестного победителя', () => {
    const ctx = context({
      socketManager: socketManager([roundEnd(10, 'team9'), roundStart(20)]),
    });

    expect(check('roundLifecycle', ctx).violations[0]).toMatch(
      /unknown winner 'team9'/,
    );
  });

  it('ловит раунд, который закончился и не перезапустился', () => {
    const ctx = context({ socketManager: socketManager([roundEnd(10, 'team1')]) });

    ctx.game.timers.roundRestartDelay = 160; // 10 тиков — прогон это переживёт

    expect(check('roundLifecycle', ctx).violations[0]).toMatch(
      /no round start after the round end at tick 10/,
    );
  });

  it('не требует перезапуска, если прогон кончился раньше задержки', () => {
    const ctx = context({ socketManager: socketManager([roundEnd(115, 'team1')]) });

    ctx.game.timers.roundRestartDelay = 160;

    expect(check('roundLifecycle', ctx).status).toBe(PASS);
  });

  it('ловит участника, до которого не доехал roundEnd', () => {
    const ctx = context({
      socketManager: socketManager([roundEnd(10, 'team1'), roundStart(20)]),
    });

    ctx.participantLog.push({
      who: 'p2',
      socketId: 'sock-p2',
      gameId: '1',
      joinTick: 0,
      leaveTick: null,
    });
    ctx.hostState.humans = ['0', '1'];

    expect(check('roundLifecycle', ctx).violations[0]).toMatch(
      /never reached 'p2'/,
    );
  });

  it('ловит утечку участника в реестре хоста', () => {
    const ctx = context();

    ctx.participantLog[0].leaveTick = 50;

    expect(check('roundLifecycle', ctx).violations[0]).toMatch(
      /participant 0 left the scenario but is still in the host registry/,
    );
  });
});

describe('11. actorLeak', () => {
  it('ловит актора, оставшегося в ядре после выхода участника', () => {
    const ctx = context({ core: { players_data: () => '[{"id":0},{"id":7}]' } });

    expect(check('actorLeak', ctx).violations[0]).toMatch(
      /actor 7 lives in the core but is not an active participant/,
    );
  });

  it('ловит активного участника без актора в ядре', () => {
    const ctx = context({ core: { players_data: () => '[]' } });

    expect(check('actorLeak', ctx).violations[0]).toMatch(
      /participant 0 is active but has no actor/,
    );
  });

  it('принимает объектную форму players_data', () => {
    const ctx = context({ core: { players_data: () => '{"0":{"x":1}}' } });

    expect(check('actorLeak', ctx).status).toBe(PASS);
  });

  // боевая форма FIRST_SHOT_DATA: ключ схемы → id → строка полей
  it('принимает снапшот-форму players_data', () => {
    const ctx = context({
      core: { players_data: () => '{"m1":{"0":[1,2,3]}}' },
    });

    expect(check('actorLeak', ctx).status).toBe(PASS);
  });

  it('ловит лишнего актора в снапшот-форме', () => {
    const ctx = context({
      core: { players_data: () => '{"m1":{"0":[1],"7":[2]}}' },
    });

    expect(check('actorLeak', ctx).violations[0]).toMatch(/actor 7 lives/);
  });
});

describe('12. determinism', () => {
  it('ловит расхождение потоков кадров', () => {
    const result = checkDeterminism(
      { shotBytes: ['aa', 'bb'] },
      { shotBytes: ['aa', 'cc'] },
    );

    expect(result.status).toBe(FAIL);
    expect(result.violations[0]).toMatch(/frame #1 differs/);
  });

  it('ловит разное число кадров', () => {
    const result = checkDeterminism({ shotBytes: ['aa'] }, { shotBytes: [] });

    expect(result.violations[0]).toMatch(/frame count differs: 1 vs 0/);
  });

  it('совпавшие прогоны — зелёный вердикт', () => {
    expect(
      checkDeterminism({ shotBytes: ['aa'] }, { shotBytes: ['aa'] }).status,
    ).toBe(PASS);
  });
});
