// Заглушечный part фикстуры (ClientPlugin.parts, PLAN.md §3.3) — минимальная
// форма рендер-сущности: конструктор + update(state)/destroy(), без PixiJS
// (тесты не поднимают живой канвас). Доказывает, что Factory/CanvasManager
// не требуют конкретно PixiJS-Container-класса — только этот интерфейс.
export default class Actor {
  constructor(id) {
    this.id = id;
    this.destroyed = false;
  }

  update(state) {
    this.state = state;
  }

  destroy() {
    this.destroyed = true;
  }
}
