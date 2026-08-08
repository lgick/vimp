// рекурсивно уничтожает запечённое значение: пекарь волен вернуть текстуру,
// массив кадров анимации или вложенный объект текстур по состояниям.
// try/catch: после потери WebGL-контекста текстуры уже мертвы.
// seen — дедуп за проход (набор заводит вызывающий bakeAll): один объект
// может лежать под двумя ключами и в ассетах разных компонентов, а
// destroy(true) второй раз бессмысленен и маскировался бы тем же catch
function destroyBaked(value, seen) {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return;
  }

  seen.add(value);

  if (typeof value.destroy === 'function') {
    try {
      value.destroy(true);
    } catch (e) {
      // текстура ушла вместе с контекстом — освобождать нечего
      console.warn('[baking] destroy failed:', e);
    }

    return;
  }

  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    destroyBaked(item, seen);
  }
}

// класс для управления "запеченными" ассетами
// каждый потребитель владеет собственной коллекцией ассетов
export default class BakingProvider {
  // bakers — функции-пекари процедурных текстур (поставляет ClientPlugin игры).
  // Пекарь владеет тем, что вернул: перепечка уничтожает результат вместе с
  // его TextureSource, поэтому возвращать вьюху на чужой/общий атлас нельзя
  constructor(bakers = {}) {
    this._bakers = bakers;

    // коллекция для хранения "запеченных" ассетов
    // Map<constructor, assetsObject>
    this._collection = new Map();
  }

  // "запекает" ассеты и упаковывает их для потребителей
  // arr - массив объектов с данными для создания ассетов
  // pixiApp - экземпляр PIXI приложения
  bakeAll(arr, pixiApp) {
    const renderer = pixiApp.renderer;

    // перепечка (восстановление WebGL-контекста) идёт в тот же экземпляр
    // Map — старые RenderTexture иначе останутся висеть в GPU-памяти.
    // seen — дедуп на весь проход: один объект может лежать и в ассетах
    // разных компонентов, второй destroy(true) по нему бессмысленен
    const seen = new Set();

    for (const assets of this._collection.values()) {
      destroyBaked(assets, seen);
    }

    this._collection.clear();

    // "запекание" ассетов
    for (const data of arr) {
      const assetName = data.name;
      const componentName = data.component;
      const bakerFn = this._bakers[assetName];

      if (bakerFn) {
        const bakedAsset = bakerFn(data.params, renderer);

        // если для этого компонента нет контейнера ассетов
        if (!this._collection.has(componentName)) {
          this._collection.set(componentName, {});
        }

        // добавляем "запеченный" ассет в контейнер соответствующего компонента
        const assetsContainer = this._collection.get(componentName);

        assetsContainer[assetName] = bakedAsset;
      }
    }
  }

  // возвращает всю коллекцию "запеченных" ассетов
  getAssetsCollection() {
    return this._collection;
  }
}
