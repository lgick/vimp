import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { checkContract } from '../../../packages/engine/src/devtools/contract/index.js';
import {
  FAIL,
  PASS,
  SKIP,
} from '../../../packages/engine/src/devtools/contract/result.js';

// Фикстура miniGame — эталон «минимально правильной» игры для правил
// групп B/C/D: она не пакет (нет package.json, vite, Cargo и dist/),
// поэтому A/E обязаны быть skip, а всё остальное — pass. Если правило
// красит фикстуру, чинится фикстура, а не правило: иначе валидатор учит
// игры контракту, которому не следует собственная эталонная реализация.

const FIXTURE = path.resolve(
  import.meta.dirname,
  '../../../packages/engine/tests/fixtures/miniGame',
);

let report;

beforeAll(async () => {
  report = await checkContract(FIXTURE);
});

describe('contract check on the miniGame fixture', () => {
  it('finds no violation at all', () => {
    const failed = report.results.filter(result => result.status === FAIL);

    expect(failed.map(result => `${result.id}: ${result.violations[0]}`)).toEqual(
      [],
    );
  });

  it('passes every host, client and snapshot rule', () => {
    const checked = report.results.filter(result =>
      /^[BCD]/.test(result.id),
    );

    // B5 (roomForm) — единственное исключение: у фикстуры нет лобби-формы
    expect(
      checked
        .filter(result => result.status !== PASS)
        .map(result => result.id),
    ).toEqual(['B5']);
  });

  it('skips the packaging and asset rules — the fixture is not a package', () => {
    const skipped = report.results
      .filter(result => result.status === SKIP)
      .map(result => result.id);

    expect(skipped).toEqual([
      'A1',
      'A2',
      'A3',
      'A4',
      'A5',
      'A6',
      'A7',
      'B5',
      'E1',
      'E2',
      'E3',
      // E4 — у фикстуры нет слоёных карт; правило обязано быть безвредным
      // для одноуровневой игры
      'E4',
    ]);
  });

  it('reports the game id and both plugin halves', () => {
    expect(report.game.id).toBe('miniGame');
    expect(report.game.built).toBe(false);
    expect(report.game.hostSource).toBe(path.join('host', 'index.js'));
    expect(report.game.clientSource).toBe(path.join('client', 'index.js'));
  });
});
