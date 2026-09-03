/*
npx eslint . eslint.config.js
npx eslint --print-config src/host/meta/modules/Panel.js > log
*/

import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import noConsecutiveCapsPlugin from 'eslint-plugin-no-consecutive-caps';
import globals from 'globals';

// Замороженная таблица экспортов игрового wasm-ядра (И1/И3 плана
// plugin-forward-compat, core/src/abi.rs). Список только сокращается:
// удалить метод безопасно (старое ядро его всё ещё экспортирует, движок
// перестаёт звать), добавить — нет, потому что в dist уже опубликованной
// игры символ не появится никогда. Новая возможность ядра приезжает
// опкодом `dispatch` (packages/engine/src/config/abiOps.js).
const FROZEN_CLIENT_ABI = [
  'abi_describe',
  'apply_aim',
  'apply_input',
  'debug_json',
  'decode_frame',
  'dispatch',
  'hot_ptr',
  'hot_values',
  'my_game_id',
  'offset',
  'push_frame',
  'reset',
  'resync',
  'sample',
  'set_active',
  'set_map',
  'take_divergence',
  'take_frames',
];

const FROZEN_CORE_ABI = [
  'abi_describe',
  'alive_players',
  'apply_aim',
  'apply_input',
  'body_has_events',
  'clear',
  'debug_json',
  'deserialize_state',
  'dispatch',
  'frame_bytes',
  'frame_ptr',
  'is_alive',
  'last_input_seq',
  'load_map',
  'map_info',
  'pack_body',
  'pack_frame',
  'players_data',
  'position_of',
  'remove_actor',
  'remove_players_and_shots',
  'remove_scripted_actor',
  'reset_actor',
  'reset_all_vitals',
  'serialize_state',
  // append-only исключение (2.5D): метод добавлен вместе со слоями карты и
  // уже вошёл в замороженный слепок (contract/surface.json → abi.game).
  // Звать его напрямую можно только через проверку `typeof` — в dist игры,
  // опубликованной до слоёв, символа нет (GameCoreAdapter._applyActorLevel)
  'set_actor_level',
  'spawn_actor',
  'spawn_scripted_actor',
  'step',
  'take_events',
];

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
      // dedicated-сервер игры (Node.js): express + ws + матч в процессе
      'packages/engine/src/dedicated/**/*.js',
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
      // standalone SDK: та же вкладка, что и клиент (Этап 3 standalone-sdk)
      'packages/engine/src/standalone/**/*.js',
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

  // скаффолдер игр (create-vimp-game): обычный Node-CLI. Блоки выше его не
  // покрывают — 'packages/*/*.js' берёт только один сегмент вложенности
  {
    files: [
      'packages/create-vimp-game/bin/**/*.js',
      'packages/create-vimp-game/src/**/*.js',
      'packages/create-vimp-game/scripts/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.es2023,
        ...globals.node,
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

  // Умолчания gameConfig (этап 2 плана plugin-forward-compat): движок читает
  // конфиг игры только через createGameConfigView. Прямое разыменование
  // обходит умолчания, и поле, которого нет у игры прошлого поколения,
  // снова становится обязательным (И2). Исключения: сам модуль view и
  // правила devtools/contract/ — те проверяют конфиг РАЗРАБАТЫВАЕМОЙ игры
  // как есть, включая «поле не объявлено».
  {
    files: ['packages/engine/src/**/*.js'],
    ignores: [
      'packages/engine/src/lib/gameConfigView.js',
      'packages/engine/src/devtools/contract/**/*.js',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[object.property.name="gameConfig"]',
          message:
            'читай через createGameConfigView — прямое чтение обходит умолчания (И2)',
        },
        {
          selector: `MemberExpression[object.object.type="ThisExpression"][object.property.name="_core"]:not([property.name=/^(${FROZEN_CORE_ABI.join('|')})$/])`,
          message:
            'таблица экспортов ядра заморожена (И1/И3, plan/plugin-forward-compat/stage_4.md): ' +
            'у ядра, собранного год назад, нового метода нет — зови возможность опкодом через _op()',
        },
        // клиентская половина: ядро живёт в модульной переменной clientCore,
        // а не в this._core, — тот же запрет ей нужен по тем же причинам
        // (её таблица экспортов заморожена в contract/surface.json → abi.client)
        {
          selector: `MemberExpression[object.name="clientCore"]:not([property.name=/^(${FROZEN_CLIENT_ABI.join('|')})$/])`,
          message:
            'таблица экспортов клиентского ядра заморожена (И1/И3): у ядра, собранного год назад, ' +
            'нового метода нет — зови возможность опкодом через dispatchCoreOp() (lib/coreAbi.js)',
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
      // замороженные поколения корпуса совместимости — те же фейковые ядра
      'packages/engine/tests/fixtures/generations/*/host/fakeCore.js',
      'packages/engine/tests/fixtures/generations/*/client/fakeClientCore.js',
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
      // файлы шаблона игры: содержат токены {{…}} и намеренно отклоняются
      // от конвенций репозитория — линтуется уже сгенерированный проект
      'packages/create-vimp-game/templates/**',
      '**/.*', // игнорировать все файлы/директории, начинающиеся с '.'
      '**/_*', // игнорировать все файлы/директории, начинающиеся с '_'
    ],
  },
];
