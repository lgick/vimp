import UserRepository, { NickTakenError, NickAlreadySetError } from '../../packages/auth/src/UserRepository.js';

function createDbStub(handlers) {
  return { query: vi.fn((text, values) => handlers(text, values)) };
}

describe('UserRepository', () => {
  it('findOrCreateByProvider возвращает существующего пользователя без INSERT', async () => {
    const db = createDbStub(text => {
      if (text.startsWith('SELECT')) {
        return { rows: [{ id: 1, provider: 'github', 'provider_uid': 'u1', nick: 'Player1' }] };
      }

      throw new Error('unexpected query: ' + text);
    });

    const repo = new UserRepository(db);
    const user = await repo.findOrCreateByProvider('github', 'u1');

    expect(user.nick).toBe('Player1');
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('findOrCreateByProvider создаёт нового пользователя без ника', async () => {
    const db = createDbStub(text => {
      if (text.startsWith('SELECT')) {
        return { rows: [] };
      }

      if (text.startsWith('INSERT')) {
        return { rows: [{ id: 2, provider: 'github', 'provider_uid': 'u2', nick: null }] };
      }

      throw new Error('unexpected query: ' + text);
    });

    const repo = new UserRepository(db);
    const user = await repo.findOrCreateByProvider('github', 'u2');

    expect(user.id).toBe(2);
    expect(user.nick).toBeNull();
  });

  it('setNick пробрасывает NickTakenError при unique_violation', async () => {
    const db = createDbStub(() => {
      const err = new Error('duplicate key');
      err.code = '23505';
      throw err;
    });

    const repo = new UserRepository(db);

    await expect(repo.setNick(1, 'Taken')).rejects.toThrow(NickTakenError);
  });

  it('setNick бросает NickAlreadySetError, если ник уже задан (F6 — запрет переименования)', async () => {
    const db = createDbStub(text => {
      expect(text).toMatch(/nick IS NULL/);
      return { rows: [] }; // WHERE nick IS NULL не нашёл строк — ник уже задан
    });

    const repo = new UserRepository(db);

    await expect(repo.setNick(1, 'NewNick')).rejects.toThrow(NickAlreadySetError);
  });

  it('setNick возвращает обновлённого пользователя при успехе', async () => {
    const db = createDbStub(() => ({
      rows: [{ id: 1, nick: 'FreshNick' }],
    }));

    const repo = new UserRepository(db);
    const user = await repo.setNick(1, 'FreshNick');

    expect(user.nick).toBe('FreshNick');
  });

  it('getRank возвращает 0 если записи нет', async () => {
    const db = createDbStub(() => ({ rows: [] }));
    const repo = new UserRepository(db);

    expect(await repo.getRank(1, 'tanks')).toBe(0);
  });

  it('getRank скопирован по game_id — namespace-изоляция между играми', async () => {
    const db = createDbStub((text, values) => {
      expect(values).toEqual([1, 'tanks']);
      return { rows: [{ rank: 7 }] };
    });
    const repo = new UserRepository(db);

    expect(await repo.getRank(1, 'tanks')).toBe(7);
  });

  it('getRank возвращает сохранённый rank', async () => {
    const db = createDbStub(() => ({ rows: [{ rank: 42 }] }));
    const repo = new UserRepository(db);

    expect(await repo.getRank(1, 'tanks')).toBe(42);
  });

  it('getState возвращает {} если записи нет', async () => {
    const db = createDbStub(() => ({ rows: [] }));
    const repo = new UserRepository(db);

    expect(await repo.getState(1, 'tanks')).toEqual({});
  });

  it('upsertState без sessionId сразу пишет INSERT ... ON CONFLICT, снапшот не делается', async () => {
    const db = createDbStub(text => {
      expect(text).toMatch(/ON CONFLICT/);
      return { rows: [] };
    });

    const repo = new UserRepository(db);

    await repo.upsertState(1, 'tanks', { skill: 5 });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('appendRankEvent пишет событие леджера с атрибуцией к серверу/сессии', async () => {
    const db = createDbStub(text => {
      expect(text).toMatch(/INSERT INTO rank_events/);
      return { rows: [] };
    });

    const repo = new UserRepository(db);

    await repo.appendRankEvent(1, 'tanks', 5, { hosterUserId: 2, sessionId: 's1' });

    expect(db.query).toHaveBeenCalledWith(
      expect.any(String),
      [1, 'tanks', 2, 's1', 5],
    );
  });

  it('recomputeRank суммирует непогашенные дельты и клампит в config.rank', async () => {
    const db = createDbStub(text => {
      if (text.includes('SUM(delta)')) {
        return { rows: [{ total: '15' }] };
      }

      expect(text).toMatch(/ON CONFLICT/);
      return { rows: [] };
    });

    const repo = new UserRepository(db);
    const rank = await repo.recomputeRank(1, 'tanks');

    expect(rank).toBe(15);
  });

  it('recomputeRank клампит результат снизу в config.rank.min', async () => {
    const db = createDbStub(text => {
      if (text.includes('SUM(delta)')) {
        return { rows: [{ total: '-100' }] };
      }

      return { rows: [] };
    });

    const repo = new UserRepository(db);
    const rank = await repo.recomputeRank(1, 'tanks');

    expect(rank).toBe(0);
  });

  it('upsertRank пишет событие и возвращает пересчитанный rank', async () => {
    const calls = [];
    const db = createDbStub(text => {
      calls.push(text);

      if (text.includes('SUM(delta)')) {
        return { rows: [{ total: '10' }] };
      }

      return { rows: [] };
    });

    const repo = new UserRepository(db);
    const rank = await repo.upsertRank(1, 'tanks', 10, { hosterUserId: 2, sessionId: 's1' });

    expect(rank).toBe(10);
    expect(calls[0]).toMatch(/INSERT INTO rank_events/);
  });

  it('upsertState с sessionId сначала снимает снапшот текущего state', async () => {
    const calls = [];
    const db = createDbStub(text => {
      calls.push(text);

      if (text.startsWith('SELECT state')) {
        return { rows: [{ state: { skill: 1 } }] };
      }

      return { rows: [] };
    });

    const repo = new UserRepository(db);

    await repo.upsertState(1, 'tanks', { skill: 2 }, { hosterUserId: 2, sessionId: 's1' });

    expect(calls[0]).toMatch(/SELECT state/);
    expect(calls[1]).toMatch(/INSERT INTO state_snapshots/);
    expect(calls[2]).toMatch(/INSERT INTO states/);
  });

  it('snapshotState идемпотентен на (user, game, session) — ON CONFLICT DO NOTHING', async () => {
    const db = createDbStub(text => {
      if (text.startsWith('SELECT state')) {
        return { rows: [{ state: { skill: 1 } }] };
      }

      expect(text).toMatch(/ON CONFLICT \(user_id, game_id, session_id\) DO NOTHING/);
      return { rows: [] };
    });

    const repo = new UserRepository(db);

    await repo.snapshotState(1, 'tanks', 's1', 2);
  });

  it('getHostRating возвращает { score: 0, blocked: false } если записи нет', async () => {
    const db = createDbStub(() => ({ rows: [] }));
    const repo = new UserRepository(db);

    expect(await repo.getHostRating(5)).toEqual({ score: 0, blocked: false });
  });

  it('getHostRating возвращает сохранённые score/blocked', async () => {
    const db = createDbStub(() => ({ rows: [{ score: -3, blocked: false }] }));
    const repo = new UserRepository(db);

    expect(await repo.getHostRating(5)).toEqual({ score: -3, blocked: false });
  });

  it('voteHost: первый голос пишет строку и пересчитывает score', async () => {
    const calls = [];
    const db = createDbStub(text => {
      calls.push(text);

      if (text.startsWith('SELECT value FROM host_votes')) {
        return { rows: [] }; // голоса ещё не было
      }

      if (text.includes('SUM(value)')) {
        return { rows: [{ total: '1' }] };
      }

      return { rows: [] };
    });

    const repo = new UserRepository(db);
    const result = await repo.voteHost(5, 9, 1, 'good game');

    expect(result).toEqual({ score: 1, blocked: false, counted: true });
    expect(calls[1]).toMatch(/INSERT INTO host_votes/);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO host_votes/),
      [5, 9, 1, 'good game'],
    );
  });

  it('voteHost: повторный тот же голос — no-op (counted: false)', async () => {
    const db = createDbStub(text => {
      if (text.startsWith('SELECT value FROM host_votes')) {
        return { rows: [{ value: 1 }] };
      }

      if (text.startsWith('SELECT score, blocked')) {
        return { rows: [{ score: 1, blocked: false }] };
      }

      throw new Error('unexpected query: ' + text);
    });

    const repo = new UserRepository(db);
    const result = await repo.voteHost(5, 9, 1, 'good game again');

    expect(result).toEqual({ score: 1, blocked: false, counted: false });
  });

  it('voteHost: смена мнения (like→unlike) переставляет голос, Δ=-2', async () => {
    const db = createDbStub(text => {
      if (text.startsWith('SELECT value FROM host_votes')) {
        return { rows: [{ value: 1 }] }; // раньше лайкнул
      }

      if (text.includes('SUM(value)')) {
        return { rows: [{ total: '-1' }] }; // теперь один голос -1
      }

      return { rows: [] };
    });

    const repo = new UserRepository(db);
    const result = await repo.voteHost(5, 9, -1, 'changed my mind');

    expect(result).toEqual({ score: -1, blocked: false, counted: true });
  });

  it('voteHost клампит score в config.rating и выставляет blocked при достижении blockAt', async () => {
    const db = createDbStub(text => {
      if (text.startsWith('SELECT value FROM host_votes')) {
        return { rows: [] };
      }

      if (text.includes('SUM(value)')) {
        return { rows: [{ total: '-25' }] }; // много unlike — за пределами min
      }

      return { rows: [] };
    });

    const repo = new UserRepository(db);
    const result = await repo.voteHost(5, 9, -1, 'cheat');

    expect(result.score).toBe(-10); // clamp к config.rating.min
    expect(result.blocked).toBe(true); // <= config.rating.blockAt
  });

  it('voteHost на первом переходе в blocked аннулирует вклад хостера (этап 4)', async () => {
    const calls = [];
    const db = createDbStub(text => {
      calls.push(text);

      if (text.startsWith('SELECT value FROM host_votes')) {
        return { rows: [] };
      }

      // getHostRating "before": ещё не заблокирован
      if (text.startsWith('SELECT score, blocked')) {
        return { rows: [{ score: -8, blocked: false }] };
      }

      if (text.includes('SUM(value)')) {
        return { rows: [{ total: '-10' }] };
      }

      if (text === 'SELECT DISTINCT user_id, game_id FROM rank_events WHERE hoster_user_id = $1') {
        return { rows: [{ 'user_id': 1, 'game_id': 'tanks' }] };
      }

      if (text.includes('SUM(delta)')) {
        return { rows: [{ total: '3' }] };
      }

      if (text.startsWith('SELECT DISTINCT user_id, game_id FROM state_snapshots')) {
        return { rows: [{ 'user_id': 1, 'game_id': 'tanks' }] };
      }

      if (text.startsWith('SELECT state_before')) {
        return { rows: [{ 'state_before': { skill: 1 } }] };
      }

      return { rows: [] };
    });

    const repo = new UserRepository(db);
    const result = await repo.voteHost(5, 9, -1, 'cheat again');

    expect(result.blocked).toBe(true);
    expect(calls).toContain(
      'UPDATE rank_events SET voided = true WHERE hoster_user_id = $1 AND voided = false',
    );
    expect(calls.some(text => text.startsWith('INSERT INTO states'))).toBe(true);
  });

  it('voteHost не повторяет аннулирование, если хостер уже был заблокирован', async () => {
    const db = createDbStub(text => {
      if (text.startsWith('SELECT value FROM host_votes')) {
        return { rows: [] };
      }

      // getHostRating "before": уже заблокирован
      if (text.startsWith('SELECT score, blocked')) {
        return { rows: [{ score: -10, blocked: true }] };
      }

      if (text.includes('SUM(value)')) {
        return { rows: [{ total: '-10' }] };
      }

      if (text.startsWith('SELECT DISTINCT')) {
        throw new Error('voidHosterContributions must not run again');
      }

      return { rows: [] };
    });

    const repo = new UserRepository(db);
    const result = await repo.voteHost(5, 9, -1, 'still cheating');

    expect(result.blocked).toBe(true);
  });

  // кодревью №6 (plan/server-rating/review.md): host_ratings.blocked должен
  // фиксироваться только ПОСЛЕ успешного void — иначе сбой на середине void
  // навсегда застревал бы в частично-погашенном состоянии (before.blocked
  // уже true при следующем голосе, повтор void не запускается)
  it('voteHost: если void упал на первом переходе в blocked, host_ratings не обновляется — следующий голос повторит void', async () => {
    const calls = [];
    const db = createDbStub(text => {
      calls.push(text);

      if (text.startsWith('SELECT value FROM host_votes')) {
        return { rows: [] };
      }

      if (text.startsWith('SELECT score, blocked')) {
        return { rows: [{ score: -8, blocked: false }] };
      }

      if (text.includes('SUM(value)')) {
        return { rows: [{ total: '-10' }] };
      }

      if (text.startsWith('SELECT DISTINCT user_id, game_id FROM rank_events')) {
        throw new Error('auth db unavailable mid-void');
      }

      return { rows: [] };
    });

    const repo = new UserRepository(db);

    await expect(repo.voteHost(5, 9, -1, 'cheat')).rejects.toThrow('auth db unavailable mid-void');

    expect(calls.some(text => text.startsWith('INSERT INTO host_ratings'))).toBe(false);
  });

  it('voidHosterContributions гасит непогашенные rank_events, пересчитывает кэш и откатывает states к самому раннему снапшоту', async () => {
    const calls = [];
    const db = createDbStub(text => {
      calls.push(text);

      if (text.startsWith('SELECT DISTINCT user_id, game_id FROM rank_events')) {
        return { rows: [{ 'user_id': 1, 'game_id': 'tanks' }, { 'user_id': 2, 'game_id': 'tanks' }] };
      }

      if (text.startsWith('UPDATE rank_events')) {
        return { rows: [] };
      }

      if (text.includes('SUM(delta)')) {
        return { rows: [{ total: '0' }] };
      }

      if (text.startsWith('SELECT DISTINCT user_id, game_id FROM state_snapshots')) {
        return { rows: [{ 'user_id': 1, 'game_id': 'tanks' }] };
      }

      if (text.startsWith('SELECT state_before')) {
        return { rows: [{ 'state_before': { skill: 0 } }] };
      }

      return { rows: [] };
    });

    const repo = new UserRepository(db);

    await repo.voidHosterContributions(5);

    expect(calls).toContain(
      'UPDATE rank_events SET voided = true WHERE hoster_user_id = $1 AND voided = false',
    );
    expect(calls.filter(text => text.includes('SUM(delta)')).length).toBe(2); // пересчёт для обоих задетых (user, game)
    expect(calls.some(text => text.startsWith('INSERT INTO states'))).toBe(true);
  });

  it('voidHosterContributions игрока без событий на баненном сервере не трогает', async () => {
    const db = createDbStub(text => {
      if (text.startsWith('SELECT DISTINCT')) {
        return { rows: [] };
      }

      if (text.startsWith('UPDATE rank_events')) {
        return { rows: [] };
      }

      throw new Error('unexpected query: ' + text);
    });

    const repo = new UserRepository(db);

    await expect(repo.voidHosterContributions(5)).resolves.toBeUndefined();
  });

  // lobby-page-plan: топ-N рейтинга игры и позиция вызывающего
  it('getLeaderboard возвращает топ-N, total и place одним запросом (проверка SQL/параметров)', async () => {
    const db = createDbStub((text, values) => {
      expect(text).toMatch(/r\.rank > 0 AND u\.nick IS NOT NULL/);
      expect(text).toMatch(/ORDER BY r\.rank DESC, u\.nick ASC/);
      expect(text).toMatch(/COUNT\(\*\) OVER\(\)/);
      expect(text).toMatch(/RANK\(\) OVER \(ORDER BY r\.rank DESC\)/);
      expect(values).toEqual(['tanks', 10]);

      return {
        rows: [
          { nick: 'player3', rank: 1500, total: '2', place: '1' },
          { nick: 'user203', rank: 1420, total: '2', place: '2' },
        ],
      };
    });

    const repo = new UserRepository(db);
    const result = await repo.getLeaderboard('tanks', 10);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      leaderboard: [
        { nick: 'player3', rank: 1500, place: 1 },
        { nick: 'user203', rank: 1420, place: 2 },
      ],
      total: 2,
    });
  });

  // code review M3: игроки с равным rank делят место (competition ranking) —
  // то же, что RANK() OVER(ORDER BY rank DESC), совпадает с семантикой
  // placement в getPlacement
  it('getLeaderboard: равный rank даёт одинаковый place, следующий перескакивает', async () => {
    const db = createDbStub(() => ({
      rows: [
        { nick: 'a', rank: 100, total: '3', place: '1' },
        { nick: 'b', rank: 100, total: '3', place: '1' },
        { nick: 'c', rank: 50, total: '3', place: '3' },
      ],
    }));

    const repo = new UserRepository(db);
    const result = await repo.getLeaderboard('tanks', 10);

    expect(result.leaderboard.map(row => row.place)).toEqual([1, 1, 3]);
  });

  it('getLeaderboard: пустая игра → total 0, leaderboard []', async () => {
    const db = createDbStub(() => ({ rows: [] }));

    const repo = new UserRepository(db);
    const result = await repo.getLeaderboard('tanks', 10);

    expect(result).toEqual({ leaderboard: [], total: 0 });
  });

  it('getPlacement возвращает placement/total/rank по CTE (проверка SQL/параметров)', async () => {
    const db = createDbStub((text, values) => {
      expect(text).toMatch(/WITH me AS/);
      expect(values).toEqual([1, 'tanks']);
      return { rows: [{ total: '3400', rank: 240, placement: 20 }] };
    });

    const repo = new UserRepository(db);
    const result = await repo.getPlacement(1, 'tanks');

    expect(result).toEqual({ placement: 20, total: 3400, rank: 240 });
  });

  it('getPlacement: игрок не ранжирован (rank=0) → placement === null', async () => {
    const db = createDbStub(() => ({
      rows: [{ total: '3400', rank: 0, placement: null }],
    }));

    const repo = new UserRepository(db);
    const result = await repo.getPlacement(1, 'tanks');

    expect(result).toEqual({ placement: null, total: 3400, rank: 0 });
  });
});
