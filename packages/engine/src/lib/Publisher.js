/**
 * Observer pattern (Publisher)
 * on: добавляет слушателя (подписчика)
 * emit: рассылает событие подписчикам
 */
class Publisher {
  constructor() {
    // Объект для хранения подписчиков по типу события
    this.subs = {};
  }

  /**
   * Добавляет подписчика для указанного типа события.
   * @param {string} type - Тип события.
   * @param {Function|string} fn - Функция-обработчик или имя метода.
   * @param {Object} [context] - Контекст, в котором будет вызвана функция.
   */
  on(type, fn, context) {
    this.subs[type] = this.subs[type] || [];

    if (typeof fn !== 'function') {
      // Если передано не функция, предполагаем, что это имя метода в context.
      fn = context[fn];
    }

    this.subs[type].push({
      fn,
      context: context || this,
    });
  }

  /**
   * Рассылает событие указанного типа всем подписчикам.
   * @param {string} type - Тип события.
   * @param {*} data - Данные, которые передаются подписчикам.
   */
  emit(type, data) {
    const subscribers = this.subs[type] || [];
    subscribers.forEach(({ fn, context }) => fn.call(context, data));
  }
}

export default Publisher;
