// Единая точка доступа к времени, случайности и таймерам.
//
// Прод работает на реализации по умолчанию (глобалы) — поведение не меняется.
// Headless-runner подменяет её виртуальной через install(): без этого
// десятиминутный матч невозможно прогнать за секунды, а прогон со случайным
// seed невозможно воспроизвести.
//
// now() и monotonic() разделены намеренно: игровой цикл считает dt по
// performance.now(), разрешение которого сильно выше миллисекунды Date.now().
// Виртуальная реализация выводит оба из одного счётчика.

const defaults = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  random: () => Math.random(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timerId => clearTimeout(timerId),
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: timerId => clearInterval(timerId),
};

let impl = defaults;

// подменяет реализацию; недостающие методы берутся из дефолтных
// возвращает функцию отката к предыдущей реализации
function install(custom = {}) {
  const previous = impl;

  impl = { ...defaults, ...custom };

  return () => {
    impl = previous;
  };
}

// возврат к глобалам
function reset() {
  impl = defaults;
}

// делегирование позднее (impl читается в момент вызова), чтобы install()
// действовал на уже импортировавшие clock модули
export default {
  install,
  reset,
  now: () => impl.now(),
  monotonic: () => impl.monotonic(),
  random: () => impl.random(),
  setTimeout: (callback, delay) => impl.setTimeout(callback, delay),
  clearTimeout: timerId => impl.clearTimeout(timerId),
  setInterval: (callback, delay) => impl.setInterval(callback, delay),
  clearInterval: timerId => impl.clearInterval(timerId),
};
