// Фейковое клиентское ядро миниигры-фикстуры: минимальная реализация
// движкового клиентского ABI (см. export_client_core_abi!, PLAN.md §3.4) —
// используется только для проверки контракта ClientPlugin.createClientCore,
// не участвует в реальном рендер-цикле (нет тестов на живой канвас).
export default class FakeClientCore {
  constructor(configJson) {
    this._config = JSON.parse(configJson);
    this._active = false;
  }

  push_frame() {
    return true;
  }

  my_game_id() {
    return null;
  }

  offset() {
    return null;
  }

  sample() {
    return 0;
  }

  hot_ptr() {
    return 0;
  }

  hot_values() {
    return new Float32Array(0);
  }

  take_frames() {
    return '[]';
  }

  apply_input() {}

  set_active(active) {
    this._active = active;
  }

  set_map() {}

  reset() {}

  decode_frame() {
    return 'null';
  }
}
