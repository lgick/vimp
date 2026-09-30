import { purgeOldClientReports } from '../../packages/auth/src/db/clientReportsPurgeJob.js';
import config from '../../packages/auth/src/config/auth.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// клиент-заглушка: advisory-lock отвечает `got`, остальные запросы —
// сценарием. release считается, чтобы поймать утечку соединения
function createClient(got, handlers = () => ({ rows: [], rowCount: 0 })) {
  const client = {
    released: 0,
    query: vi.fn((text, values) =>
      text.includes('pg_try_advisory_lock')
        ? { rows: [{ got }] }
        : handlers(text, values),
    ),
    release: () => {
      client.released += 1;
    },
  };

  return client;
}

function createDb(client) {
  return { connect: async () => client };
}

describe('clientReportsPurgeJob: прогон', () => {
  it('граница считается от retentionDays, блокировка снимается', async () => {
    const now = Date.parse('2026-09-27T00:15:00Z');
    const client = createClient(true, text =>
      text.startsWith('DELETE FROM client_reports')
        ? { rowCount: 3 }
        : { rows: [] },
    );

    await expect(
      purgeOldClientReports(createDb(client), { now }),
    ).resolves.toBe(3);

    const del = client.query.mock.calls.find(([text]) =>
      text.startsWith('DELETE FROM client_reports'),
    );

    expect(del[1][0].getTime()).toBe(
      now - config.clientReports.retentionDays * DAY_MS,
    );
    expect(
      client.query.mock.calls.some(([text]) =>
        text.includes('pg_advisory_unlock'),
      ),
    ).toBe(true);
    expect(client.released).toBe(1);
  });

  it('замок занят — прогона нет', async () => {
    const client = createClient(false);

    await expect(purgeOldClientReports(createDb(client))).resolves.toBe(0);
    expect(
      client.query.mock.calls.some(([text]) => text.startsWith('DELETE')),
    ).toBe(false);
    expect(client.released).toBe(1);
  });
});
