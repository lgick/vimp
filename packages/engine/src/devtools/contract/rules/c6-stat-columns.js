import { WARN, skip, verdict } from '../result.js';

// Сколько в статистике колонок — решение игры: их объявляет её схема, а
// движковые записи в необъявленную колонку просто игнорируются
// (host/meta/modules/Stat.js, Д7). Своя у движка только вёрстка — style.css
// раздаёт ширины пяти колонкам (#stat …:nth-child(1)…(5)), и шестая без
// собственных стилей схлопывается в ноль. Поэтому правило проверяет не число
// колонок, а покрыта ли раскладка: игра со своими ClientPlugin.styles вправе
// объявить сколько угодно. Ширина — соглашение, а не отказ, отсюда warn.
const ENGINE_COLUMNS = 5;

// Правило разбирает CSS плагина эвристикой, а не парсером: «колонку кроет
// объявление ширины на селекторе с #stat и ячейкой».
// Пара «селектор + тело»: [^{}] не перешагивает вложенную скобку, поэтому
// matchAll ловит именно внутреннее правило, в том числе завёрнутое в
// @media/@supports (разбор по split('}') видел там обёртку и терял селектор).
const RULE = /([^{}]+)\{([^{}]*)\}/g;
// ячейка колонки: движковая раскладка адресует их как `#stat … td|span`
const CELL = /(?:^|[\s.#>+~])(?:td|th|span)(?=[\s.:#>+~,[]|$)/;
// правило про раскладку, а не про цвет: колонку кроет только объявление
// ширины или её флекс-эквивалент
const WIDTH =
  /(?:^|[\s;])(?:width|min-width|max-width|flex|flex-basis|flex-grow)\s*:/;
// трек-лист грида задаёт ширины всем колонкам разом и стоит на контейнере
// (`#stat table`, `#stat .stat-head`), который CELL по определению не
// проходит, — поэтому отдельной веткой, а не пунктом в WIDTH
const GRID = /(?:^|[\s;])grid-template-columns\s*:/;

// Индексы колонок, которым стили плагина задают ширину. Селектор ячеек без
// nth-child ('#stat table td') правит всю таблицу разом.
function styledColumns(styles, total) {
  const covered = new Set();

  for (const [, selector, body] of String(styles || '').matchAll(RULE)) {
    if (!selector.includes('#stat')) {
      continue;
    }

    // грид на контейнере перечисляет все треки сразу — колонки покрыты все
    if (GRID.test(body)) {
      for (let index = 1; index <= total; index += 1) {
        covered.add(index);
      }

      continue;
    }

    if (!CELL.test(selector) || !WIDTH.test(body)) {
      continue;
    }

    const indexes = [...selector.matchAll(/nth-child\((\d+)\)/g)];

    if (indexes.length === 0) {
      for (let index = 1; index <= total; index += 1) {
        covered.add(index);
      }

      continue;
    }

    for (const [, index] of indexes) {
      covered.add(Number(index));
    }
  }

  return covered;
}

// Режим 'leaderboard' (snakes-v3 этап 4): движок даёт списку только
// каркас, внешний вид — дело игры. Достаточно любого правила плагина про
// `.stat-leaderboard` — раскладка колонок там на контейнере, а не на ячейках
function styledLeaderboard(styles) {
  for (const [, selector] of String(styles || '').matchAll(RULE)) {
    if (selector.includes('.stat-leaderboard')) {
      return true;
    }
  }

  return false;
}

export default {
  id: 'C6',
  name: 'statColumns',
  level: WARN,
  title: 'stat columns past the engine layout are styled by the plugin',

  check(ctx) {
    const params = ctx.clientConfig?.modules?.stat?.params;
    const columns = params?.columns;

    if (!columns) {
      return skip('no client stat columns');
    }

    // snakes-v3 этап 4: в режиме 'leaderboard' движковых таблиц нет вовсе —
    // рисуется один список `.stat-leaderboard`, и число колонок движковой
    // раскладке ничего не говорит. Проверять здесь надо другое: привезла
    // ли игра свои стили под этот список
    if (params.mode === 'leaderboard') {
      return styledLeaderboard(ctx.clientPlugin?.styles)
        ? verdict([], 'leaderboard list, laid out by the plugin\'s own styles')
        : verdict([
            "stat declares mode 'leaderboard', but ClientPlugin.styles says " +
              'nothing about #stat .stat-leaderboard: the engine CSS gives ' +
              'the list only a bare three-column skeleton',
          ]);
    }

    // меньше пяти — движковых ширин просто хватает с запасом
    if (columns.length <= ENGINE_COLUMNS) {
      return verdict([]);
    }

    const covered = styledColumns(ctx.clientPlugin?.styles, columns.length);
    const missing = [];

    for (let index = ENGINE_COLUMNS + 1; index <= columns.length; index += 1) {
      if (!covered.has(index)) {
        missing.push(index);
      }
    }

    if (missing.length === 0) {
      return verdict(
        [],
        `${columns.length} columns, laid out by the plugin's own styles`,
      );
    }

    return verdict([
      `stat declares ${columns.length} columns, but ClientPlugin.styles ` +
        `gives no width to column(s) ${missing.join(', ')}: the engine CSS ` +
        `lays out ${ENGINE_COLUMNS} (#stat …:nth-child(1)…(${ENGINE_COLUMNS})), ` +
        'so the rest are rendered with no width of their own',
    ]);
  },
};
