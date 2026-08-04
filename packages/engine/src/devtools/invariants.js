import wsports from '../config/wsports.js';
import { SNAPSHOT_FORMAT_VERSION } from '../config/opcodes.js';

// Проверки контракта «движок ↔ игра» по итогам headless-прогона. Смысл
// ровно один: молчаливый отказ (чёрный холст, пустая панель, сущность,
// которая не спавнится) обязан становиться строкой текста с именем
// нарушенного контракта — иначе автору плагина (человеку или нейросети)
// не за что зацепиться.
//
// Проверка либо pass, либо fail, либо skip — skip означает «в этом прогоне
// нечего проверять» (например, детерминизм требует второго прогона) и
// никогда не маскирует нарушение.

export const PASS = 'pass';
export const FAIL = 'fail';
export const SKIP = 'skip';

// список проверок в порядке plan/ai-debug/stage_3.md
const CHECKS = [
  [1, 'finiteValues', 'no NaN/Infinity in decoded fields and hot buffer'],
  [2, 'snapshotKeysUsed', 'every snapshot key produced at least one row'],
  [3, 'fieldWidths', 'decoded field count matches the schema'],
  [4, 'frameFormat', 'frame version byte and decode_frame'],
  [5, 'hotLayout', 'hot buffer traversal consumes exactly len floats'],
  [6, 'panelContract', 'panel fields reach the client config'],
  [7, 'renderCoverage', 'gameSets/entitiesOnCanvas cover every live key'],
  [8, 'keyBindings', 'playerKeys ↔ client keysets ↔ scenario input'],
  [9, 'predictionDrift', 'client prediction drift below the threshold'],
  [10, 'roundLifecycle', 'round ends, winner announced, respawns happened'],
  [11, 'actorLeak', 'players_data() matches the active participants'],
  [12, 'determinism', 'two runs produce a byte-identical frame stream'],
];

const TITLES = new Map(CHECKS.map(([id, name, title]) => [name, { id, title }]));

/**
 * Выполняет проверки 1–11 по итогам прогона (12 — только по требованию,
 * см. checkDeterminism).
 * @param {Object} ctx
 * @param {Object} ctx.scenario - Нормализованный сценарий.
 * @param {Object} ctx.game - Конфиг игры хоста (после room-переопределений).
 * @param {Object} ctx.clientConfig - CONFIG_DATA клиента.
 * @param {Array} ctx.clients - VirtualClient'ы прогона.
 * @param {Object} ctx.socketManager - RecordingSocketManager.
 * @param {Object} ctx.core - Ядро игры хоста.
 * @param {Object} ctx.hostState - Срез меты хоста (inspectHost).
 * @param {Array} ctx.participantLog - [{ who, socketId, gameId, joinTick,
 *   leaveTick }].
 * @param {number} ctx.stepMs
 * @returns {Array<Object>} Результаты проверок.
 */
export function checkInvariants(ctx) {
  return [
    finiteValues(ctx),
    snapshotKeysUsed(ctx),
    fieldWidths(ctx),
    frameFormat(ctx),
    hotLayout(ctx),
    panelContract(ctx),
    renderCoverage(ctx),
    keyBindings(ctx),
    predictionDrift(ctx),
    roundLifecycle(ctx),
    actorLeak(ctx),
    result('determinism', SKIP, [], 'run with --determinism'),
  ];
}

/**
 * Инвариант 12: два прогона одного сценария обязаны совпасть побайтово.
 * @param {Object} first - Отчёт первого прогона.
 * @param {Object} second - Отчёт второго прогона.
 * @returns {Object} Результат проверки.
 */
export function checkDeterminism(first, second) {
  const a = first.shotBytes;
  const b = second.shotBytes;

  if (a.length !== b.length) {
    return result('determinism', FAIL, [
      `frame count differs: ${a.length} vs ${b.length}`,
    ]);
  }

  const index = a.findIndex((frame, i) => frame !== b[i]);

  if (index !== -1) {
    return result('determinism', FAIL, [
      `frame #${index} differs between the two runs`,
    ]);
  }

  return result('determinism', PASS, []);
}

