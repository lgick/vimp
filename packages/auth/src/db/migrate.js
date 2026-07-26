import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dbPool from './pool.js';

const migrationsDir = path.resolve(fileURLToPath(import.meta.url), '..', 'migrations');

// прогоняет migrations/*.sql по порядку имён — идемпотентно
// (CREATE TABLE IF NOT EXISTS), без таблицы версий: схема пока одна
async function migrate() {
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  const client = await dbPool.getPool().connect();

  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      console.info(`[migrate] applying ${file}`);
      await client.query(sql);
    }
  } finally {
    client.release();
  }
}

migrate()
  .then(() => {
    console.info('[migrate] done');
    process.exit(0);
  })
  .catch(err => {
    console.error('[migrate] failed', err);
    process.exit(1);
  });
