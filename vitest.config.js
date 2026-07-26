import { defineConfig } from 'vitest/config';

// Конфигурация Vitest (этап 5 плана отделения движка; A3.5 — проекты
// tanks/integration переехали в репозиторий игры vimp-tanks).
// Тесты разделены на три проекта:
//   - engine-node:   мастер-сервер, хост (мета + Worker-фасад) и общие модули
//                    движка (packages/engine/src/{master,host,lib,config})
//   - engine-client: клиентский код движка (packages/engine/src/client)
//                    в окружении happy-dom (браузерный DOM)
//   - auth:          центральный auth-сервис (packages/auth/src) —
//                    JWT/JWKS, валидаторы, репозиторий, OAuth-провайдеры
export default defineConfig({
  test: {
    // глобальные describe/it/expect без импорта
    globals: true,

    projects: [
      {
        extends: true,
        test: {
          name: 'engine-node',
          environment: 'node',
          include: [
            'tests/master/**/*.test.js',
            'tests/lib/**/*.test.js',
            'tests/config/**/*.test.js',
            'tests/host/**/*.test.js',
            'packages/engine/tests/fixtures/**/*.test.js',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'engine-client',
          environment: 'happy-dom',
          include: ['tests/client/**/*.test.js'],
        },
      },
      {
        extends: true,
        test: {
          name: 'auth',
          environment: 'node',
          include: ['tests/auth/**/*.test.js'],
        },
      },
    ],

    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/engine/src/**/*.js', 'packages/auth/src/**/*.js'],
      exclude: [
        '**/_*/**', // игнорируемые директории (префикс _)
        '**/_*.js', // игнорируемые файлы (префикс _)
        '**/index.js', // ре-экспорты
      ],
    },
  },
});
