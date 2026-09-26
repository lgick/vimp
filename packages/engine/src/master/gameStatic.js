import express from 'express';

import { GAME_VERSION_PATTERN } from './gameRefs.js';

// Раздача dist/ игр по /games/<id>[/<version>]/… Живёт отдельным модулем,
// потому что lobby.js поднимает сервер и из тестов не импортируется.
//
// Инстансы express.static кэшируются по директории — создавать serve-static
// на каждый файл игры незачем; снятая с диска версия уносит и свой маунт
// (drop() зовёт GameSync.onPruned).
/**
 * Разбор пути игровой статики — общий для раздачи и расшифровки стеков
 * журнала клиентских ошибок (plan/client-reports, этап 4).
 * @param {string} pathname - '/<id>[/<version>]/<rest>', путь ПОСЛЕ префикса /games.
 * @returns {{id: string, version: string|undefined, rest: string}|null} rest —
 *   остаток внутри dist/ игры (без ведущего '/', не декодирован); null — битая
 *   процентная последовательность в id или версии.
 */
export function parseGamePath(pathname) {
  const segments = pathname.split('/');
  let id;
  let second;

  try {
    id = decodeURIComponent(segments[1] ?? '');
    second = decodeURIComponent(segments[2] ?? '');
  } catch {
    return null;
  }

  const versioned = GAME_VERSION_PATTERN.test(second);

  return {
    id,
    version: versioned ? second : undefined,
    rest: segments.slice(versioned ? 3 : 2).join('/'),
  };
}

export function createGameStatic({ catalog, staticImpl = express.static }) {
  const byDir = new Map();

  const staticFor = dir => {
    let middleware = byDir.get(dir);

    if (!middleware) {
      middleware = staticImpl(dir);
      byDir.set(dir, middleware);
    }

    return middleware;
  };

  const handler = (req, res, next) => {
    const original = req.url;
    const queryAt = original.indexOf('?');
    const pathname = queryAt === -1 ? original : original.slice(0, queryAt);
    const query = queryAt === -1 ? '' : original.slice(queryAt);
    const parsed = parseGamePath(pathname);

    if (!parsed) {
      // битая процентная последовательность (`/games/%ZZ/x.js`) — это 404
      // дальше по цепочке, а не 500 из дефолтного обработчика Express
      next();
      return;
    }

    const { id, version, rest } = parsed;
    const versioned = version !== undefined;
    const dir = catalog.getDistDir(id, version);

    if (!dir) {
      // /games/<id>/<version>/… адресует только хранилище пакетов: отдать
      // сюда html-фолбэк ViteExpress значит ответить 200 на отсутствующий
      // бандл, и вызывающий увидит не 404, а невнятную ошибку import()
      if (versioned) {
        res.status(404).json({ error: 'unknownGame' });
        return;
      }

      next();
      return;
    }

    // остаток пути внутри dist/ игры; req.url восстанавливается, если файла
    // там нет — дальше по цепочке (ViteExpress) должен прийти исходный URL
    req.url = `/${rest}${query}`;

    staticFor(dir)(req, res, err => {
      req.url = original;

      // serve-static пропускает дальше и всё, что не GET/HEAD: для такого
      // запроса «файла нет» неизвестно, и отвечать 404 было бы враньём
      const readOnly = req.method === 'GET' || req.method === 'HEAD';

      if (!err && versioned && readOnly) {
        res.status(404).json({ error: 'notFound' });
        return;
      }

      next(err);
    });
  };

  return { handler, drop: dir => byDir.delete(dir) };
}

export default createGameStatic;