/**
 * Сводка по результатам проверок.
 * @param {Array<Object>} results
 * @returns {Object} { passed, failed, skipped, violations }.
 */
export function summarize(results) {
  return {
    passed: results.filter(r => r.status === PASS).length,
    failed: results.filter(r => r.status === FAIL).length,
    skipped: results.filter(r => r.status === SKIP).length,
    violations: results.reduce((sum, r) => sum + r.violations.length, 0),
  };
}

// ***** проверки ***** //

// 1
function finiteValues({ clients }) {
  const violations = [];

  for (const client of clients) {
    for (const item of client.nonFinite) {
      violations.push(
        `${client.socketId}: '${item.key}' id ${item.id} field #${item.index} is ${item.value}`,
      );
    }

    if (client.truncated.nonFinite) {
      violations.push(
        `${client.socketId}: +${client.truncated.nonFinite} more non-finite value(s)`,
      );
    }
  }

  return verdict('finiteValues', violations);
}

// 2
function snapshotKeysUsed({ game, clients, scenario }) {
  const declared = Object.keys(game.snapshot);
  const unused = new Set(scenario.unusedSnapshotKeys);
  const seen = new Set();

  for (const client of clients) {
    for (const [key, stats] of Object.entries(client.observed)) {
      if (stats.rows) {
        seen.add(key);
      }
    }
  }

  const violations = declared
    .filter(key => !seen.has(key) && !unused.has(key))
    .map(
      key =>
        `snapshot key '${key}' never produced a row — entity does not spawn, ` +
        `key id mismatch, or declare it in scenario.unusedSnapshotKeys`,
    );

  for (const key of unused) {
    if (seen.has(key)) {
      violations.push(
        `snapshot key '${key}' is declared unused but did produce rows`,
      );
    }
  }

  return verdict('snapshotKeysUsed', violations);
}

// 3
function fieldWidths({ game, clients }) {
  const violations = [];

  for (const client of clients) {
    for (const [key, stats] of Object.entries(client.observed)) {
      const schema = game.snapshot[key];

      if (!schema) {
        continue; // ключ вне схемы — это инвариант 7
      }

      for (const width of stats.widths) {
        if (width !== schema.fields.length) {
          violations.push(
            `${client.socketId}: '${key}' decoded ${width} field(s), ` +
              `schema declares ${schema.fields.length} ` +
              `(${schema.fields.map(f => f.name).join(', ')})`,
          );
        }
      }
    }
  }

  return verdict('fieldWidths', violations);
}

// 4
function frameFormat({ clients, socketManager }) {
  const violations = [];
  const frames = socketManager.framesOf('sendShot');

  if (!frames.length) {
    return result('frameFormat', FAIL, ['the host sent no frames at all']);
  }

  for (const client of clients) {
    for (const error of client.decodeErrors) {
      violations.push(`${client.socketId}: push_frame threw — ${error.message}`);
    }
  }

  const bytes = toBytes(frames[0].args[0]);

  // фикстуры и экспериментальные ядра вправе не использовать движковый
  // фрейминг — тогда проверять версию не по чему, но и молчать нельзя
  if (bytes[0] !== wsports.server.SHOT_DATA) {
    return result(
      'frameFormat',
      violations.length ? FAIL : SKIP,
      violations,
      `frames do not start with the SHOT_DATA port byte ` +
        `(${bytes[0]}) — the core uses its own framing`,
    );
  }

  const versions = new Set(frames.map(frame => toBytes(frame.args[0])[1]));

  for (const version of versions) {
    if (version !== SNAPSHOT_FORMAT_VERSION) {
      violations.push(
        `frame version byte ${version} != SNAPSHOT_FORMAT_VERSION ` +
          `${SNAPSHOT_FORMAT_VERSION} — the client drops such frames`,
      );
    }
  }

  // decode_frame — чистая распаковка того же кадра: 'null' означает, что
  // кадр повреждён или собран не по формату
  const client = clients[0];

  if (client && typeof client.core.decode_frame === 'function') {
    const decoded = client.core.decode_frame(bytes);

    if (!decoded || decoded === 'null') {
      violations.push('decode_frame() rejected the first frame');
    }
  }

  return verdict('frameFormat', violations);
}

