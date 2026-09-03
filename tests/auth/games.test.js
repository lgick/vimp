import resolveAuthor from '../../packages/auth/src/lib/gameAuthor.js';
import UserRepository, {
  GameForbiddenError,
  GameNotFoundError,
  GamePublishedError,
} from '../../packages/auth/src/UserRepository.js';

function createDbStub(handlers) {
  return { query: vi.fn((text, values) => handlers(text, values)) };
}

// авторство (registry-dedicated-fixes, этап 6): заявитель становится автором
// сам, а играм платформы, засеянным миграцией без автора, его проставляет
// админ из панели модерации — телом PATCH /admin/games/:id
describe('назначение автора игры', () => {
  it('поле отсутствует — авторство не трогается', async () => {
    const findByNick = vi.fn();
    const result = await resolveAuthor(undefined, findByNick);

    expect(result).toEqual({ ok: true, authorUserId: undefined });
    expect(findByNick).not.toHaveBeenCalled();
  });

  it('ник резолвится в id, регистр не важен', async () => {
    // сравнение ников регистронезависимо в самой БД
    // (002_nick_case_insensitive.sql), и админ вводит ник руками
    const findByNick = vi.fn(nick => (
      nick.toLowerCase() === 'player1' ? { id: 42, nick: 'Player1' } : null
    ));

    await expect(resolveAuthor('PLAYER1', findByNick)).resolves.toEqual({
      ok: true,
      authorUserId: 42,
    });
    await expect(resolveAuthor('player1', findByNick)).resolves.toEqual({
      ok: true,
      authorUserId: 42,
    });
  });

  it('null и пустая строка снимают автора', async () => {
    const findByNick = vi.fn();

    await expect(resolveAuthor(null, findByNick)).resolves.toEqual({
      ok: true,
      authorUserId: null,
    });
    await expect(resolveAuthor('', findByNick)).resolves.toEqual({
      ok: true,
      authorUserId: null,
    });
    expect(findByNick).not.toHaveBeenCalled();
  });

  it('неизвестный ник — 404 unknownUser, невалидный — 400 badRequest', async () => {
    const findByNick = vi.fn(() => null);

    await expect(resolveAuthor('Ghost', findByNick)).resolves.toEqual({
      ok: false,
      status: 404,
      error: 'unknownUser',
    });

    // невалидный ник до БД не доходит вовсе
    await expect(resolveAuthor('!!', findByNick)).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'badRequest',
    });
    expect(findByNick).toHaveBeenCalledTimes(1);
  });

  it('findByNick ищет без учёта регистра и отдаёт null на пустой выборке', async () => {
    const found = createDbStub((text, values) => {
      expect(text).toMatch(/lower\(nick\) = lower\(\$1\)/);
      expect(values).toEqual(['Player1']);

      return { rows: [{ id: 42, nick: 'Player1' }] };
    });

    expect(await new UserRepository(found).findByNick('Player1')).toEqual({
      id: 42,
      nick: 'Player1',
    });

    const missing = createDbStub(() => ({ rows: [] }));

    expect(await new UserRepository(missing).findByNick('Ghost')).toBeNull();
  });

  it('moderateGame пишет author_user_id и через плейсхолдер, и значением null', async () => {
    const assigned = createDbStub((text, values) => {
      expect(text).toMatch(/author_user_id = \$3/);
      expect(values).toEqual(['tanks', 1, 42]);

      return { rows: [{ id: 'tanks', 'author_user_id': 42, 'author_nick': 'Player1' }] };
    });

    const game = await new UserRepository(assigned).moderateGame(
      'tanks',
      { authorUserId: 42 },
      1,
    );

    expect(game.authorUserId).toBe(42);
    expect(game.authorNick).toBe('Player1');

    const cleared = createDbStub((text, values) => {
      expect(values).toEqual(['tanks', 1, null]);

      return { rows: [{ id: 'tanks', 'author_user_id': null }] };
    });

    await new UserRepository(cleared).moderateGame('tanks', { authorUserId: null }, 1);
  });

  it('назначенный автор получает игру в «My games» и вправе запросить версию', async () => {
    const listed = createDbStub((text, values) => {
      expect(text).toMatch(/WHERE g\.author_user_id = \$1/);
      expect(values).toEqual([42]);

      return { rows: [{ id: 'tanks', 'author_user_id': 42, 'author_nick': 'Player1' }] };
    });

    const games = await new UserRepository(listed).listGamesByAuthor(42);

    expect(games).toHaveLength(1);
    expect(games[0].id).toBe('tanks');

    // тот же id пускает запрос новой версии без админских прав
    const update = createDbStub((text, values) => {
      expect(values).toEqual(['tanks', '0.17.0', false, 42]);

      return { rows: [{ id: 'tanks', 'pending_version': '0.17.0', 'author_user_id': 42 }] };
    });

    const updated = await new UserRepository(update).requestGameVersion('tanks', '0.17.0', {
      userId: 42,
    });

    expect(updated.pendingVersion).toBe('0.17.0');

    // а чужой — по-прежнему нет
    const foreign = createDbStub(text => (
      text.includes('UPDATE games')
        ? { rows: [] }
        : { rows: [{ id: 'tanks', 'author_user_id': 42 }] }
    ));

    await expect(
      new UserRepository(foreign).requestGameVersion('tanks', '0.17.0', { userId: 7 }),
    ).rejects.toThrow(GameForbiddenError);
  });

  // карточка «My games» могла устареть: игру удалил админ, пока список не
  // перечитывали. Запись в удалённую строку вернула бы потом Restore'ом не
  // ту игру, которую удаляли, — и ответ здесь именно 404, а не 403
  it('в удалённую игру версия не заявляется', async () => {
    const db = createDbStub(text => (
      text.includes('UPDATE games')
        ? { rows: [] }
        : { rows: [{ id: 'tanks', 'author_user_id': 42, 'deleted_at': new Date() }] }
    ));

    await expect(
      new UserRepository(db).requestGameVersion('tanks', '0.17.0', { userId: 42 }),
    ).rejects.toThrow(GameNotFoundError);
  });

  it('решение модератора в удалённую игру не пишется', async () => {
    const db = createDbStub(() => ({ rows: [] }));

    await expect(
      new UserRepository(db).moderateGame('tanks', { status: 'approved' }, 1),
    ).rejects.toThrow(GameNotFoundError);

    const [text] = db.query.mock.calls[0];

    expect(text).toMatch(/deleted_at IS NULL/);
  });
});

