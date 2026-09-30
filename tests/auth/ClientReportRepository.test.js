import ClientReportRepository, {
  ClientReportNotFoundError,
} from '../../packages/auth/src/ClientReportRepository.js';

function createDbStub(handlers) {
  return { query: vi.fn((text, values) => handlers(text, values)) };
}

const fp = ch => ch.repeat(64);

const item = (fingerprint, extra = {}) => ({
  fingerprint,
  source: 'client',
  kind: 'error',
  code: null,
  message: 'boom',
  stack: null,
  details: null,
  count: 1,
  firstSeen: new Date('2026-09-27T10:00:00Z'),
  lastSeen: new Date('2026-09-27T10:00:00Z'),
  engineVersion: '0.34.8',
  gameId: 'tanks',
  gameVersion: '1.0.0',
  box: 'localhost:3002',
  mode: 'lobby',
  role: 'client',
  page: '/',
  userAgent: null,
  ...extra,
});

// SELECT известных отпечатков отвечает списком known, INSERT — пустым
function ingestDb(known = []) {
  return createDbStub(text => {
    if (text.startsWith('SELECT fingerprint')) {
      return { rows: known.map(fingerprint => ({ fingerprint })) };
    }

    if (text.startsWith('INSERT')) {
      return { rows: [], rowCount: 1 };
    }

    throw new Error('unexpected query: ' + text);
  });
}

const inserted = db => {
  const call = db.query.mock.calls.find(([text]) => text.startsWith('INSERT'));

  return call ? JSON.parse(call[1][0]) : null;
};

describe('ClientReportRepository.ingest', () => {
  it('сливает дубликаты отпечатка: одна строка, сумма count, min/max дат', async () => {
    const db = ingestDb();
    const repo = new ClientReportRepository(db);

    const result = await repo.ingest([
      item(fp('a'), {
        count: 2,
        firstSeen: new Date('2026-09-27T10:00:00Z'),
        lastSeen: new Date('2026-09-27T10:05:00Z'),
      }),
      item(fp('a'), {
        count: 3,
        firstSeen: new Date('2026-09-27T09:00:00Z'),
        lastSeen: new Date('2026-09-27T10:01:00Z'),
      }),
    ]);

    expect(result).toEqual({ accepted: 1, throttled: 0 });

    const records = inserted(db);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      fingerprint: fp('a'),
      count: 5,
      'first_seen': '2026-09-27T09:00:00.000Z',
      'last_seen': '2026-09-27T10:05:00.000Z',
      'engine_version': '0.34.8',
      'game_id': 'tanks',
    });
  });

  it('известные проходят при allowNew: () => 0, новые отсекаются', async () => {
    const db = ingestDb([fp('a')]);
    const repo = new ClientReportRepository(db);

    const result = await repo.ingest(
      [item(fp('a')), item(fp('b')), item(fp('c'))],
      { allowNew: () => 0 },
    );

    expect(result).toEqual({ accepted: 1, throttled: 2 });
    expect(inserted(db).map(r => r.fingerprint)).toEqual([fp('a')]);
  });

  it('allowNew: n => 1 — проходит ровно первый новый, всё одним INSERT', async () => {
    const db = ingestDb();
    const repo = new ClientReportRepository(db);
    const allowNew = vi.fn(() => 1);

    const result = await repo.ingest(
      [item(fp('b')), item(fp('c')), item(fp('d'))],
      { allowNew },
    );

    expect(allowNew).toHaveBeenCalledWith(3);
    expect(result).toEqual({ accepted: 1, throttled: 2 });
    expect(inserted(db).map(r => r.fingerprint)).toEqual([fp('b')]);
    expect(
      db.query.mock.calls.filter(([text]) => text.startsWith('INSERT')),
    ).toHaveLength(1);
  });

  it('без прошедших INSERT не выполняется', async () => {
    const db = ingestDb();
    const repo = new ClientReportRepository(db);

    await expect(
      repo.ingest([item(fp('b'))], { allowNew: () => 0 }),
    ).resolves.toEqual({ accepted: 0, throttled: 1 });
    expect(inserted(db)).toBeNull();
  });

  it('повтор не трогает статус', async () => {
    const db = ingestDb([fp('a')]);

    await new ClientReportRepository(db).ingest([item(fp('a'))]);

    const [text] = db.query.mock.calls.find(([sql]) =>
      sql.startsWith('INSERT'),
    );

    expect(text).not.toMatch(/status/);
  });

  it('SELECT известных сравнивает с bpchar[] — иначе UNIQUE-индекс не работает', async () => {
    const db = ingestDb();

    await new ClientReportRepository(db).ingest([item(fp('a'))]);

    const [text] = db.query.mock.calls.find(([sql]) =>
      sql.startsWith('SELECT fingerprint'),
    );

    expect(text).toContain('ANY($1::bpchar[])');
  });

  it('details служебной строки бокса обновляются последним окном', async () => {
    const db = ingestDb();

    await new ClientReportRepository(db).ingest([item(fp('a'))]);

    const [text] = db.query.mock.calls.find(([sql]) =>
      sql.startsWith('INSERT'),
    );

    expect(text).toContain("WHEN EXCLUDED.source = 'box'");
  });

  it('role и page пишутся в INSERT, но не обновляются при повторе', async () => {
    const db = ingestDb();

    await new ClientReportRepository(db).ingest([
      item(fp('a'), { role: 'host', page: '/room/abc' }),
    ]);

    const [text] = db.query.mock.calls.find(([sql]) =>
      sql.startsWith('INSERT'),
    );

    expect(inserted(db)[0]).toMatchObject({ role: 'host', page: '/room/abc' });
    expect(text).toMatch(/role text, page text/);
    expect(text).not.toMatch(/role\s*=|page\s*=/);
  });
});