// 5
function hotLayout({ clients }) {
  const violations = [];

  for (const client of clients) {
    for (const item of client.hotLayoutErrors) {
      violations.push(
        item.message
          ? `${client.socketId}: ${item.message} (len ${item.len})`
          : `${client.socketId}: hot buffer len ${item.len}, traversal consumed ` +
            `${item.consumed} — record width or group order drifted`,
      );
    }

    if (client.truncated.hotLayoutErrors) {
      violations.push(
        `${client.socketId}: +${client.truncated.hotLayoutErrors} more layout mismatch(es)`,
      );
    }
  }

  return verdict('hotLayout', violations);
}

// 6
function panelContract({ game, clientConfig, clients }) {
  const fields = game.panel?.fields ?? {};
  const clientPanel = clientConfig.modules?.panel ?? {};
  const clientKeys = clientPanel.keys ?? {};
  const clientNames = new Set((clientPanel.fields ?? []).map(f => f.name));
  const violations = [];
  const seenKeys = new Set();

  for (const client of clients) {
    for (const payload of client.received.panel) {
      for (const entry of payload) {
        seenKeys.add(String(entry).split(':')[0]);
      }
    }
  }

  for (const [name, spec] of Object.entries(fields)) {
    if (!seenKeys.has(spec.key)) {
      violations.push(
        `panel field '${name}' (key '${spec.key}') never reached a client — no panelSet`,
      );
    }

    // имя поля на клиенте своё (modules.panel.keys — это словарь
    // «ключ провода → имя ячейки»), совпадать с именем поля хоста оно не
    // обязано; контракт в том, что ключ вообще разложен в ячейку панели
    const clientName = clientKeys[spec.key];

    if (!clientName) {
      violations.push(
        `panel field '${name}' (key '${spec.key}') is missing from ` +
          'modules.panel.keys of the client config',
      );
    } else if (!clientNames.has(clientName)) {
      violations.push(
        `panel key '${spec.key}' maps to '${clientName}', which is missing ` +
          'from modules.panel.fields of the client config',
      );
    }
  }

  for (const key of seenKeys) {
    if (!clientKeys[key]) {
      violations.push(
        `panel key '${key}' was sent but is missing from modules.panel.keys ` +
          `of the client config — the client cannot render it`,
      );
    }
  }

  return verdict('panelContract', violations);
}

// 7
function renderCoverage({ clientConfig, clients }) {
  const gameSets = clientConfig.parts.gameSets;
  const entities = clientConfig.parts.entitiesOnCanvas;
  const violations = [];

  for (const key of liveKeys(clients)) {
    const names = gameSets[key];

    if (!names) {
      violations.push(
        `snapshot key '${key}' is live in frames but missing from parts.gameSets — black canvas`,
      );
      continue;
    }

    for (const name of names) {
      if (!entities[name]) {
        violations.push(
          `part '${name}' (key '${key}') is missing from parts.entitiesOnCanvas`,
        );
      }
    }
  }

  return verdict('renderCoverage', violations);
}