// мягкое удаление игры: строка и все данные по game_id остаются в БД, игра
// лишь снимается с раздачи и уходит в графу Deleted очереди модерации.
// Полное удаление — отдельная задача (purgeGames), она же и уносит данные:
// FK на games у этих таблиц нет, и осиротевшие строки «воскресли» бы при
// повторной заявке под тем же id
describe('удаление игры', () => {
  const DATA_TABLES = ['rank_periods', 'rank_events', 'state_snapshots', 'states', 'ratings'];

  // стаб, отвечающий одной строкой games на SELECT/UPDATE и пустотой на DELETE
  function createDeleteStub(row) {
    return createDbStub(text => (
      text.startsWith('DELETE') ? { rows: [] } : { rows: row ? [row] : [] }
    ));
  }

  function deletedTables(db) {
    return db.query.mock.calls
      .map(([text]) => text.match(/DELETE FROM (\w+)/)?.[1])
      .filter(Boolean);
  }

  // текст UPDATE-запроса удаления, если он был
  function softDelete(db) {
    return db.query.mock.calls.find(([text]) => /UPDATE games SET deleted_at = now\(\)/.test(text));
  }

  it('админ удаляет опубликованную игру: строка помечается, данные целы', async () => {
    const db = createDeleteStub({ id: 'tanks', 'author_user_id': 42, status: 'approved' });
    const game = await new UserRepository(db).deleteGame('tanks', { userId: 1, isAdmin: true });

    expect(game.id).toBe('tanks');
    expect(deletedTables(db)).toEqual([]);
    // id всегда параметром, в текст SQL не подставляется
    expect(softDelete(db)?.[1]).toEqual(['tanks']);
  });

  it('автор удаляет свою неопубликованную игру', async () => {
    const db = createDeleteStub({ id: 'tanks', 'author_user_id': 42, status: 'pending' });

    await new UserRepository(db).deleteGame('tanks', { userId: 42 });

    expect(softDelete(db)).toBeTruthy();
    expect(deletedTables(db)).toEqual([]);
  });

  // «повторное удаление» — это удаление ВОССТАНОВЛЕННОЙ игры: метка снята,
  // и запрос ставит её заново, то есть срок отсчитывается с нуля
  it('удаление восстановленной игры ставит метку заново', async () => {
    const db = createDeleteStub({ id: 'tanks', 'author_user_id': 42, status: 'pending',
      'deleted_at': null });

    await new UserRepository(db).deleteGame('tanks', { userId: 42 });

    const [text] = softDelete(db);

    // now() в самом запросе, а не значение из строки
    expect(text).toMatch(/deleted_at = now\(\)/);
  });

  // карточка панели могла устареть: игру удалил кто-то другой, пока список
  // не перечитывали. Второе удаление молча продлило бы срок на 30 суток
  it('уже удалённая игра для роута не существует', async () => {
    const db = createDeleteStub({ id: 'tanks', 'author_user_id': 42, status: 'pending',
      'deleted_at': new Date('2026-01-01T00:00:00Z') });

    await expect(
      new UserRepository(db).deleteGame('tanks', { userId: 42 }),
    ).rejects.toThrow(GameNotFoundError);

    expect(softDelete(db)).toBeUndefined();
  });

  it('строку унесли между чтением и записью — GameNotFoundError, не пустая игра', async () => {
    const db = createDbStub(text => (
      text.startsWith('SELECT') ? { rows: [{ id: 'tanks', 'author_user_id': 42,
        status: 'pending' }] } : { rows: [] }
    ));

    await expect(
      new UserRepository(db).deleteGame('tanks', { userId: 42, isAdmin: true }),
    ).rejects.toThrow(GameNotFoundError);
  });

  it('автор не удаляет раздаваемую игру', async () => {
    const db = createDeleteStub({ id: 'tanks', 'author_user_id': 42, status: 'approved' });

    await expect(
      new UserRepository(db).deleteGame('tanks', { userId: 42 }),
    ).rejects.toThrow(GamePublishedError);

    expect(softDelete(db)).toBeUndefined();
  });

  it('чужая игра не удаляется', async () => {
    const db = createDeleteStub({ id: 'tanks', 'author_user_id': 42, status: 'pending' });

    await expect(
      new UserRepository(db).deleteGame('tanks', { userId: 7 }),
    ).rejects.toThrow(GameForbiddenError);

    expect(softDelete(db)).toBeUndefined();
  });

  it('игры нет — GameNotFoundError', async () => {
    const db = createDeleteStub(null);

    await expect(
      new UserRepository(db).deleteGame('nope', { userId: 1, isAdmin: true }),
    ).rejects.toThrow(GameNotFoundError);

    expect(softDelete(db)).toBeUndefined();
  });

  it('восстановление снимает метку', async () => {
    const db = createDeleteStub({ id: 'tanks', 'author_user_id': 42, status: 'approved' });
    const game = await new UserRepository(db).restoreGame('tanks');

    expect(game.id).toBe('tanks');

    const [text, values] = db.query.mock.calls.at(-1);

    expect(text).toMatch(/UPDATE games SET deleted_at = NULL/);
    // условие deleted_at IS NOT NULL: восстанавливать живую игру нечем
    expect(text).toMatch(/deleted_at IS NOT NULL/);
    expect(values).toEqual(['tanks']);
  });

  it('игра не была удалена — восстановление не находит её', async () => {
    const db = createDbStub(() => ({ rows: [] }));

    await expect(new UserRepository(db).restoreGame('tanks')).rejects.toThrow(GameNotFoundError);
  });

  it('очистка уносит данные игры, строку games — последней', async () => {
    const db = createDbStub(text => (
      text.startsWith('SELECT id FROM games') ? { rows: [{ id: 'tanks' }] } : { rows: [] }
    ));
    const ids = await new UserRepository(db).purgeGames(new Date('2026-01-01T00:00:00Z'));

    expect(ids).toEqual(['tanks']);
    expect(deletedTables(db)).toEqual([...DATA_TABLES, 'games']);
    // id всегда параметром, в текст SQL не подставляется
    db.query.mock.calls
      .filter(([text]) => text.startsWith('DELETE'))
      .forEach(([, values]) => expect(values).toEqual(['tanks']));
  });

  it('просроченных игр нет — ни одного удаления', async () => {
    const db = createDbStub(() => ({ rows: [] }));

    await expect(
      new UserRepository(db).purgeGames(new Date('2026-01-01T00:00:00Z')),
    ).resolves.toEqual([]);
    expect(deletedTables(db)).toEqual([]);
  });
});
