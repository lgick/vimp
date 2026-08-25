import { resolveForcedValue } from './formBuilder.js';

// Значения полей auth-формы до её постройки (PS_AUTH_DATA.params).
// Вынесено из socketMethods[PS_AUTH_DATA] (main.js), чтобы этот код был
// накрыт тестом: solo-путь (boot.autoAuth) отвечает хосту вообще без формы и
// берёт значения ровно отсюда, то есть ошибка здесь не видна ни в одном
// тесте формы.

/**
 * Правит `param.value` на месте: сначала память клиента
 * (`localStorage[storage]`), затем схема. Порядок важен — поле с
 * единственным вариантом форма не показывает и править не даёт, поэтому
 * устаревший `localStorage` от версии игры, где вариантов было больше,
 * обязан быть перекрыт: иначе он уедет на хост и получит отказ от
 * игровых validators, а поправить его игроку нечем.
 *
 * Мутация, а не копия: тот же массив main.js отдаёт следом в
 * `AuthCtrl.init` (оттуда он попадает в `AuthModel._data`) и в
 * `defaultsFrom(params)` на solo-пути.
 *
 * @param {Array<Object>} params - PS_AUTH_DATA.params.
 * @param {Object} [storage] - Хранилище значений, по умолчанию localStorage.
 * @returns {Array<Object>} Тот же массив.
 */
export function normalizeAuthParams(params, storage = localStorage) {
  params.forEach(param => {
    const descriptor = param.options ?? {};

    if (descriptor.storage) {
      param.value = storage[descriptor.storage] || param.value || '';
    }

    const forced = resolveForcedValue(descriptor);

    if (forced !== undefined) {
      param.value = forced;
    }
  });

  return params;
}
