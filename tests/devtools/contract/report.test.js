import path from 'node:path';

import { describe, it, expect } from 'vitest';

import { ENGINE_API_VERSION } from '../../../packages/engine/src/config/opcodes.js';
import { rules } from '../../../packages/engine/src/devtools/contract/rules/index.js';
import {
  checkContract,
  hasBlockingFailure,
} from '../../../packages/engine/src/devtools/contract/index.js';
import { formatContract } from '../../../packages/engine/src/devtools/contract/format.js';
import {
  ERROR,
  FAIL,
  PASS,
  SKIP,
  WARN,
  summarize,
} from '../../../packages/engine/src/devtools/contract/result.js';
import { parseCrateVersion } from '../../../packages/engine/src/devtools/contract/loadContext.js';

// Обвязка отчёта: сами правила покрыты rules.test.js, а здесь — то, что
// решает судьбу прогона (код выхода) и то, что автор игры читает глазами.

const makeReport = (results, extra = {}) => ({
  game: {
    id: 'mini-game',
    dir: '/tmp/mini-game',
    hostSource: 'src/host/index.js',
    clientSource: 'src/client/index.js',
    built: true,
    engineApi: 3,
    ...extra.game,
  },
  results,
  summary: summarize(results),
  notes: extra.notes ?? [],
});

const result = (id, status, level = ERROR, violations = []) => ({
  id,
  name: `rule${id}`,
  title: `title ${id}`,
  level,
  status,
  violations,
  note: status === SKIP ? 'no input' : undefined,
});

describe('hasBlockingFailure', () => {
  it('ошибка валит прогон, предупреждение — нет', () => {
    const report = makeReport([
      result('A1', PASS),
      result('B1', FAIL, WARN, ['warn violation']),
    ]);

    expect(hasBlockingFailure(report)).toBe(false);
    expect(hasBlockingFailure(report, true)).toBe(true);
  });

  it('провал уровня error валит прогон и без --strict', () => {
    const report = makeReport([result('A1', FAIL, ERROR, ['broken'])]);

    expect(hasBlockingFailure(report)).toBe(true);
    expect(hasBlockingFailure(report, true)).toBe(true);
  });

  it('skip никогда не валит прогон', () => {
    const report = makeReport([result('A1', SKIP), result('B1', SKIP)]);

    expect(hasBlockingFailure(report, true)).toBe(false);
  });
});

describe('formatContract', () => {
  const report = makeReport(
    [
      result('A1', PASS),
      result('A5', FAIL, ERROR, ['pin is stale']),
      result('C6', FAIL, WARN, ['four columns']),
      result('E1', SKIP),
    ],
    { notes: ['host plugin has no default export'] },
  );

  it('печатает шапку, ноты и сводку', () => {
    const text = formatContract(report);

    expect(text).toContain('# Contract report — mini-game');
    expect(text).toContain('- engine API: v3');
    expect(text).toContain('> host plugin has no default export');
    expect(text).toContain('1 passed, 2 failed (1 error, 1 warning), 1 skipped');
  });

  it('печатает значок, уровень и нарушения каждого правила', () => {
    const text = formatContract(report);

    expect(text).toContain('✅ A1.');
    expect(text).toContain('❌ A5.');
    expect(text).toContain('  - pin is stale');
    expect(text).toContain('(warn)');
    expect(text).toContain('⏭️ E1.');
  });

  it('quiet оставляет только провалы и сводку', () => {
    const text = formatContract(report, { quiet: true });

    expect(text).toContain('❌ A5.');
    expect(text).toContain('❌ C6.');
    expect(text).not.toContain('✅ A1.');
    expect(text).not.toContain('⏭️ E1.');
    expect(text).toContain('1 passed, 2 failed');
  });

  it('несобранная игра без id читается и такой', () => {
    const text = formatContract(
      makeReport([], { game: { id: null, built: false } }),
    );

    expect(text).toContain('(unknown game)');
    expect(text).toContain('built: no (dist/ is missing)');
  });
});

describe('checkContract', () => {
  it('на фикстуре miniGame собирает поле game и прогоняет все правила', async () => {
    const dir = path.resolve(
      import.meta.dirname,
      '../../../packages/engine/tests/fixtures/miniGame',
    );
    const report = await checkContract(dir);

    expect(report.game.id).toBe('miniGame');
    expect(report.game.dir).toBe(dir);
    expect(report.game.engineApi).toBe(ENGINE_API_VERSION);
    // фикстура — исходники без сборки: dist/ у неё нет
    expect(report.game.built).toBe(false);
    expect(report.results.length).toBe(rules.length);
    expect(report.summary.passed + report.summary.failed + report.summary.skipped).toBe(
      rules.length,
    );
  });
});

describe('parseCrateVersion', () => {
  it('берёт версию из [package], а не из зависимостей', () => {
    const toml = [
      '[package]',
      'name = "vimp-engine-core"',
      'version = "0.3.2"',
      '',
      '[dependencies]',
      'serde = { version = "1.0.0" }',
    ].join('\n');

    expect(parseCrateVersion(toml)).toBe('0.3.2');
  });

  it('переживает отступ перед заголовком секции', () => {
    expect(parseCrateVersion('  [package]\n  version = "1.2.3"\n')).toBe(
      '1.2.3',
    );
  });

  it('без [package] и без version возвращает null', () => {
    expect(parseCrateVersion('[dependencies]\nserde = "1"\n')).toBe(null);
    expect(parseCrateVersion('[package]\nname = "x"\n')).toBe(null);
  });
});
