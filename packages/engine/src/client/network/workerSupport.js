// Фича-детект модульных Worker'ов (Этап 6.3): нет classic-фолбэка (запретил
// бы ESM и потребовал инлайн WASM, см. PLAN.md риск №5) — вместо него честная
// ошибка при «Создать сервер», join остаётся доступен. Конструктор Worker не
// бросает исключение на неизвестной опции `type`, поэтому используется
// классический трюк: геттер `type` читают только реализации, которые умеют
// module-воркеры — на остальных `supported` останется false. URL пробного
// воркера — `blob:`, а не `data:`, чтобы не нарушать CSP `worker-src 'self'
// blob:'` (data: там не разрешён и браузер блокирует создание воркера).
export function supportsModuleWorker() {
  let supported = false;
  let probeUrl;

  try {
    probeUrl = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));

    const worker = new Worker(probeUrl, {
      get type() {
        supported = true;

        return 'module';
      },
    });

    worker.terminate();
  } catch (e) {
    supported = false;
  } finally {
    if (probeUrl) {
      URL.revokeObjectURL(probeUrl);
    }
  }

  return supported;
}
