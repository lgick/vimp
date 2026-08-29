// Append-only реестр (И1 плана plugin-forward-compat, этап 3). Движок держит
// закрытые словари, из которых игра выбирает значения: контролы формы, имена
// клиентских сервисов. Запись НИКОГДА не удаляется: игра, собранная два года
// назад, могла её написать, и её dist больше никто не тронет — сокращение
// словаря отвергает такую игру молча. Вывод из эксплуатации =
// { alias: 'новое-имя' } + запись в CHANGELOG, но не удаление строки.
//
// Именно так сломался v2 → v3: набор `control` урезали до четырёх нативных
// элементов, и `range`/`number`/`toggle`/`segmented` перестали строиться.

/**
 * Создаёт append-only реестр имён плагинной поверхности.
 * @param {string} name - Имя реестра (в тексте ошибок).
 * @param {Array<Object>} entries - Записи `{ value, since, alias?,
 *   retiredIn?, note?, ...полезная нагрузка }`. Запись с `alias` — выведенное
 *   из эксплуатации имя: оно продолжает работать, разрешаясь в указанное.
 * @returns {Object} Реестр: `has`, `get`, `resolve`, `chain`, `isRetired`,
 *   `list`, `values`.
 */
export function createRegistry(name, entries) {
  const byValue = new Map();

  for (const entry of entries) {
    if (byValue.has(entry.value)) {
      throw new Error(`registry ${name}: duplicate entry "${entry.value}"`);
    }

    byValue.set(entry.value, Object.freeze({ ...entry }));
  }

  // цепочка алиасов от имени к активной записи; пустая, если имени нет
  const chain = value => {
    const trail = [];
    const seen = new Set();
    let current = byValue.get(value);

    while (current !== undefined) {
      if (seen.has(current.value)) {
        throw new Error(
          `registry ${name}: alias cycle at "${current.value}" — ` +
            'a retired name must resolve to an active one',
        );
      }

      seen.add(current.value);
      trail.push(current);

      if (current.alias === undefined) {
        return trail;
      }

      const next = byValue.get(current.alias);

      if (next === undefined) {
        throw new Error(
          `registry ${name}: "${current.value}" is aliased to unknown ` +
            `"${current.alias}"`,
        );
      }

      current = next;
    }

    return trail;
  };

  // битый реестр — дефект движка, а не плагина: пусть падает на загрузке
  // модуля, а не на первой игре, которая напишет выведенное имя
  for (const value of byValue.keys()) {
    chain(value);
  }

  return Object.freeze({
    name,
    has: value => byValue.has(value),
    get: value => byValue.get(value),
    // разрешает имя в активное (проходит цепочку алиасов). undefined — имя
    // неизвестно; это ВСЕГДА ошибка плагина (он попросил будущее), никогда
    // не ошибка движка за то, что у него список длиннее
    resolve: value => chain(value).at(-1)?.value,
    chain,
    isRetired: value => byValue.get(value)?.alias !== undefined,
    // все записи, включая выведенные: слепок поверхности (этап 1) не считает
    // вывод из эксплуатации удалением
    list: () => [...byValue.values()],
    // только активные имена — то, что вправе написать НОВАЯ игра
    values: () =>
      [...byValue.values()]
        .filter(e => e.alias === undefined)
        .map(e => e.value),
  });
}

export default createRegistry;
