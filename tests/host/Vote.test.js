import { describe, it, expect, beforeEach, vi } from 'vitest';

// Vote — синглтон на уровне модуля, поэтому для изоляции
// перезагружаем модуль перед каждым тестом
let Vote;

beforeEach(async () => {
  vi.resetModules();
  Vote = (await import('../../packages/engine/src/host/meta/modules/Vote.js')).default;
});

describe('Vote: общий список', () => {
  it('push/shift в общий список через createVote', () => {
    const vote = new Vote();
    vote.createVote({ name: 'v1', category: 'map', payload: ['data'] });
    expect(vote.shift()).toEqual(['data']);
    expect(vote.shift()).toBeUndefined();
  });
});

describe('Vote: персональные списки', () => {
  it('pushByUser/shiftByUser работают по gameId', () => {
    const vote = new Vote();
    vote.addUser('u1');
    vote.createVote({
      name: 'v1',
      category: 'kick',
      payload: ['q'],
      userList: ['u1'],
    });
    expect(vote.shiftByUser('u1')).toEqual(['q']);
  });

  it('removeUser удаляет персональный список', () => {
    const vote = new Vote();
    vote.addUser('u1');
    vote.removeUser('u1');
    expect(vote._userList.u1).toBeUndefined();
  });
});

describe('Vote: очередь и категории', () => {
  it('второе голосование уходит в очередь при активном первом', () => {
    const vote = new Vote();
    vote.createVote({ name: 'v1', category: 'map', payload: [] });
    vote.createVote({ name: 'v2', category: 'kick', payload: [] });

    expect(vote._activeVoteName).toBe('v1');
    expect(vote._voteQueue).toHaveLength(1);
  });

  it('hasVoteCategory видит активную и очередную категории', () => {
    const vote = new Vote();
    vote.createVote({ name: 'v1', category: 'map', payload: [] });
    vote.createVote({ name: 'v2', category: 'kick', payload: [] });

    expect(vote.hasVoteCategory('map')).toBe(true); // активная
    expect(vote.hasVoteCategory('kick')).toBe(true); // в очереди
    expect(vote.hasVoteCategory('other')).toBe(false);
  });
});

describe('Vote: подсчёт результата', () => {
  it('возвращает явного победителя', () => {
    const vote = new Vote();
    vote.createVote({ name: 'v1', category: 'map', payload: [] });
    vote.addInVote('v1', 'mapA');
    vote.addInVote('v1', 'mapA');
    vote.addInVote('v1', 'mapB');

    expect(vote.getResult('v1')).toBe('mapA');
  });

  it('addInVote игнорируется для неактивного голосования', () => {
    const vote = new Vote();
    vote.createVote({ name: 'v1', category: 'map', payload: [] });
    vote.addInVote('wrong', 'x');
    expect(vote.getResult('v1')).toBeUndefined(); // никто не проголосовал
  });

  it('getResult для неактивного имени возвращает undefined', () => {
    const vote = new Vote();
    expect(vote.getResult('nope')).toBeUndefined();
  });

  it('ничья разрешается случайным выбором среди лидеров', () => {
    const vote = new Vote();
    vote.createVote({ name: 'v1', category: 'map', payload: [] });
    vote.addInVote('v1', 'A');
    vote.addInVote('v1', 'B');

    const result = vote.getResult('v1');
    expect(['A', 'B']).toContain(result);
  });

  it('после getResult запускается следующее из очереди', () => {
    const vote = new Vote();
    vote.createVote({ name: 'v1', category: 'map', payload: [] });
    vote.createVote({ name: 'v2', category: 'kick', payload: [] });

    vote.getResult('v1');
    expect(vote._activeVoteName).toBe('v2');
    expect(vote._voteQueue).toHaveLength(0);
  });

  it('reset очищает активное голосование и очередь', () => {
    const vote = new Vote();
    vote.addUser('u1');
    vote.createVote({ name: 'v1', category: 'map', payload: [], userList: ['u1'] });
    vote.reset();

    expect(vote._activeVoteName).toBeNull();
    expect(vote._voteQueue).toHaveLength(0);
    expect(vote._userList.u1).toEqual([]); // пользователь сохранён, список очищен
  });
});
