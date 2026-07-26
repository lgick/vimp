const config = {};

// добавляет новое значение в config
//
// keys - может иметь несколько вложенностей,
// вложенности разделены ':', например:
// key1:key2:key3 будет значением config[key1][key2][key3]
//
// если структура вложенностей изменилась,
// новые пути перезапишут старый вариант
//
// value - может быть значением любого типа
function set(keys, value) {
  if (!keys) {
    console.error(`Error: The "keys" argument cannot be empty.`);
    return;
  }

  const arr = keys.split(':');

  // проверка на пустые сегменты
  if (arr.includes('')) {
    console.error(
      `Error: The path '${keys}' is invalid (contains empty segments).`,
    );
    return;
  }

  const lastKey = arr.pop(); // последний ключ для записи значения
  let currentLevel = config;

  for (const key of arr) {
    // если не является объектом, создание пустого объекта,
    // стирая вложенность, если она была
    if (typeof currentLevel[key] !== 'object' || currentLevel[key] === null) {
      currentLevel[key] = {};
    }

    currentLevel = currentLevel[key];
  }

  // запись финального значения
  currentLevel[lastKey] = value;
}

// возвращает значение по ключу или undefined
// ключ может иметь несколько вложенностей
// вложенности разделены ':',
// например: key1:key2:key3 вернет значение config[key1][key2][key3]
// вызов без аргументов вернет весь конфиг
function get(keys) {
  if (!keys) {
    return config;
  }

  const arr = keys.split(':');
  let currentLevel = config;

  for (let i = 0, len = arr.length; i < len; i += 1) {
    const key = arr[i];

    // если поиск свойства не в объекте
    if (typeof currentLevel !== 'object' || currentLevel === null) {
      console.error(keys, `${currentLevel} is not object`);
      return;
    }

    // если свойство есть в объекте
    if (key in currentLevel) {
      currentLevel = currentLevel[key];
    } else {
      console.error(keys, `${key} is not property`);
      return;
    }
  }

  return currentLevel;
}

export default {
  set,
  get,
};