// 8
function keyBindings({ game, clientConfig, scenario }) {
  const playerKeys = Object.keys(game.playerKeys ?? {});
  const spectatorKeys = Object.values(game.spectatorKeys ?? {});
  const known = new Set([...playerKeys, ...spectatorKeys]);
  const keySets = clientConfig.modules?.controls?.keySetList ?? [];
  const bound = new Set(keySets.flatMap(set => Object.values(set)));
  const violations = [];

  for (const name of bound) {
    if (!known.has(name)) {
      violations.push(
        `client keyset binds '${name}', which is neither in playerKeys nor in spectatorKeys`,
      );
    }
  }

  for (const name of playerKeys) {
    if (!bound.has(name)) {
      violations.push(
        `playerKeys declares '${name}', but no client keyset binds it — unreachable in the browser`,
      );
    }
  }

  for (const op of scenario.timeline) {
    if (op.op === 'key' && !known.has(op.name)) {
      violations.push(
        `scenario sends key '${op.name}' at tick ${op.tick ?? 0}, which the host does not know`,
      );
    }
  }

  return verdict('keyBindings', violations);
}

// 9. Расхождение считает само ядро (client::divergence): предсказанное
// состояние своего актора снимается перед реконсиляцией и сравнивается с
// player-блоком кадра. Сопоставление идёт по времени кадра, а не по seq —
// предиктор переигрывает историю ввода от момента авторитетного состояния,
// и «тот же seq» на клиенте и на хосте означает разные моменты.
function predictionDrift({ clients }) {
  const violations = [];
  const tracked = clients.filter(client => client.divergenceStats);

  if (!tracked.length) {
    return result(
      'predictionDrift',
      SKIP,
      [],
      'the client core reports no divergence data',
    );
  }

  const samples = tracked.reduce(
    (sum, client) => sum + (client.divergenceStats.samples ?? 0),
    0,
  );

  if (!samples) {
    return result(
      'predictionDrift',
      SKIP,
      [],
      'no authoritative player block reached a client in this run',
    );
  }

  for (const client of tracked) {
    for (const record of client.divergence) {
      violations.push(`${client.socketId}: ${formatDivergence(record)}`);
    }

    const hidden =
      (client.truncated.divergence ?? 0) +
      (client.divergenceStats.dropped ?? 0);

    if (hidden) {
      violations.push(`${client.socketId}: +${hidden} more divergence record(s)`);
    }
  }

  return result(
    'predictionDrift',
    violations.length ? FAIL : PASS,
    violations,
    `${samples} reconciliation(s) compared by frame time, not by seq`,
  );
}

// Компоненты player-блока — игровая раскладка, движок знает только их
// порядок, поэтому нарушение адресуется индексом.
function formatDivergence(record) {
  const parts = (record.exceeded ?? []).map(
    index =>
      `#${index} Δ${record.delta[index]} > ${record.thresholds[index]} ` +
      `(predicted ${record.predicted[index]}, authoritative ${record.authoritative[index]})`,
  );
  const replayed = record.replayed
    ? `, replayed ${record.replayed.count} input(s) in ` +
      `[${record.replayed.from}, ${record.replayed.to}]`
    : '';

  return (
    `serverTime ${record.serverTime}, offset ${record.offset}, ` +
    `source '${record.source}': ${parts.join('; ')}${replayed}`
  );
}

