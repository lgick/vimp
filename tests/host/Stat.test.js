import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stat — синглтон, перезагружаем модуль для изоляции
let Stat;

// конфиг статистики (упрощённый аналог config/game.js -> stat)
const statConfig = {
  name: { key: 0, bodyMethod: '=', headSync: true, headMethod: '#' },
  score: {
    key: 1,
    bodyMethod: '+',
    bodyValue: 0,
    headMethod: '+',
    headValue: 0,
  },
  deaths: {
    key: 2,
    bodyMethod: '+',
    bodyValue: 0,
    headMethod: '+',
    headValue: 0,
  },
};

const teams = { team1: 1, team2: 2 };

beforeEach(async () => {
  vi.resetModules();
  Stat = (await import('../../packages/engine/src/host/meta/modules/Stat.js')).default;
});

describe('Stat: добавление и обновление', () => {
  it('addUser создаёт строку body с дефолтными значениями', () => {
    const stat = new Stat(statConfig, teams);
    stat.addUser('g1', 1, { name: 'Alice' });

    const full = stat.getFull();
    const row = full[0].find(r => r[0] === 'g1');
    expect(row[0]).toBe('g1'); // gameId
    expect(row[1]).toBe(1); // teamId
    expect(row[2][0]).toBe('Alice'); // name
    expect(row[2][1]).toBe(0); // score default
    expect(row[2][2]).toBe(0); // deaths default
  });

  it('updateUser с методом + суммирует, с = заменяет', () => {
    const stat = new Stat(statConfig, teams);
    stat.addUser('g1', 1, { name: 'Alice' });

    stat.updateUser('g1', 1, { score: 5 });
    stat.updateUser('g1', 1, { score: 3 });
    stat.updateUser('g1', 1, { name: 'Bob' });

    const row = stat.getFull()[0].find(r => r[0] === 'g1');
    expect(row[2][1]).toBe(8); // 5 + 3
    expect(row[2][0]).toBe('Bob'); // замена
  });

  it('headSync # считает количество игроков в команде', () => {
    const stat = new Stat(statConfig, teams);
    stat.addUser('g1', 1, { name: 'A' });
    stat.addUser('g2', 1, { name: 'B' });

    const head = stat.getFull()[1].find(h => h[0] === 1);
    expect(head[1][0]).toBe(2); // 2 игрока в team1
  });

  // Д7: колонки объявляет схема игры — движковые записи (status/latency…)
  // в необъявленные колонки игнорируются, а не роняют Worker
  it('updateUser игнорирует не объявленные схемой колонки', () => {
    const stat = new Stat(statConfig, teams);
    stat.addUser('g1', 1, { name: 'A' });

    expect(() =>
      stat.updateUser('g1', 1, { latency: 42, score: 2 }),
    ).not.toThrow();

    const row = stat.getFull()[0].find(r => r[0] === 'g1');
    expect(row[2][1]).toBe(2); // объявленная колонка применилась
    expect(row[2]).toHaveLength(3); // лишних ячеек не появилось
  });

  it('updateHead игнорирует не объявленную схемой колонку', () => {
    const stat = new Stat(statConfig, teams);
    stat.addUser('g1', 1, { name: 'A' });
    stat.reset();

    expect(() => stat.updateHead(1, 'latency', 42)).not.toThrow();

    const head = stat.getFull()[1].find(h => h[0] === 1);
    expect(head[1]).toHaveLength(3); // name/score/deaths, без latency
  });

  it('updateHead с методом + накапливает в head', () => {
    const stat = new Stat(statConfig, teams);
    stat.addUser('g1', 1, { name: 'A' });
    // head-значения с headValue инициализируются в reset() (старт раунда)
    stat.reset();

    stat.updateHead(1, 'score', 10);
    stat.updateHead(1, 'score', 5);

    const head = stat.getFull()[1].find(h => h[0] === 1);
    expect(head[1][1]).toBe(15);
  });
});

