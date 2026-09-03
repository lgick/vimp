import resolveAuthor from '../../packages/auth/src/lib/gameAuthor.js';
import UserRepository, {
  GameForbiddenError,
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
});
