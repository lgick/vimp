import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../packages/engine/src/devtools/ScenarioRunner.js';
import { loadGameForSim } from '../../packages/engine/src/devtools/pluginLoader.js';
import { FAIL } from '../../packages/engine/src/devtools/invariants.js';

// Корпус совместимости (этап 1 плана plugin-forward-compat). Слепок
// поверхности ловит статические нарушения — исчезнувшее имя, изменившуюся
// сигнатуру. Здесь ловится семантика: движок может сохранить все имена и
// всё равно перестать запускать игру прошлого поколения.
//
// Каждое поколение в tests/fixtures/generations/ ЗАМОРОЖЕНО: если для
// зелёного прогона хочется поправить фикстуру — это и есть тот самый слом,
// ради обнаружения которого корпус существует.

// gen-api3 — реконструкция плагина до бампа v4 (без accolades, с
// `control: 'range'` в форме). Зелёный прогон на нём — формальное
// доказательство цели плана: гейт ENGINE_API_VERSION снят (этап 5), и игра
// прошлого поколения играется как есть. Если он красный, недоделан один из
// этапов 2-4 — чинить там, а не подгонять фикстуру
const GENERATIONS = ['gen-api4', 'gen-api3'];

const manifestOf = name =>
  fileURLToPath(
    new URL(
      `../../packages/engine/tests/fixtures/generations/${name}/manifest.json`,
      import.meta.url,
    ),
  );

// join двух участников, несколько нажатий, ~300 тиков: контур замыкается
// целиком (хост → кадр → клиентское ядро → сцена) на каждом поколении
const scenario = () => ({
  version: 1,
  seed: 3812,
  config: { timers: { networkSendRate: 1 } },
  participants: [
    { id: 'p1', name: 'P1', model: 'm1' },
    { id: 'p2', name: 'P2', model: 'm1' },
  ],
  timeline: [
    { tick: 0, op: 'join', who: 'p1', team: 'team1' },
    { tick: 10, op: 'join', who: 'p2', team: 'team1' },
    { tick: 60, op: 'key', who: 'p1', action: 'down', name: 'forward' },
    { tick: 90, op: 'key', who: 'p2', action: 'down', name: 'back' },
    { tick: 150, op: 'key', who: 'p1', action: 'up', name: 'forward' },
    { tick: 180, op: 'key', who: 'p2', action: 'up', name: 'back' },
    { tick: 200, op: 'key', who: 'p1', action: 'down', name: 'fire' },
  ],
  ticks: 300,
  // событийный ключ схемы поколения в этом сценарии не стреляет
  unusedSnapshotKeys: ['e1'],
});

for (const generation of GENERATIONS) {
  describe(`поколение ${generation}`, () => {
    let report;

    beforeAll(async () => {
      const plugin = await loadGameForSim({ game: manifestOf(generation) });

      report = await runScenario(scenario(), { plugin });
    });

    it('headless-матч проходит: кадры доезжают до клиентских ядер', () => {
      const received = report.clients.map(client => client.frameCount);

      // sendShot — сумма по всем адресатам: второй участник заходит позже
      // и своих кадров получает меньше
      expect(received.every(count => count > 0)).toBe(true);
      expect(received.reduce((sum, count) => sum + count, 0)).toBe(
        report.frameCounts.sendShot,
      );
    });

    it('ни одного decodeError на клиентах', () => {
      for (const client of report.clients) {
        expect(client.decodeErrors).toEqual([]);
      }
    });

    it('ни одного нарушенного инварианта прогона', () => {
      const failed = report.invariants.filter(check => check.status === FAIL);

      expect(failed.map(check => [check.name, check.violations])).toEqual([]);
    });
  });
}
