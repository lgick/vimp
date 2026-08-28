import UserRepository, { NickTakenError, NickAlreadySetError } from '../../packages/auth/src/UserRepository.js';
import config from '../../packages/auth/src/config/auth.js';
import { refreshRatings, msUntilNextRun } from '../../packages/auth/src/db/ratingsJob.js';
import RankDistribution from '../../packages/auth/src/db/RankDistribution.js';

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

  it('recordGameResult пишет points и best одной строкой с атрибуцией', async () => {
    const db = createDbStub(text => {
      expect(text).toMatch(/INSERT INTO rank_events/);
      expect(text).toMatch(/delta, best/);
      return { rows: [] };
    });

    const repo = new UserRepository(db);

    await repo.recordGameResult(1, 'tanks', { points: 120, best: 90 }, {
      hosterUserId: 2,
      sessionId: 's1',
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.any(String),
      [1, 'tanks', 2, 's1', 120, 90],
    );
  });

  // агрегат срезов (миграция 008) пишется ТЕМ ЖЕ запросом, что и леджер:
  // иначе между ними осталось бы окно, в котором дневной топ не знает о
  // только что записанном результате
  it('recordGameResult пишет леджер и агрегат одним запросом', async () => {
    const calls = [];
    const db = createDbStub(text => {
      calls.push(text);
      return { rows: [] };
    });

    await new UserRepository(db).recordGameResult(1, 'tanks', { points: 120, best: 90 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/INSERT INTO rank_events/);
    expect(calls[0]).toMatch(/INSERT INTO rank_periods/);
    // сутки и месяц одной вставкой
    expect(calls[0]).toMatch(/VALUES \('d', 'day'\), \('m', 'month'\)/);
    // окно от created_at САМОЙ строки, а не от now() отдельного запроса:
    // на границе суток они разъезжаются
    expect(calls[0]).toMatch(/event\.created_at AT TIME ZONE 'utc'/);
    // максимум берётся максимумом, сумма складывается
    expect(calls[0]).toMatch(/best = GREATEST\(rank_periods\.best, EXCLUDED\.best\)/);
    expect(calls[0]).toMatch(/points = rank_periods\.points \+ EXCLUDED\.points/);
  });

  // snakes-v3: главный выигрыш по нагрузке — на записи ровно один запрос,
  // без SUM по всей истории игрока (all-time считает суточная задача)
  it('recordGameResult не пересчитывает ratings на горячем пути', async () => {
    const calls = [];
    const db = createDbStub(text => {
      calls.push(text);
      return { rows: [] };
    });

    await new UserRepository(db).recordGameResult(1, 'tanks', { points: 10, best: 10 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toMatch(/SUM\(delta\)/);
    expect(calls[0]).not.toMatch(/INSERT INTO ratings/);
  });

  it('recordGameResult не пишет ничего при нулевом результате', async () => {
    const db = createDbStub(() => ({ rows: [] }));

    await new UserRepository(db).recordGameResult(1, 'tanks', { points: 0, best: 0 });

    expect(db.query).not.toHaveBeenCalled();
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
    // агрегат срезов — производная того же леджера, и аннулирование обязано
    // дойти и до него: `best` это максимум, вычесть из него нельзя, поэтому
    // пересчёт, а не правка. Плюс уборка окон, от которых не осталось событий
    expect(calls.filter(text => text.includes('INSERT INTO rank_periods')).length).toBe(2);
    expect(calls.filter(text => text.startsWith('DELETE FROM rank_periods')).length).toBe(2);
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

  // rank-periods / snakes-v3: 'day' — лучшая одиночная игра за сутки UTC,
  // 'month' — сумма игр за месяц, 'all' — кэш ratings. Три среза = три разные
  // агрегации. Считаются они НЕ свёрткой леджера, а готовым агрегатом
  // rank_periods (миграция 008): свёртка полумиллиона строк в сутки на
  // каждый запрос не держит целевой масштаб
  it('getLeaderboard: period day берёт best из суточной строки агрегата', async () => {
    const db = createDbStub((text, values) => {
      expect(text).toMatch(/FROM rank_periods/);
      expect(text).toMatch(/p\.best AS rank/);
      expect(text).toMatch(/date_trunc\('day', now\(\) AT TIME ZONE 'utc'\)::date/);
      // леджер на этом пути не читается вовсе — в этом весь смысл агрегата
      expect(text).not.toMatch(/rank_events/);
      expect(text).not.toMatch(/FROM ratings/);
      expect(values).toEqual(['tanks', 10, 'd']);

      return { rows: [{ nick: 'a', rank: 40, total: '1', place: '1' }] };
    });

    const repo = new UserRepository(db);

    await expect(repo.getLeaderboard('tanks', 10, 'day')).resolves.toEqual({
      leaderboard: [{ nick: 'a', rank: 40, place: 1 }],
      total: 1,
    });
  });

  it('getLeaderboard: period month берёт points из месячной строки агрегата', async () => {
    const db = createDbStub((text, values) => {
      expect(text).toMatch(/FROM rank_periods/);
      expect(text).toMatch(/p\.points AS rank/);
      expect(text).toMatch(/date_trunc\('month', now\(\) AT TIME ZONE 'utc'\)::date/);
      expect(text).not.toMatch(/rank_events/);
      expect(values).toEqual(['tanks', 10, 'm']);

      return { rows: [] };
    });

    await new UserRepository(db).getLeaderboard('tanks', 10, 'month');
  });

  // совместимость: до периодов вызов был двухаргументным, и он обязан
  // остаться срезом за всё время — теперь это суточный снимок ratings
  it('getLeaderboard: без period читает кэш ratings, как и раньше', async () => {
    const db = createDbStub(text => {
      expect(text).toMatch(/FROM ratings/);
      expect(text).not.toMatch(/rank_periods/);

      return { rows: [] };
    });

    await new UserRepository(db).getLeaderboard('tanks', 10);
  });

  // ***** МЕСТО ИГРОКА *****
  //
  // Место больше не считается запросом на каждого игрока: своё значение —
  // точечный поиск по первичному ключу, а место — бинарный поиск по лестнице
  // значений среза, общей для всех игроков игры (db/RankDistribution.js).
  // Замер на 8 000 игроков в окне: 6.03 мс → 0.14 мс.
  //
  // db-заглушка отвечает и на точечный поиск, и на загрузку лестницы, поэтому
  // маршрутизация по тексту запроса
  const placementStub = ({ own, ladder, total, calls = [] }) =>
    createDbStub((text, values) => {
      calls.push({ text, values });

      if (text.includes('at_or_above')) {
        return {
          rows: ladder.map(([score, atOrAbove]) => ({
            score,
            'at_or_above': String(atOrAbove),
            total: String(total),
          })),
        };
      }

      return { rows: own === null ? [] : [{ rank: own }] };
    });

  it('getPlacement: period day берёт своё значение точечным поиском', async () => {
    const calls = [];
    const db = placementStub({
      own: 40,
      ladder: [[100, 1], [40, 3], [10, 9]],
      total: 9,
      calls,
    });

    await expect(new UserRepository(db).getPlacement(1, 'tanks', 'day')).resolves.toEqual({
      // одна ступень строго выше 40 — на ней и выше стоит один игрок
      placement: 2,
      total: 9,
      rank: 40,
    });

    const own = calls[0];

    expect(own.text).toMatch(/FROM rank_periods p/);
    expect(own.text).toMatch(/p\.best AS rank/);
    // именно попадание в первичный ключ, а не свёртка окна
    expect(own.text).toMatch(/p\.user_id = \$1 AND p\.game_id = \$2/);
    expect(own.values).toEqual([1, 'tanks', 'd']);
  });

  it('getPlacement: period month читает месячную колонку и её лестницу', async () => {
    const calls = [];
    const db = placementStub({ own: 300, ladder: [[300, 2]], total: 5, calls });

    await expect(new UserRepository(db).getPlacement(1, 'tanks', 'month')).resolves.toEqual({
      placement: 1,
      total: 5,
      rank: 300,
    });

    expect(calls[0].values).toEqual([1, 'tanks', 'm']);
    expect(calls[1].text).toMatch(/p\.points AS score/);
  });

  // лестница общая на игру и срез: второй игрок за неё уже не платит — ровно
  // это и убирает 1200 тяжёлых запросов в секунду на целевом масштабе
  it('getPlacement: лестница грузится один раз на всех игроков', async () => {
    const calls = [];
    const db = placementStub({ own: 40, ladder: [[100, 1], [40, 3]], total: 3, calls });
    const repo = new UserRepository(db);

    await repo.getPlacement(1, 'tanks', 'day');
    await repo.getPlacement(2, 'tanks', 'day');
    await repo.getPlacement(3, 'tanks', 'day');

    expect(calls.filter(({ text }) => text.includes('at_or_above'))).toHaveLength(1);
    // а своё значение читается живым у каждого: устаревать может только
    // окружение, не собственный счёт
    expect(calls.filter(({ text }) => text.includes('AS rank'))).toHaveLength(3);
  });

  // наплыв входов в комнату на холодный ключ обязан дать ОДИН запрос, а не по
  // одному на участника: иначе первая секунда после протухания стоит столько,
  // сколько кэш и экономит
  it('getPlacement: одновременные вызовы делят одну загрузку лестницы', async () => {
    const calls = [];
    const db = placementStub({ own: 40, ladder: [[40, 1]], total: 1, calls });
    const repo = new UserRepository(db);

    await Promise.all([
      repo.getPlacement(1, 'tanks', 'day'),
      repo.getPlacement(2, 'tanks', 'day'),
      repo.getPlacement(3, 'tanks', 'day'),
    ]);

    expect(calls.filter(({ text }) => text.includes('at_or_above'))).toHaveLength(1);
  });

  // значение выше верхней ступени — первое место; ничьи делят место
  // (competition ranking, как `place` в getLeaderboard)
  it('getPlacement: разделившие значение делят место', async () => {
    const db = placementStub({ own: 90, ladder: [[100, 2], [90, 5], [10, 9]], total: 9 });

    await expect(new UserRepository(db).getPlacement(1, 'tanks', 'day')).resolves.toEqual({
      // двое стоят выше 90 — значит место третье, и его делят все с 90
      placement: 3,
      total: 9,
      rank: 90,
    });
  });

  it('getPlacement: неранжированный получает placement === null без лестницы', async () => {
    const db = placementStub({ own: null, ladder: [[10, 1]], total: 1 });

    await expect(new UserRepository(db).getPlacement(1, 'tanks', 'day')).resolves.toEqual({
      placement: null,
      total: 1,
      rank: 0,
    });
  });

  // игра, чья лестница не уместилась в потолок ступеней: глубокий хвост
  // уходит на точный запрос, и он обязан быть точным
  it('getPlacement: обрезанная лестница уводит хвост на точный запрос', async () => {
    const calls = [];
    const db = createDbStub((text, values) => {
      calls.push({ text, values });

      if (text.includes('at_or_above')) {
        // ступеней больше, чем потолок (2) — признак обрезанного хвоста
        return {
          rows: [
            { score: 100, 'at_or_above': '1', total: '900' },
            { score: 90, 'at_or_above': '2', total: '900' },
            { score: 80, 'at_or_above': '3', total: '900' },
          ],
        };
      }

      if (text.includes('FILTER')) {
        return { rows: [{ total: '900', above: '430' }] };
      }

      return { rows: [{ rank: 5 }] };
    });
    const repo = new UserRepository(db, {
      distribution: new RankDistribution(
        (game, period, maxSteps) => repo._loadDistribution(game, period, maxSteps),
        { ttlMs: 30000, maxSteps: 2 },
      ),
    });

    await expect(repo.getPlacement(1, 'tanks', 'day')).resolves.toEqual({
      placement: 431,
      total: 900,
      rank: 5,
    });

    const exact = calls.find(({ text }) => text.includes('FILTER'));

    // один проход по индексу: оба счётчика одним сканом, своё значение уже
    // известно и повторно не ищется
    expect(exact.text).toMatch(/COUNT\(\*\) FILTER \(WHERE p\.best > \$2\)/);
    expect(exact.values).toEqual(['tanks', 5]);
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

// snakes-v3 (stage_2.md, 2.4): all-time — суточный снимок, а не пересчёт на
// каждой записи
describe('ratingsJob', () => {
  // пул с одним соединением: блокировка сессионная, поэтому прогон берёт
  // клиента и держит его до конца. `got` — что ответил pg_try_advisory_lock
  function createPoolStub(handlers, { got = true } = {}) {
    const client = {
      query: vi.fn((text, values) => {
        if (text.includes('pg_try_advisory_lock')) {
          return { rows: [{ got }] };
        }

        if (text.includes('pg_advisory_unlock')) {
          return { rows: [{ 'pg_advisory_unlock': true }] };
        }

        return handlers(text, values);
      }),
      release: vi.fn(),
    };

    return { pool: { connect: async () => client }, client };
  }

  it('refreshRatings суммирует только события после ratings.updated_at', async () => {
    const { pool } = createPoolStub(text => {
      expect(text).toMatch(/INSERT INTO ratings/);
      expect(text).toMatch(/SUM\(e\.delta\)/);
      expect(text).toMatch(/e\.created_at > COALESCE\(r\.updated_at, '-infinity'::timestamptz\)/);
      expect(text).toMatch(/e\.voided = false/);

      return { rowCount: 3, rows: [] };
    });

    await expect(refreshRatings(pool)).resolves.toBe(3);
  });

  it('refreshRatings клампит результат в config.rank.min/max прямо в запросе', async () => {
    const { pool } = createPoolStub((text, values) => {
      expect(text).toMatch(/LEAST\(\$2, GREATEST\(\$1, COALESCE\(r\.rank, 0\) \+ SUM\(e\.delta\)\)\)/);
      expect(values).toEqual([config.rank.min, config.rank.max]);

      return { rowCount: 0, rows: [] };
    });

    await refreshRatings(pool);
  });

  it('refreshRatings переставляет курсор на максимальный учтённый created_at', async () => {
    const { pool } = createPoolStub(text => {
      // курсор — максимальный УЧТЁННЫЙ created_at, а не now(): now() терял
      // бы событие, закоммиченное позже снимка прогона, но с меткой раньше
      // его начала (см. комментарий в ratingsJob.js)
      expect(text).toMatch(/MAX\(e\.created_at\)/);
      expect(text).toMatch(
        /DO UPDATE SET rank = EXCLUDED\.rank, updated_at = EXCLUDED\.updated_at/,
      );

      return { rowCount: 1, rows: [] };
    });

    await refreshRatings(pool);
  });

  // запрос инкрементный (prev + SUM новых событий): второй параллельный
  // прогон не сделал бы лишнюю работу, а удвоил бы суточные очки всем
  it('refreshRatings не считает ничего, если замок занят другим прогоном', async () => {
    const { pool, client } = createPoolStub(
      text => {
        throw new Error('unexpected query: ' + text);
      },
      { got: false },
    );

    await expect(refreshRatings(pool)).resolves.toBe(0);

    const texts = client.query.mock.calls.map(([text]) => text);

    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/pg_try_advisory_lock/);
    expect(client.release).toHaveBeenCalled();
  });

  it('refreshRatings снимает замок и возвращает соединение даже на сбое', async () => {
    const { pool, client } = createPoolStub(() => {
      throw new Error('db is down');
    });

    await expect(refreshRatings(pool)).rejects.toThrow('db is down');

    const texts = client.query.mock.calls.map(([text]) => text);

    expect(texts.at(-1)).toMatch(/pg_advisory_unlock/);
    expect(client.release).toHaveBeenCalled();
  });

  it('msUntilNextRun указывает на ближайшие 00:05 UTC', () => {
    const beforeRun = Date.UTC(2026, 0, 10, 0, 0, 0);
    const afterRun = Date.UTC(2026, 0, 10, 12, 0, 0);

    expect(msUntilNextRun(beforeRun)).toBe(5 * 60 * 1000);
    expect(afterRun + msUntilNextRun(afterRun)).toBe(Date.UTC(2026, 0, 11, 0, 5, 0));
  });
});
