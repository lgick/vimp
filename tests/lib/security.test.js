import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// security.origin читает config (синглтон) и process.env.NODE_ENV.
// Перезагружаем модули, чтобы config начинался пустым в каждом тесте.
let security;
let config;
const ORIGINAL_ENV = process.env.NODE_ENV;

beforeEach(async () => {
  vi.resetModules();
  config = (await import('../../packages/engine/src/lib/config.js')).default;
  config.set('server:domain', 'example.com');
  config.set('server:port', 3000);
  config.set('server:protocol', 'https:');
  security = (await import('../../packages/engine/src/lib/security.js')).default;
});

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV;
});

// оборачивает callback-стиль origin в промис с ошибкой (или null)
const checkOrigin = requestOrigin =>
  new Promise(resolve => security.origin(requestOrigin, err => resolve(err)));

describe('security.origin: разработка', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'development';
  });

  it('разрешает localhost на dev-порту', async () => {
    expect(await checkOrigin('https://localhost:3000')).toBeNull();
  });

  it('разрешает 127.0.0.1 на dev-порту', async () => {
    expect(await checkOrigin('https://127.0.0.1:3000')).toBeNull();
  });

  it('блокирует продакшен-домен в режиме разработки', async () => {
    const err = await checkOrigin('https://example.com');
    expect(err).toMatch(/invalid origin/);
  });

  it('блокирует сторонний origin', async () => {
    const err = await checkOrigin('https://evil.test');
    expect(err).toContain('evil.test');
  });

  it('блокирует localhost на чужом порту', async () => {
    expect(await checkOrigin('https://localhost:9999')).toMatch(
      /invalid origin/,
    );
  });
});

describe('security.origin: продакшен', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });

  it('разрешает настоящий домен по HTTPS', async () => {
    expect(await checkOrigin('https://example.com')).toBeNull();
  });

  it('по-прежнему блокирует сторонний origin', async () => {
    expect(await checkOrigin('https://phishing.example.org')).toMatch(
      /invalid origin/,
    );
  });
});

// createOriginValidator: параметризуемая версия проверки
// (используется мастер-сервером — не зависит от config server:*)
describe('security.createOriginValidator', () => {
  const validate = (validator, requestOrigin) =>
    new Promise(resolve => validator(requestOrigin, err => resolve(err)));

  const params = { protocol: 'https:', domain: 'master.test', port: 3001 };

  it('в разработке разрешает localhost на своём порту', async () => {
    process.env.NODE_ENV = 'development';
    const validator = security.createOriginValidator(params);

    expect(await validate(validator, 'https://localhost:3001')).toBeNull();
    expect(await validate(validator, 'https://127.0.0.1:3001')).toBeNull();
  });

  it('в разработке блокирует чужой порт и сторонний origin', async () => {
    process.env.NODE_ENV = 'development';
    const validator = security.createOriginValidator(params);

    expect(await validate(validator, 'https://localhost:3000')).toMatch(
      /invalid origin/,
    );
    expect(await validate(validator, 'https://evil.test')).toMatch(
      /invalid origin/,
    );
  });

  it('в продакшене разрешает свой домен по HTTPS', async () => {
    process.env.NODE_ENV = 'production';
    const validator = security.createOriginValidator(params);

    expect(await validate(validator, 'https://master.test')).toBeNull();
    expect(await validate(validator, 'https://phishing.test')).toMatch(
      /invalid origin/,
    );
  });
});
