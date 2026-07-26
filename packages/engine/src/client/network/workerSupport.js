// Фича-детект модульных Worker'ов (Этап 6.3): нет classic-фолбэка (запретил
// бы ESM и потребовал инлайн WASM, см. PLAN.md риск №5) — вместо него честная
// ошибка при «Создать сервер», join остаётся доступен. Конструктор Worker не
// бросает исключение на неизвестной опции `type`, поэтому используется
// классический трюк: геттер `type` читают только реализации, которые умеют
// module-воркеры — на остальных `supported` останется false.
export function supportsModuleWorker() {
  let supported = false;

  try {
    const worker = new Worker('data:text/javascript,', {
      get type() {
        supported = true;

        return 'module';
      },
    });

    worker.terminate();
  } catch (e) {
    supported = false;
  }

  return supported;
}
