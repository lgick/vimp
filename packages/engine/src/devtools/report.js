import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Отчёт прогона на диск: report.json (машинный), report.md (то, что читает
// нейросеть) и по файлу на каждый снятый срез сцены. Текстовый вердикт —
// главный смысл всей затеи: молчаливый отказ должен становиться строкой.

/**
 * @param {Object} report - Результат runScenario (плюс invariants этапа 3).
 * @param {Object} [options]
 * @param {string} [options.outDir] - Корень для .debug/run-<ts>.
 * @param {string} [options.stamp] - Метка прогона (по умолчанию — ISO-время).
 * @returns {Promise<string>} Каталог прогона.
 */
export async function writeReport(report, { outDir = '.debug', stamp } = {}) {
  const runStamp = stamp ?? new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.resolve(outDir, `run-${runStamp}`);

  await mkdir(runDir, { recursive: true });

  // срезы сцены — отдельными файлами: они самые объёмные и читаются точечно
  const { scenes = [], ...rest } = report;

  await Promise.all(
    scenes.map(scene =>
      writeFile(
        path.join(runDir, `scene-${scene.tick}.json`),
        `${JSON.stringify(scene, null, 2)}\n`,
      ),
    ),
  );

  await writeFile(
    path.join(runDir, 'report.json'),
    `${JSON.stringify({ ...rest, sceneTicks: scenes.map(s => s.tick) }, null, 2)}\n`,
  );

  await writeFile(path.join(runDir, 'report.md'), formatMarkdown(report));

  return runDir;
}

/**
 * Человекочитаемая сводка прогона.
 * @param {Object} report
 * @returns {string}
 */
export function formatMarkdown(report) {
  const lines = [];

  lines.push(`# Simulation report — ${report.game.id}`);
  lines.push('');
  lines.push(`- game source: \`${report.game.source}\``);
  lines.push(`- seed: \`${report.seed}\``);
  lines.push(
    `- ticks: ${report.scenario.ticks} × ${report.stepMs} ms = ${report.durationMs} ms`,
  );
  lines.push(`- map: \`${report.currentMap}\``);
  lines.push(`- participants: ${report.participants.length}`);
  lines.push('');

  lines.push(...invariantSection(report));
  lines.push(...worldSection(report));
  lines.push(...driftSection(report));

  lines.push('## Outgoing frames');
  lines.push('');
  lines.push('| method | count |');
  lines.push('| --- | --- |');

  for (const [method, count] of Object.entries(report.frameCounts).sort()) {
    lines.push(`| ${method} | ${count} |`);
  }

  lines.push('');
  lines.push('## Clients');
  lines.push('');

  for (const client of report.clients) {
    const entities = Object.entries(client.entities)
      .map(([key, ids]) => `${key}×${Object.keys(ids).length}`)
      .join(', ');

    lines.push(
      `- \`${client.socketId}\` (gameId ${client.gameId}): ${client.frameCount} frames, ` +
        `entities: ${entities || '(none)'}, camera: ${JSON.stringify(client.camera)}`,
    );

    for (const error of client.decodeErrors) {
      lines.push(`  - ⚠️ ${error.message}`);
    }
  }

  if (report.mapChanges.length) {
    lines.push('');
    lines.push('## Map changes');
    lines.push('');

    for (const change of report.mapChanges) {
      lines.push(`- tick ${change.tick}: \`${change.map}\``);
    }
  }

  lines.push('');

  return `${lines.join('\n')}\n`;
}

// Сводка дампа мира ядра последнего среза (этап 4): счётчики отвечают на
// «есть ли в мире то, чего нет на холсте» без открывания scene-*.json.
function worldSection(report) {
  const scenes = report.scenes ?? [];
  const last = [...scenes].reverse().find(scene => scene.core);

  if (!last) {
    return [];
  }

  const { core } = last;
  const lines = ['## World (core dump)', ''];

  lines.push(`Tick ${last.tick} — \`scene-${last.tick}.json\``);
  lines.push('');
  lines.push(`- bodies: ${core.bodies?.length ?? 0}`);
  lines.push(`- colliders: ${core.colliders?.length ?? 0}`);
  lines.push(`- map: ${core.map ? `\`${core.map.setId}\`` : '(none)'}`);
  lines.push(
    `- nav nodes: ${core.nav ? core.nav.nodes : '(no nav graph)'}` +
      `, spatial entities: ${core.spatial?.entities ?? 0}`,
  );
  lines.push(
    `- rng state: \`${core.rng?.state}\`, accumulator: ${core.step?.accumulator}`,
  );
  lines.push('');

  return lines;
}

// Дрейф предикта (этап 5): максимум расхождения по компонентам player-блока
// за прогон и первые записи. Сопоставление — по времени кадра, а не по seq:
// предиктор переигрывает историю ввода от момента авторитетного состояния.
function driftSection(report) {
  const tracked = report.clients.filter(client => client.divergence);

  if (!tracked.length) {
    return [];
  }

  const lines = ['## Prediction drift', ''];

  for (const client of tracked) {
    const drift = client.divergence;

    lines.push(
      `- \`${client.socketId}\`: ${drift.samples} reconciliation(s), ` +
        `${drift.violations} over threshold, max |Δ| per component: ` +
        `[${(drift.maxDelta ?? []).join(', ')}]`,
    );

    for (const record of drift.records ?? []) {
      lines.push(
        `  - serverTime ${record.serverTime} (source \`${record.source}\`): ` +
          `Δ [${(record.delta ?? []).join(', ')}]`,
      );
    }
  }

  lines.push('');

  return lines;
}

// Ради этой секции всё и затевалось: нарушенный контракт — строка с именем
// проверки, а не тишина.
function invariantSection(report) {
  const results = report.invariants ?? [];

  if (!results.length) {
    return [];
  }

  const { passed, failed, skipped } = report.invariantSummary ?? {};
  const lines = ['## Invariants', ''];

  lines.push(`${passed} passed, ${failed} failed, ${skipped} skipped`);
  lines.push('');

  for (const check of results) {
    const mark = { pass: '✅', fail: '❌', skip: '⏭️' }[check.status];
    const note = check.note ? ` — ${check.note}` : '';

    lines.push(`- ${mark} ${check.id}. \`${check.name}\`: ${check.title}${note}`);

    for (const violation of check.violations) {
      lines.push(`  - ${violation}`);
    }
  }

  lines.push('');

  return lines;
}