describe('ClientReportRepository: чтение и статус', () => {
  const row = {
    id: '7',
    fingerprint: fp('a'),
    source: 'client',
    kind: 'error',
    code: null,
    message: 'boom',
    stack: null,
    details: null,
    'engine_version': '0.34.8',
    'game_id': 'tanks',
    'game_version': '1.0.0',
    box: 'localhost:3002',
    mode: 'lobby',
    role: 'host',
    page: '/room/abc',
    'user_agent': null,
    count: '12',
    'first_seen': new Date('2026-09-27T09:00:00Z'),
    'last_seen': new Date('2026-09-27T10:00:00Z'),
    status: 'fixed',
    'status_note': 'fixed in 1.0.1',
    'status_by_nick': 'lgick',
    'status_at': new Date('2026-09-27T11:00:00Z'),
  };

  it('countRows', async () => {
    const db = createDbStub(() => ({ rows: [{ n: '42' }] }));

    await expect(new ClientReportRepository(db).countRows()).resolves.toBe(42);
  });

  it('list open: WHERE по статусу, total, camelCase-строки', async () => {
    const db = createDbStub(text =>
      text.includes('LIMIT') ? { rows: [row] } : { rows: [{ n: '1' }] },
    );

    const result = await new ClientReportRepository(db).list({
      limit: 10,
      offset: 20,
    });

    const [select, values] = db.query.mock.calls[0];

    expect(select).toMatch(/WHERE r\.status = \$1/);
    expect(values).toEqual(['open', 10, 20]);
    expect(db.query.mock.calls[1][1]).toEqual(['open']);
    expect(result.total).toBe(1);
    expect(result.reports[0]).toEqual({
      id: 7,
      fingerprint: fp('a'),
      source: 'client',
      kind: 'error',
      code: null,
      message: 'boom',
      stack: null,
      details: null,
      engineVersion: '0.34.8',
      gameId: 'tanks',
      gameVersion: '1.0.0',
      box: 'localhost:3002',
      mode: 'lobby',
      role: 'host',
      page: '/room/abc',
      userAgent: null,
      count: 12,
      firstSeen: '2026-09-27T09:00:00.000Z',
      lastSeen: '2026-09-27T10:00:00.000Z',
      status: 'fixed',
      statusNote: 'fixed in 1.0.1',
      statusByNick: 'lgick',
      statusAt: '2026-09-27T11:00:00.000Z',
    });
    expect(result.reports[0]).not.toHaveProperty('statusBy');
  });

  it('list all без WHERE, all + gameId — только игра', async () => {
    const db = createDbStub(text =>
      text.includes('LIMIT') ? { rows: [] } : { rows: [{ n: '0' }] },
    );
    const repo = new ClientReportRepository(db);

    await repo.list({ status: 'all' });
    expect(db.query.mock.calls[0][0]).not.toMatch(/WHERE/);
    expect(db.query.mock.calls[0][1]).toEqual([50, 0]);

    await repo.list({ status: 'all', gameId: 'tanks' });
    expect(db.query.mock.calls[2][0]).toMatch(/WHERE r\.game_id = \$1/);
    expect(db.query.mock.calls[3][1]).toEqual(['tanks']);
  });

  it('list open + gameId — оба условия', async () => {
    const db = createDbStub(text =>
      text.includes('LIMIT') ? { rows: [] } : { rows: [{ n: '0' }] },
    );

    await new ClientReportRepository(db).list({ gameId: 'tanks' });
    expect(db.query.mock.calls[0][0]).toMatch(
      /r\.status = \$1 AND r\.game_id = \$2/,
    );
    expect(db.query.mock.calls[0][1]).toEqual(['open', 'tanks', 50, 0]);
  });

  it('get: строка или null', async () => {
    const repo = new ClientReportRepository(
      createDbStub(() => ({ rows: [row] })),
    );

    expect(await repo.get(7)).toMatchObject({
      id: 7,
      role: 'host',
      page: '/room/abc',
    });
    await expect(
      new ClientReportRepository(createDbStub(() => ({ rows: [] }))).get(8),
    ).resolves.toBeNull();
  });

  it('setStatus: обновлённая строка', async () => {
    const db = createDbStub(() => ({ rows: [row], rowCount: 1 }));

    const report = await new ClientReportRepository(db).setStatus('7', {
      status: 'fixed',
      note: 'fixed in 1.0.1',
      userId: 3,
    });

    expect(db.query.mock.calls[0][1]).toEqual([
      '7',
      'fixed',
      'fixed in 1.0.1',
      3,
    ]);
    expect(report.statusByNick).toBe('lgick');
  });

  it('setStatus на пустом rowCount бросает ClientReportNotFoundError', async () => {
    const db = createDbStub(() => ({ rows: [], rowCount: 0 }));

    await expect(
      new ClientReportRepository(db).setStatus('99', {
        status: 'ignored',
        userId: 3,
      }),
    ).rejects.toBeInstanceOf(ClientReportNotFoundError);
  });

  it('purge возвращает rowCount', async () => {
    const db = createDbStub(() => ({ rowCount: 5 }));
    const before = new Date('2026-06-29T00:00:00Z');

    await expect(new ClientReportRepository(db).purge(before)).resolves.toBe(5);
    expect(db.query.mock.calls[0][1]).toEqual([before]);
  });
});