describe('Stat: удаление и перемещение', () => {
  it('removeUser убирает строку и обновляет headSync', () => {
    const stat = new Stat(statConfig, teams);
    stat.addUser('g1', 1, { name: 'A' });
    stat.addUser('g2', 1, { name: 'B' });

    stat.removeUser('g1', 1);

    const full = stat.getFull();
    const rows = full[0].filter(r => r[1] === 1);
    expect(rows).toHaveLength(1);

    const head = full[1].find(h => h[0] === 1);
    expect(head[1][0]).toBe(1); // остался 1 игрок
  });

  it('moveUser переносит игрока в другую команду', () => {
    const stat = new Stat(statConfig, teams);
    stat.addUser('g1', 1, { name: 'A', score: 7 });
    stat.updateUser('g1', 1, { score: 7 });

    stat.moveUser('g1', 1, 2);

    const full = stat.getFull();
    expect(full[0].find(r => r[0] === 'g1')[1]).toBe(2); // teamId = 2
  });
});

describe('Stat: getLast / getFull', () => {
  it('getLast возвращает изменения и очищает их', () => {
    const stat = new Stat(statConfig, teams);
    stat.addUser('g1', 1, { name: 'A' });

    const first = stat.getLast();
    expect(first).not.toBe(0); // есть изменения

    const second = stat.getLast();
    expect(second).toBe(0); // изменений больше нет
  });

  it('getFull помечает данные флагом полноты', () => {
    const stat = new Stat(statConfig, teams);
    stat.addUser('g1', 1, { name: 'A' });

    const full = stat.getFull();
    expect(full[2]).toBe(true);
  });

  it('reset обнуляет body-значения', () => {
    const stat = new Stat(statConfig, teams);
    stat.addUser('g1', 1, { name: 'A' });
    stat.updateUser('g1', 1, { score: 9 });

    stat.reset();

    const row = stat.getFull()[0].find(r => r[0] === 'g1');
    expect(row[2][1]).toBe(0); // score сброшен
    expect(row[2][0]).toBe('A'); // имя сохранено (нет bodyValue)
  });
});

// Эстафета Worker'ов (Этап 5.2): счёт переезжает в новый Worker целиком,
// строки не переживших переноса участников вычищаются штатно
describe('Stat: serialize/restore', () => {
  // Stat — синглтон: «новый Worker» моделируется resetModules + переимпорт
  const freshStat = async () => {
    vi.resetModules();

    const FreshStat = (await import('../../packages/engine/src/host/meta/modules/Stat.js'))
      .default;

    return new FreshStat(statConfig, teams);
  };

  it('restore переносит счёт и составы в свежий экземпляр', async () => {
    const stat = new Stat(statConfig, teams);

    stat.addUser('g1', 1, { name: 'Alice' });
    stat.addUser('g2', 2, { name: 'Bob' });
    stat.updateUser('g1', 1, { score: 7 });

    const dump = structuredClone(stat.serialize());
    const restored = await freshStat();

    expect(restored).not.toBe(stat);
    restored.restore(dump);

    const row = restored.getFull()[0].find(r => r[0] === 'g1');

    expect(row[2][1]).toBe(7); // score пережил перенос
    expect(restored.getFull()[0]).toHaveLength(2);
  });

  it('restore с keepIds вычищает строки не переживших эстафету', async () => {
    const stat = new Stat(statConfig, teams);

    stat.addUser('g1', 1, { name: 'Alice' });
    stat.addUser('g2', 2, { name: 'Ghost' });

    const dump = structuredClone(stat.serialize());
    const restored = await freshStat();

    restored.restore(dump, new Set(['g1']));

    const rows = restored.getFull()[0].map(r => r[0]);

    expect(rows).toEqual(['g1']);

    // удаление ушло клиентам как обычное обновление
    const last = restored.getLast();

    expect(last[0].some(r => r[0] === 'g2' && r[2] === null)).toBe(true);
  });
});
