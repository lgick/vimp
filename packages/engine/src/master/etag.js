import crypto from 'crypto';

// ETag ответов мастера (snakes-v3 этап 3.3) — «не изменилось, не отправляем»
// на стороне чтения: топ рейтинга меняется медленно, а лобби перезапрашивает
// его на каждое открытие вкладки, и сотни клиентов сотен серверов возят одно
// и то же тело. Слабый валидатор (W/): сравнивается смысл ответа, а не
// побайтовая идентичность — тело собирается JSON.stringify'ем, порядок
// ключей в нём стабилен, но заголовки/сжатие мастер не контролирует.
export const etagFor = json =>
  `W/"${crypto.createHash('sha1').update(JSON.stringify(json)).digest('hex')}"`;

// If-None-Match может нести список валидаторов и префикс W/ (RFC 9110):
// сравниваем по «слабому» правилу — без префикса
const normalize = value => value.trim().replace(/^W\//, '');

export const isNotModified = (header, etag) => {
  if (!header || !etag) {
    return false;
  }

  return header
    .split(',')
    .some(candidate => normalize(candidate) === normalize(etag));
};
