import hostDefaults from '../config/hostDefaults.js';

// Единственная точка чтения HostPlugin.gameConfig движком (этап 2 плана
// plugin-forward-compat). До неё движок разыменовывал конфиг игры россыпью
// по коду, и каждое новое поле немедленно становилось обязательным —
// прямое нарушение И2 («ничто новое не обязательно»).
//
// View — обычный объект (не класс): applyRoomOverrides делает по нему
// structuredClone и spread, а те не переживают прототипы и геттеры-ловушки.
// Поля игры, о которых движок не знает, копируются как есть — игра вправе
// держать в gameConfig что угодно сверх контракта.

// Каждая строка ниже — обещание совместимости: поле, которого нет в конфиге
// старой игры, отдаёт умолчание, а не роняет загрузку (И2). Умолчание
// обязано быть безопасным для игры, которая о поле не знает.
//
// Ключ — путь через точку, значение — { default } либо { derive(config) }.
// Список может только РАСТИ: перенос поля отсюда в REQUIRED отверг бы уже
// опубликованные игры.
const FIELDS = {
  // название в лобби; null → вызывающий берёт plugin.id
  title: { default: null },

  // карты везёт мастер (room.maps), у игры их может не быть вовсе
  maps: { default: {} },
  currentMap: { default: null },
  // сколько карт попадает в голосование; 1 — минимальный осмысленный набор
  mapsInVote: { default: 1 },
  mapScale: { default: 1 },
  mapSetId: { default: null },

  // лимит комнаты: без него берётся движковый (hostDefaults.maxPlayers)
  'roomDefaults.maxPlayers': { default: hostDefaults.maxPlayers },

  // игра без оружия — не экзотика: @vimp-games/snakes уже такая
  'parts.weapons': { default: {} },
  // огонь по своим — опция игры; «нет опции» значит «выключено»
  'parts.friendlyFire': { default: false },

  // пустая панель рисуется корректно: Panel читает её через Object.keys.
  // fields — словарь «имя → { key, value }», поэтому пусто здесь это {}
  'panel.fields': { default: {} },
  'panel.activeKey': { default: null },

  // таблица статистики и стартовые данные участника — целиком игровые
  stat: { default: {} },
  scripted: { default: {} },
  playerState: { default: {} },

  soundCues: { default: {} },
  // голосование на входе (обычно 'teamChange'); null — входим молча
  initialVote: { default: null },

  // чем игра занимает экран по Tab: движковая таблица или свой лидерборд
  statMode: { default: 'table' },
  // opt-in-флаги: их отсутствие всегда означало «выключено»
  noSpectators: { default: false },
  endlessRound: { default: false },

  spectatorTeam: { derive: deriveSpectatorTeam },
};

// Все пути gameConfig, которые движок читает: объявленные игрой поля плюс
// те, за которые он подставляет умолчание. Раздел слепка поверхности
// (contract/surface.json → gameConfigFields): исчезнувший отсюда путь —
// нарушение И1, потому что игра могла его написать.
export const KNOWN_GAME_CONFIG_PATHS = Object.keys(FIELDS);

// ЗАМОРОЖЕНО (И2). Этот список может только СОКРАЩАТЬСЯ.
// Добавление сюда отвергнет все ранее опубликованные игры — вместо этого
// заведи поле в FIELDS с умолчанием. Страж: tests/devtools/surface.test.js.
export const REQUIRED_GAME_CONFIG_PATHS = [
  'parts.models', // из чего состоит участник; синтезировать нечем
  'playerKeys', // без них ядро не знает ввода
  'snapshot', // раскладка кадра; движок её не придумывает
  'teams', // ParticipantManager выбирает команду входа
];

// Единственный признак «команда наблюдателей», который есть в данных, —
// её имя: teams это словарь «имя → id», флагов в нём нет. Игра, объявившая
// наблюдателей как-то иначе, обязана назвать spectatorTeam явно.
const SPECTATOR_TEAM_NAME = 'spectators';

