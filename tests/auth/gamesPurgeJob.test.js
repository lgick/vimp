import {
  msUntilNextRun,
  purgeDeletedGames,
} from '../../packages/auth/src/db/gamesPurgeJob.js';
import config from '../../packages/auth/src/config/auth.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// клиент-заглушка: advisory-lock отвечает `got`, остальные запросы —
// сценарием. release считается, чтобы поймать утечку соединения
function createClient(got, handlers = () => ({ rows: [] })) {
  const client = {
    released: 0,
    query: vi.fn((text, values) => (
      text.includes('pg_try_advisory_lock') ? { rows: [{ got }] } : handlers(text, values)
    )),
    release: () => {
      client.released += 1;
    },
  };

  return client;
}

function createDb(client) {
  return { connect: async () => client };
}

describe('gamesPurgeJob: планирование', () => {
  it('ближайший прогон — 00:15 UTC', () => {
    const now = Date.parse('2026-09-03T10:00:00Z');

    expect(msUntilNextRun(now)).toBe(Date.parse('2026-09-04T00:15:00Z') - now);
  });

  it('до 00:15 тех же суток прогон сегодняшний', () => {
    const now = Date.parse('2026-09-03T00:05:00Z');

    expect(msUntilNextRun(now)).toBe(10 * 60 * 1000);
  });
});

describe('gamesPurgeJob: прогон', () => {
  it('граница считается от ретенции, блокировка снимается', async () => {
    const now = Date.parse('2026-09-03T00:15:00Z');
    const client = createClient(true, text => (
      text.startsWith('SELECT id FROM games') ? { rows: [{ id: 'tanks' }] } : { rows: [] }
    ));

    await expect(purgeDeletedGames(createDb(client), { now })).resolves.toEqual(['tanks']);

    const select = client.query.mock.calls.find(([text]) => text.startsWith('SELECT id FROM games'));

    expect(select[1][0].getTime()).toBe(now - config.games.deleteRetentionDays * DAY_MS);
    expect(
      client.query.mock.calls.some(([text]) => text.includes('pg_advisory_unlock')),
    ).toBe(true);
    expect(client.released).toBe(1);
  });

  // прогон обязан быть один: реплик auth бывает больше одной, а ручной
  // `npm run db:games-purge` может совпасть с плановым
  it('замок занят — прогона нет', async () => {
    const client = createClient(false);

    await expect(purgeDeletedGames(createDb(client))).resolves.toEqual([]);
    expect(
      client.query.mock.calls.some(([text]) => text.startsWith('SELECT id FROM games')),
    ).toBe(false);
    expect(client.released).toBe(1);
  });
});
