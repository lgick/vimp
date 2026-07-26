import config from './config.js';

// создаёт проверку origin для заданных protocol/domain/port
// (используется и игровым сервером, и мастер-сервером)
const createOriginValidator = function ({ protocol, domain, port }) {
  return function (requestOrigin, cb) {
    const isProduction = process.env.NODE_ENV === 'production';

    const allowedOrigins = [
      // origin'ы для локальной разработки
      `${protocol}//localhost:${port}`,
      `${protocol}//127.0.0.1:${port}`,
    ];

    if (isProduction) {
      // в продакшене разрешен только настоящий домен по стандартному HTTPS
      // порт не требуется, так как браузер не добавляет его
      // для стандартного порта 443
      allowedOrigins.push(`https://${domain}`);
    }

    let err = null;

    if (!allowedOrigins.includes(requestOrigin)) {
      err = `Blocked connection from invalid origin: ${requestOrigin}`;
    }

    process.nextTick(() => cb(err));
  };
};

const origin = function (requestOrigin, cb) {
  const validator = createOriginValidator({
    protocol: config.get('server:protocol'),
    domain: config.get('server:domain'),
    port: config.get('server:port'),
  });

  validator(requestOrigin, cb);
};

export default {
  origin,
  createOriginValidator,
};
