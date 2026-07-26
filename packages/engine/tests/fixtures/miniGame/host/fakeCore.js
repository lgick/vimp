// Фейковое JS-ядро миниигры-фикстуры (Этап 7 плана отделения движка,
// PLAN.md §4/Wasm Host ABI §3.4): реализует полную поверхность методов,
// которую вызывает GameCoreAdapter, без Rust/WASM — доказательство, что
// движок не завязан на конкретную реализацию ядра. Актёры — плоские
// объекты { x, y, angle, team, alive }; тик — тривиальная линейная
// интеграция скорости (та же идея, что у Rust-фикстуры TestClient,
// core/src/client/game.rs: форма ABI важнее физики).
export default class FakeGameCore {
  constructor(configJson) {
    this._config = JSON.parse(configJson);
    this._actors = new Map(); // gameId -> { x, y, angle, team, alive, vx, vy, lastInputSeq }
    this._map = null;
    this._events = [];
    this._lastBody = [];
    this._lastFrame = null;
  }

  // ***** карта ***** //

  load_map(mapJson) {
    this._map = JSON.parse(mapJson);
  }

  map_info() {
    if (!this._map) {
      return 'null';
    }

    return JSON.stringify({
      setId: this._map.setId,
      respawns: this._map.respawns || {},
    });
  }

  clear() {
    this._actors.clear();
    this._events.length = 0;
    this._lastBody = [];
  }

  // ***** участники ***** //

  spawn_actor(gameId, model, teamId, x, y, angle) {
    this._actors.set(gameId, {
      x,
      y,
      angle,
      team: teamId,
      alive: true,
      vx: 0,
      vy: 0,
      lastInputSeq: 0,
    });

    this._events.push({ type: 'panelSet', id: gameId, field: 'energy', value: 100 });
  }

  remove_actor(gameId) {
    this._actors.delete(gameId);
  }

  reset_actor(gameId, teamId, x, y, angle) {
    const actor = this._actors.get(gameId);

    if (actor) {
      Object.assign(actor, { x, y, angle, team: teamId, alive: true, vx: 0, vy: 0 });
    }
  }

  reset_all_vitals() {
    for (const actor of this._actors.values()) {
      actor.alive = true;
    }
  }

  spawn_scripted_actor(gameId, model, teamId, x, y, angle) {
    this.spawn_actor(gameId, model, teamId, x, y, angle);
    this._actors.get(gameId).scripted = true;
  }

  remove_scripted_actor(gameId) {
    this.remove_actor(gameId);
  }

  remove_players_and_shots() {
    const names = [...this._actors.keys()].map(String);

    this._actors.clear();

    return JSON.stringify(names);
  }

  // ***** ввод ***** //

  apply_input(gameId, seq, action, name) {
    const actor = this._actors.get(gameId);

    if (!actor) {
      return;
    }

    actor.lastInputSeq = seq;

    const magnitude = action === 'down' ? 40 : 0;

    if (name === 'forward') {
      actor.vy = -magnitude;
    } else if (name === 'back') {
      actor.vy = magnitude;
    } else if (name === 'fire' && action === 'down') {
      this._events.push({ type: 'custom', data: { kind: 'fire', id: gameId } });
    }
  }

  last_input_seq(gameId) {
    return this._actors.get(gameId)?.lastInputSeq ?? 0;
  }

  // ***** запросы состояния ***** //

  is_alive(gameId) {
    return Boolean(this._actors.get(gameId)?.alive);
  }

  position_of(gameId) {
    const actor = this._actors.get(gameId);

    return actor ? [actor.x, actor.y] : [];
  }

  players_data() {
    return JSON.stringify(
      [...this._actors.entries()].map(([id, a]) => ({
        id: Number(id),
        x: a.x,
        y: a.y,
        team: a.team,
      })),
    );
  }

  // ***** игровой тик ***** //

  step(dt) {
    for (const actor of this._actors.values()) {
      actor.x += actor.vx * dt;
      actor.y += actor.vy * dt;
    }
  }

  take_events() {
    const events = this._events;

    this._events = [];

    return JSON.stringify(events);
  }

  // ***** упаковка снапшота (фикстурный формат — не бинарный кодек ядра;
  // достаточно для тестов меты, которые не декодируют реальный фрейминг) ***** //

  pack_body() {
    this._lastBody = [...this._actors.entries()].map(([id, a]) => ({
      id: Number(id),
      x: a.x,
      y: a.y,
    }));
  }

  body_has_events() {
    return false;
  }

  pack_frame(serverTime, seq, hasCamera, camX, camY, forceReset, shake, playerId) {
    this._lastFrame = {
      serverTime,
      seq,
      camera: hasCamera ? [camX, camY, Boolean(forceReset), shake ?? null] : null,
      playerId,
      body: this._lastBody,
    };
  }

  frame_bytes() {
    return new TextEncoder().encode(JSON.stringify(this._lastFrame));
  }

  // ***** handoff (задел, PLAN.md §6 «открытые вопросы») ***** //

  serialize_state() {
    return new TextEncoder().encode(JSON.stringify([...this._actors.entries()]));
  }

  deserialize_state(bytes) {
    const entries = JSON.parse(new TextDecoder().decode(bytes));

    this._actors = new Map(entries);
  }
}
