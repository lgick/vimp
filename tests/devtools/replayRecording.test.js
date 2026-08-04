import { describe, it, expect } from 'vitest';
import { runScenario } from '../../packages/engine/src/devtools/ScenarioRunner.js';
import {
  createFixtureHost,
  connectPlayer,
  joinTeam,
  pressKey,
  tick,
} from '../host/fixtureHarness.js';

// Смычка двух половин отладочного контура (этап 6 плана plan/ai-debug):
// матч, записанный в браузере рекордером хоста, обязан прогоняться headless
// без единой правки файла. Иначе браузерный баг остаётся в браузере.

describe('запись браузерной половины → headless-прогон', () => {
  it('записанный матч прогоняется runner\'ом и даёт живой контур', async () => {
    const { host } = await createFixtureHost({ opts: { seed: 3812 } });
    const gameId = await connectPlayer(host);

    host.startRecording();
    joinTeam(host, gameId, 'team1');
    tick(host, 10);
    pressKey(host, gameId, 'forward');
    tick(host, 50);
    pressKey(host, gameId, 'forward', 'up');
    tick(host, 10);

    const scenario = host.stopRecording();

    // событийный ключ фикстуры в этом сценарии не стреляет — объявляется
    // явно, иначе инвариант 2 честно посчитает это «сущность не спавнится»
    const report = await runScenario({ ...scenario, unusedSnapshotKeys: ['e1'] });

    expect(report.invariantSummary.failed).toBe(0);
    expect(report.participants).toHaveLength(1);

    const [client] = report.clients;

    expect(client.decodeErrors).toEqual([]);
    expect(client.frameCount).toBeGreaterThan(0);
    expect(Object.keys(client.entities)).toContain('a1');
  });
});
