// Роуты журнала клиентских ошибок в админке лобби (plan/client-reports,
// этап 5). Как и gameRoutes.js, модуль отдаёт голые обработчики, а URL и
// middleware (adminAuth.required) расставляет lobby.js — lobby.js поднимает
// сервер и из теста не импортируется.
//
// Мастер здесь только транспорт: наружу уходят лишь известные поля (чужой
// параметр не доезжает до auth), а ответ auth отдаётся как есть — с его
// статусом и телом. Роль перепроверяет auth по БД.

const QUERY_FIELDS = ['status', 'gameId', 'limit', 'offset'];

// отказ auth-сервиса выглядит для лобби так же, как на роутах реестра игр
function unavailable(res, err) {
  console.error('[client-reports] admin proxy failed:', err.message);
  res.status(502).json({ error: 'authServiceUnavailable' });
}

/**
 * @param {Object} deps
 * @param {Object} deps.proxy - ClientReportsProxy.
 * @returns {{list: Function, setStatus: Function}} Обработчики express.
 */
export function createClientReportsRoutes({ proxy }) {
  return {
    // GET /admin/client-reports — страница журнала
    async list(req, res) {
      const filter = {};

      QUERY_FIELDS.forEach(key => {
        if (typeof req.query?.[key] === 'string') {
          filter[key] = req.query[key];
        }
      });

      try {
        const { status, json } = await proxy.list(req.authToken, filter);

        res.status(status).json(json);
      } catch (err) {
        unavailable(res, err);
      }
    },

    // PATCH /admin/client-reports/:id — статус и заметка админа
    async setStatus(req, res) {
      const { status, note } = req.body || {};

      try {
        const answer = await proxy.setStatus(req.authToken, req.params.id, { status, note });

        res.status(answer.status).json(answer.json);
      } catch (err) {
        unavailable(res, err);
      }
    },
  };
}
