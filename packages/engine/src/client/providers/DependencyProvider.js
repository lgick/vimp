export default class DependencyProvider {
  constructor() {
    // приватное хранилище для подготовленных объектов зависимостей
    // Map<componentName, dependenciesObject>
    this._collection = new Map();
  }

  // собирает объекты зависимостей и упаковывает их для компонентов
  // availableServices - пул всех доступных сервисов
  // dependencyMap - карта, описывающая, какой компонент какой сервис требует
  collectAll(availableServices, dependencyMap) {
    this._collection.clear();

    const services = Object.keys(dependencyMap || {});

    for (const serviceName of services) {
      // если сервис доступен
      if (Object.hasOwn(availableServices, serviceName)) {
        const componentNames = dependencyMap[serviceName] || [];
        const service = availableServices[serviceName];

        for (const componentName of componentNames) {
          // получение существующего объекта зависимостей для компонента
          // или создание нового
          const dependencies = this._collection.get(componentName) || {};

          // добавление текущего сервиса
          dependencies[serviceName] = service;

          // устанавка объекта зависимостей для компонента
          this._collection.set(componentName, dependencies);
        }
      }
    }
  }

  // возвращает всю коллекцию "собранных" зависимостей
  getDependenciesCollection() {
    return this._collection;
  }
}
