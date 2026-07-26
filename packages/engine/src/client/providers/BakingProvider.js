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
