/*
npx eslint . eslint.config.js
npx eslint --print-config src/host/meta/modules/Panel.js > log
*/

import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import noConsecutiveCapsPlugin from 'eslint-plugin-no-consecutive-caps';
import globals from 'globals';

export default [
  // базовые рекомендованные правила ESLint
  js.configs.recommended,

  // отключение правил ESLint, конфликтующих с Prettier
  eslintConfigPrettier,

  {
    plugins: {
      'no-consecutive-caps': noConsecutiveCapsPlugin,
    },
  },

  // конфигурация для конфигов корня и воркспейсов (vite.config.js и т.д.)
  {
    files: ['*.js', '*.cjs', '*.mjs', 'packages/*/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node, // глобальные переменные Node.js
      },
    },
    rules: {
      'no-console': 'off', // в файлах конфигурации console.log
    },
  },

  // конфигурация серверного кода Node.js
  {
    files: [
      'packages/engine/src/master/**/*.js', // мастер-сервер (Node.js)
      'packages/auth/src/**/*.js', // центральный auth-сервис (Node.js)
      // headless-отладка (npm run sim): Node-процесс, но крутит внутри себя
      // хост и клиентское ядро, поэтому нужны и браузерные изоморфные глобалы
      'packages/engine/src/devtools/**/*.js',
      'packages/engine/bin/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 'latest', // последний ECMAScript
      sourceType: 'module', // "type": "module" в package.json
      globals: {
        ...globals.node, // глобальные переменные Node.js (console, process...)
        ...globals.browser, // structuredClone, queueMicrotask, URL, TextDecoder
      },
    },
    rules: {
      'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
    },
  },

  // конфигурация для клиентского кода
  {
    files: [
      // клиент движка
      'packages/engine/src/client/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser, // глобальные переменные браузера
      },
    },
    rules: {
      'no-alert': 'warn', // предупреждать об alert, confirm, prompt
    },
  },
  // конфигурация для кода браузерного хоста (Web Worker: WASM-ядро + мета)
  {
    files: [
      'packages/engine/src/host/**/*.js', // Worker хоста и его модули
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser, // structuredClone, queueMicrotask, console...
        ...globals.worker, // self, postMessage, importScripts
      },
    },
    rules: {
      'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
    },
  },

  {
    files: [
      'packages/engine/src/lib/**/*.js',
      'packages/engine/src/config/**/*.js',
      'packages/engine/scripts/**/*.mjs',
      'scripts/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.es2023,
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // ESLint-граница движок↔игра (этапы 5/6.4 плана отделения, A3.5: игра
  // выехала в отдельный репозиторий vimp-tanks — правило по-прежнему
  // страхует от случайного статического импорта игрового пакета из
  // node_modules): движок не импортирует игру статически вовсе — игра
  // грузится динамически по GameManifest (import() с рантаймовым URL,
  // который ESLint не проверяет). Все игры-плагины публикуются в scope
  // @vimp-games/* (не путать с движковыми workspace-пакетами @vimp/*).
  {
    files: ['packages/engine/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@vimp-games/*', '@vimp-games/**'],
              message:
                'Движок не импортирует игру напрямую — только динамически по GameManifest.',
            },
          ],
        },
      ],
    },
  },

  // конфигурация для тестов (Vitest) + движковой тестовой фикстуры
  // (packages/engine/tests/fixtures/miniGame/**, Этап 7 плана: HostPlugin/
  // ClientPlugin фикстуры и её собственные тесты — вне packages/engine/src/,
  // поэтому не попадают под другие блоки globals/sourceType выше)
  {
    files: ['tests/**/*.js', 'packages/engine/tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        // глобалы Vitest (globals: true в vitest.config.js)
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // общие правила для всего проекта
  // (применяются ко всем JS файлам, если не переопределены выше)
  {
    rules: {
      // предупреждать о неиспользуемых переменных (используется tsserver)
      'no-unused-vars': 'off',
      // требовать === и !==
      eqeqeq: ['error', 'always'],
      // требовать фигурные скобки для всех блоков if, for, while и т.д.
      curly: ['error', 'all'],
      // предупреждать о ненужных else после return
      'no-else-return': 'warn',
      // использовать let/const вместо var
      'no-var': 'error',
      // предлагать использовать const, если переменная не переназначается
      'prefer-const': 'warn',
      // рекомендовать короткий синтаксис для свойств объектов
      'object-shorthand': ['warn', 'properties'],
      // тело стрелочной функции без {} если возможно
      'arrow-body-style': ['warn', 'as-needed'],
      // требовать camelCase именования
      camelcase: 'error',
      // плагин с запретом на caps в названиях
      'no-consecutive-caps/no-consecutive-caps': [
        'error',
        // VX/VY/RTT — свои; URL/RTC/URI — имена Web API (URLSearchParams,
        // RTCPeerConnection, encodeURIComponent), переименовать нельзя
        { exceptions: ['VX', 'VY', 'RTT', 'URL', 'RTC', 'URI'] },
      ],
    },
  },

  // стенд-ины ядра: имена методов зеркалят Wasm Host ABI (snake_case, как у
  // настоящих wasm-bindgen-биндингов GameCore/ClientCore) — camelCase здесь
  // неприменим, это не движковый JS-код
  {
    files: [
      'packages/engine/tests/fixtures/miniGame/host/fakeCore.js',
      'packages/engine/tests/fixtures/miniGame/client/fakeClientCore.js',
      'tests/devtools/VirtualClient.test.js',
      'tests/devtools/invariants.test.js',
      'tests/client/debug.test.js',
    ],
    rules: {
      camelcase: 'off',
    },
  },

  // игнорируемые файлы и директории
  {
    ignores: [
      'node_modules/**',
      'dist/**', // результаты сборки Vite
      'packages/*/dist/**', // сборка Vite движка
      '**/public/**', // статика (в т.ч. вендоренный pixi.js воркспейсов)
      'build/**',
      'target/**', // артефакты cargo (workspace)
      '**/.*', // игнорировать все файлы/директории, начинающиеся с '.'
      '**/_*', // игнорировать все файлы/директории, начинающиеся с '_'
    ],
  },
];
