import { describe, it, expect } from 'vitest';

import { buildLinkPlan } from '../../../scripts/release/links.js';

const paths = { root: '/vimp', engineDir: '/vimp/packages/engine' };

describe('buildLinkPlan', () => {
  it('снимает и возвращает ровно те пары, что были связаны', () => {
    const plan = buildLinkPlan(
      [
        {
          name: '@vimp-games/tanks',
          dir: '/vimp-tanks',
          gameLinked: true,
          engineLinked: true,
        },
      ],
      paths,
    );

    expect(plan.unlink.map(step => step.args.join(' '))).toEqual([
      'unlink @vimp-games/tanks',
      'install',
      'unlink vimp-engine',
      'install',
    ]);

    // сначала регистрация обоих пакетов, потом сами связи
    expect(plan.relink.map(step => `${step.cwd}: ${step.args.join(' ')}`)).toEqual([
      '/vimp-tanks: link',
      '/vimp/packages/engine: link',
      '/vimp: link @vimp-games/tanks',
      '/vimp-tanks: link vimp-engine',
    ]);
  });

  it('ничего не делает, когда линков нет', () => {
    const plan = buildLinkPlan(
      [{ name: '@vimp-games/sf', dir: '/sf', gameLinked: false, engineLinked: false }],
      paths,
    );

    expect(plan.unlink).toEqual([]);
    expect(plan.relink).toEqual([]);
  });

  it('обрабатывает одностороннюю связь', () => {
    const plan = buildLinkPlan(
      [{ name: '@vimp-games/sf', dir: '/sf', gameLinked: false, engineLinked: true }],
      paths,
    );

    expect(plan.unlink.map(step => step.cwd)).toEqual(['/sf', '/sf']);
    expect(plan.relink.map(step => step.cwd)).toEqual(['/vimp/packages/engine', '/sf']);
  });
});
