import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../packages/engine/src/devtools/ScenarioRunner.js';
import { loadGameForSim } from '../../packages/engine/src/devtools/pluginLoader.js';
import { FAIL } from '../../packages/engine/src/devtools/invariants.js';
import {
  formControls,
  resolveDescriptor,
} from '../../packages/engine/src/lib/formControls.js';
import { validateAuth } from '../../packages/engine/src/lib/validators.js';
import { checkPluginCompatibility } from '../../packages/engine/src/lib/gamePlugin.js';

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
    let plugin;

    beforeAll(async () => {
      plugin = await loadGameForSim({ game: manifestOf(generation) });

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

    // Прогон матча идёт мимо PortMachine (ScenarioRunner зовёт host.createUser
    // напрямую), поэтому формы поколения он не задевает. Проверяем их
    // статически: имя контрола, переставшее резолвиться, и поле, переставшее
    // валидироваться на хосте, — оба слома совместимости, которых прогон не
    // увидит
    it('каждое имя control поколения резолвится реестром', () => {
      const descriptors = [
        ...(plugin.hostPlugin.gameConfig.roomForm ?? []),
        ...(plugin.hostPlugin.authSchema?.params ?? []).map(
          param => param.options ?? {},
        ),
      ];

      for (const { control } of descriptors) {
        if (control !== undefined) {
          expect([control, formControls.has(control)]).toEqual([control, true]);
        }
      }
    });

    it('поле поколения валидируется хостом так же, как его алиас', () => {
      // gen-api3 держит `control: 'range'` — имя, выведенное в v3. Хост
      // обязан проверять такое поле как его активную замену (numeric text):
      // до правки validators.js оно не совпадало ни с одним именем и
      // уезжало вообще без проверок, давая обошедшему форму клиенту больше
      // прав, чем заполнившему
      const retired = (plugin.hostPlugin.gameConfig.roomForm ?? []).filter(
        field => formControls.isRetired(field.control),
      );

      // у текущего поколения выведенных имён нет — проверять нечего;
      // что хотя бы одно поколение корпуса их держит, проверяется ниже
      for (const field of retired) {
        // резолв алиаса — то же, что делает билдер формы: 'range' →
        // numeric 'text', и накладка `numeric: true` едет вместе с ним
        const resolved = resolveDescriptor(field);
        const asRetired = validateAuth({ [field.name]: 'не-число' }, [
          { name: field.name, options: field },
        ]);
        const asResolved = validateAuth({ [field.name]: 'не-число' }, [
          { name: field.name, options: resolved },
        ]);

        expect([field.control, asRetired]).toEqual([field.control, asResolved]);
        expect(asRetired).not.toBeUndefined();
      }
    });

    it('манифест поколения совместим с этой сборкой движка', () => {
      expect(checkPluginCompatibility(plugin.manifest)).toEqual({ ok: true });
    });
  });
}

// Свойство самого корпуса, а не отдельного поколения: если ни одна фикстура
// не пишет выведенное имя контрола, алиасы этапа 3 не проверяются ничем и
// разъезд билдера с хостовой валидацией снова пройдёт молча
describe('корпус совместимости', () => {
  it('хотя бы одно поколение держит выведенный из эксплуатации control', async () => {
    const withRetired = [];

    for (const generation of GENERATIONS) {
      const plugin = await loadGameForSim({ game: manifestOf(generation) });
      const fields = plugin.hostPlugin.gameConfig.roomForm ?? [];

      if (fields.some(field => formControls.isRetired(field.control))) {
        withRetired.push(generation);
      }
    }

    expect(withRetired).not.toEqual([]);
  });
});
