import pg from 'pg';
import config from '../config/auth.js';

const { Pool } = pg;

let pool;

// ленивая инициализация — тестам не нужно реальное соединение,
// пока они не запрашивают pool явно
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.db.connectionString,
    });
  }

  return pool;
}

export default { getPool };