function deriveSpectatorTeam(config, gameId) {
  // наблюдателей нет как концепции — связывать нечего
  if (config.noSpectators === true) {
    return null;
  }

  if (Object.hasOwn(config.teams ?? {}, SPECTATOR_TEAM_NAME)) {
    return SPECTATOR_TEAM_NAME;
  }

  // null — рабочее значение (ParticipantManager заводит участника в первую
  // команду), но почти наверняка не то, чего хотела игра: предупреждаем
  console.warn(
    `game "${gameId}": gameConfig.spectatorTeam is not set and teams has ` +
      `no "${SPECTATOR_TEAM_NAME}" key — everyone joins the first team ` +
      `(${Object.keys(config.teams ?? {})[0] ?? '—'}); declare ` +
      'spectatorTeam or noSpectators to say what you meant',
  );

  return null;
}

function getPath(source, dottedPath) {
  return dottedPath.split('.').reduce((value, key) => value?.[key], source);
}

// copy-on-write: умолчание вкладывается в копию ветки, объект игры не
// правится — gameConfig принадлежит плагину и переживает перезапуск матча
function setPath(target, dottedPath, value) {
  const keys = dottedPath.split('.');
  let node = target;

  for (const key of keys.slice(0, -1)) {
    node[key] =
      node[key] === undefined || node[key] === null ? {} : { ...node[key] };
    node = node[key];
  }

  node[keys.at(-1)] = value;
}

/**
 * Строит представление gameConfig с умолчаниями и проверяет обязательное.
 * @param {Object} gameConfig - HostPlugin.gameConfig игры как есть.
 * @param {string} [gameId] - id плагина; попадает в текст ошибок.
 * @returns {Object} Конфиг: поля игры плюс умолчания движка. Заморожен
 *   ПОВЕРХНОСТНО — вложенные ветки (parts, roomDefaults) правятся; глубокая
 *   заморозка стоила бы обхода всего конфига игры на каждом старте матча, а
 *   единственный потребитель (applyRoomOverrides) и так делает structuredClone.
 * @throws {Error} Если нет поля из REQUIRED_GAME_CONFIG_PATHS или конфиг
 *   внутренне противоречив (spectatorTeam вне teams, noSpectators при двух
 *   командах).
 */
export function createGameConfigView(gameConfig, gameId = 'unknown') {
  const source = gameConfig ?? {};

  // null проходил бы проверку присутствия, хотя ни одно из этих полей не
  // бывает пустым по контракту: движок разыменовывает их сразу, и гейт,
  // заведённый ради текста вместо TypeError, сам отвечал бы TypeError
  const missing = REQUIRED_GAME_CONFIG_PATHS.filter(path => {
    const value = getPath(source, path);

    return value === undefined || value === null;
  });

  if (missing.length > 0) {
    throw new Error(
      `game "${gameId}": gameConfig is missing required field(s): ` +
        missing.join(', '),
    );
  }

  const view = { ...source };

  for (const [path, spec] of Object.entries(FIELDS)) {
    const value = getPath(source, path);

    if (value !== undefined && value !== null) {
      continue;
    }

    setPath(
      view,
      path,
      spec.derive ? spec.derive(source, gameId) : spec.default,
    );
  }

  assertConsistent(view, source, gameId);

  return Object.freeze(view);
}

// Проверки внутренней согласованности того, что игра УЖЕ прислала. Это не
// новые требования (И2): поле, которого нет, здесь не проверяется вовсе.
function assertConsistent(view, source, gameId) {
  const { teams } = view;

  // noSpectators: связывать нечего — зато команда обязана быть ровно одна.
  // Вторая играющая команда без наблюдателей означала бы вход «куда-нибудь»,
  // а ParticipantManager выбирает команду входа однозначно
  if (view.noSpectators === true) {
    if (Object.keys(teams).length !== 1) {
      throw new Error(
        `game "${gameId}": noSpectators requires exactly one team, ` +
          `got ${Object.keys(teams).length} (${Object.keys(teams).join(', ')})`,
      );
    }

    return;
  }

  // spectatorTeam — имя ключа внутри teams, и опечатка даёт spectatorId ===
  // undefined, после чего участник заходит в несуществующую команду
  // (ParticipantManager.createHuman валится на её счётчике). Проверяем
  // только объявленное игрой: выведенное значение уже согласовано
  const declared = source.spectatorTeam;

  if (
    declared !== undefined &&
    declared !== null &&
    teams[declared] === undefined
  ) {
    throw new Error(
      `game "${gameId}": spectatorTeam '${declared}' is not a ` +
        `key of teams (${Object.keys(teams).join(', ')})`,
    );
  }
}

export default createGameConfigView;
