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
      'unlink --no-save @vimp-games/tanks',
      'install',
      'unlink --no-save vimp-engine',
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

  // `npm unlink` без --no-save = `npm uninstall`: он выносит зависимость из
  // package.json и package-lock.json, а `npm link` обратно её не пишет. Так
  // релиз унёс из корня @vimp-games/tanks, и в коммит уехал lock без
  // плагина — а прод ставит его именно из lock (`npm ci`).
  it('снимает линк, не трогая манифест', () => {
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

    const unlinks = plan.unlink.filter(step => step.args[0] === 'unlink');

    expect(unlinks).toHaveLength(2);

    for (const step of unlinks) {
      expect(step.args).toContain('--no-save');
    }
  });
});
