// рекурсивно уничтожает запечённое значение: пекарь волен вернуть текстуру,
// массив кадров анимации или вложенный объект текстур по состояниям.
// try/catch: после потери WebGL-контекста текстуры уже мертвы
function destroyBaked(value) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (typeof value.destroy === 'function') {
    try {
      value.destroy(true);
    } catch {
      // текстура ушла вместе с контекстом — освобождать нечего
    }

    return;
  }

  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    destroyBaked(item);
  }
}

// класс для управления "запеченными" ассетами
// каждый потребитель владеет собственной коллекцией ассетов
export default class BakingProvider {
  // bakers — функции-пекари процедурных текстур (поставляет ClientPlugin игры)
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
    // Map — старые RenderTexture иначе останутся висеть в GPU-памяти
    for (const assets of this._collection.values()) {
      destroyBaked(assets);
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