// 10
function roundLifecycle({
  game,
  scenario,
  socketManager,
  participantLog,
  hostState,
  stepMs,
}) {
  const teams = Object.keys(game.teams ?? {});
  const roundEnds = socketManager.framesOf('sendRoundEnd');
  const violations = [];

  // участники не утекли: реестр хоста == тем, кто зашёл и не вышел
  const stillIn = new Set(
    participantLog.filter(p => p.leaveTick === null).map(p => String(p.gameId)),
  );
  const registered = new Set(hostState.humans.map(String));

  for (const gameId of registered) {
    if (!stillIn.has(gameId)) {
      violations.push(
        `participant ${gameId} left the scenario but is still in the host registry — leak`,
      );
    }
  }

  for (const gameId of stillIn) {
    if (!registered.has(gameId)) {
      violations.push(
        `participant ${gameId} is in the scenario but vanished from the host registry`,
      );
    }
  }

  if (!roundEnds.length) {
    return result(
      'roundLifecycle',
      violations.length ? FAIL : SKIP,
      violations,
      'the scenario contains no round end',
    );
  }

  const restartTicks = Math.ceil((game.timers.roundRestartDelay ?? 0) / stepMs);
  const roundStarts = socketManager
    .framesOf('sendGameInform')
    .filter(frame => frame.args[0] === 'roundStart');

  for (const [tick, group] of groupByTick(roundEnds)) {
    for (const frame of group) {
      const winner = frame.args[0];

      if (winner !== undefined && winner !== null && !teams.includes(winner)) {
        violations.push(
          `round end at tick ${tick} announces unknown winner '${winner}'`,
        );
      }
    }

    const notified = new Set(group.map(frame => frame.socketId));
    const present = participantLog.filter(
      p => p.joinTick <= tick && (p.leaveTick === null || p.leaveTick > tick),
    );

    for (const participant of present) {
      if (!notified.has(participant.socketId)) {
        violations.push(
          `round end at tick ${tick} never reached '${participant.who}'`,
        );
      }
    }

    // респаун приезжает отложенно (roundRestartDelay) — требовать его можно
    // только если прогон дожил до этого момента
    if (tick + restartTicks <= scenario.ticks) {
      const restarted = roundStarts.some(frame => frame.tick > tick);

      if (!restarted) {
        violations.push(
          `no round start after the round end at tick ${tick} — respawns never happened`,
        );
      }
    }
  }

  return verdict('roundLifecycle', violations);
}

// 11
function actorLeak({ core, hostState }) {
  const violations = [];
  let actors;

  try {
    actors = actorIds(core.players_data());
  } catch (e) {
    return result('actorLeak', FAIL, [`players_data() failed: ${e.message}`]);
  }

  const active = new Set(hostState.activeList.map(String));

  for (const id of actors) {
    if (!active.has(id)) {
      violations.push(
        `actor ${id} lives in the core but is not an active participant — leak`,
      );
    }
  }

  for (const id of active) {
    if (!actors.has(id)) {
      violations.push(
        `participant ${id} is active but has no actor in the core — never spawned`,
      );
    }
  }

  return verdict('actorLeak', violations);
}

// ***** вспомогательное ***** //

function result(name, status, violations, note) {
  const { id, title } = TITLES.get(name);

  return { id, name, title, status, violations, ...(note ? { note } : {}) };
}

function verdict(name, violations) {
  return result(name, violations.length ? FAIL : PASS, violations);
}

function liveKeys(clients) {
  const keys = new Set();

  for (const client of clients) {
    for (const [key, stats] of Object.entries(client.observed)) {
      if (stats.rows) {
        keys.add(key);
      }
    }
  }

  return keys;
}

function groupByTick(frames) {
  const groups = new Map();

  for (const frame of frames) {
    const tick = frame.tick ?? 0;

    if (!groups.has(tick)) {
      groups.set(tick, []);
    }

    groups.get(tick).push(frame);
  }

  return groups;
}

// players_data() — данные первого кадра (FIRST_SHOT_DATA), их клиент
// применяет как снапшот: { ключ схемы: { id: [поля] } }. Приняты и плоские
// формы (массив id, массив объектов с id, объект по id) — движок нигде не
// требует именно снапшот-формы.
function actorIds(json) {
  const data = JSON.parse(json);
  const ids = new Set();

  if (Array.isArray(data)) {
    for (const item of data) {
      ids.add(String(item && typeof item === 'object' ? item.id : item));
    }

    return ids;
  }

  if (!data || typeof data !== 'object') {
    return ids;
  }

  for (const [key, value] of Object.entries(data)) {
    if (isSnapshotBlock(value)) {
      for (const id of Object.keys(value)) {
        ids.add(String(id));
      }
    } else {
      ids.add(String(key));
    }
  }

  return ids;
}

// блок снапшот-формы: словарь id → строка полей (массив) либо null-маркер.
// Отличает { "m1": { "3": [...] } } от плоского { "3": { x, y } }
function isSnapshotBlock(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(row => row === null || Array.isArray(row))
  );
}

function toBytes(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
