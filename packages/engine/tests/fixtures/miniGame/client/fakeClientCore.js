// Фейковое клиентское ядро миниигры-фикстуры: минимальная реализация
// движкового клиентского ABI (см. export_client_core_abi!, PLAN.md §3.4).
//
// Кадры фикстуры — не бинарный кодек ядра, а JSON (см. host/fakeCore.js:
// frame_bytes), поэтому push_frame их просто разбирает, а интерполяции нет:
// sample() отдаёт последний принятый кадр. Раскладка hot-буфера при этом
// настоящая (флаги, две группы, ширина записи = 2 + поля схемы) — именно её
// читает движковый reconstructHot, и именно она замыкает headless-контур
// «хост → байты → клиентское ядро → сцена» без WASM.

import { HOT_FLAGS } from '../../../../src/config/opcodes.js';

export default class FakeClientCore {
  constructor(configJson) {
    this._config = JSON.parse(configJson);
    this._active = false;
    this._frame = null;
    this._hot = new Float32Array(0);

    // обратный индекс снапшот-схемы: keyId → { key, kind, fields }
    const keys = this._config.engine?.snapshot?.keys ?? {};

    this._hotKey = Object.entries(keys).find(
      ([, spec]) => spec.class === 'hot' && spec.kind === 'indexed8',
    );

    // детектор рассинхрона предикта (этап 5): включается секцией divergence
    // движкового конфига, как и в Rust-ядре
    const cfg = this._config.engine?.divergence;

    this._divergenceCfg = cfg ?? null;
    this._divergence = cfg
      ? { samples: 0, violations: 0, dropped: 0, maxDelta: [0, 0], records: [] }
      : null;

    // предикт фикстуры: та же таблица скоростей, что у host/fakeCore, плюс
    // история её изменений — реконсиляция идёт по времени кадра, поэтому
    // история переигрывается от момента авторитетного состояния, а не от seq
    this._vy = 0;
    this._inputs = []; // [{ time, vy }] в локальном времени
    this._base = null; // { x, y, time, vy } — последнее авторитетное, в серверном
    this._offset = 0;
  }

  push_frame(data, localNow = 0) {
    let frame;

    try {
      frame = JSON.parse(new TextDecoder().decode(data));
    } catch {
      return false;
    }

    this._offset = frame.serverTime - localNow;
    this._observeDivergence(frame);
    this._frame = frame;

    return true;
  }

  my_game_id() {
    return this._frame?.playerId ?? null;
  }

  offset() {
    return 0;
  }

  sample() {
    if (!this._frame || !this._hotKey) {
      this._hot = new Float32Array(0);

      return 0;
    }

    const [, spec] = this._hotKey;
    const body = this._frame.body ?? [];
    const camera = this._frame.camera;
    const values = [
      HOT_FLAGS.GAME | (camera ? HOT_FLAGS.CAMERA : 0),
      camera ? camera[0] : 0,
      camera ? camera[1] : 0,
      body.length,
    ];

    for (const record of body) {
      values.push(spec.id, record.id);

      for (const field of spec.fields) {
        values.push(Number(record[field.name] ?? 0));
      }
    }

    // группа IndexedNoNull8 (динамика карты) — у фикстуры пуста
    values.push(0);

    this._hot = new Float32Array(values);

    return this._hot.length;
  }

  hot_ptr() {
    return 0;
  }

  hot_values() {
    return this._hot;
  }

  take_frames() {
    return '[]';
  }

  apply_input(action, name, localNow = 0) {
    const magnitude = action === 'down' ? 40 : 0;

    if (name === 'forward') {
      this._vy = -magnitude;
    } else if (name === 'back') {
      this._vy = magnitude;
    } else {
      return;
    }

    this._inputs.push({ time: localNow, vy: this._vy });
  }

  // записи расхождения предикта; 'null' — детектор выключен конфигом
  take_divergence() {
    if (!this._divergence) {
      return 'null';
    }

    const { records, ...stats } = this._divergence;

    this._divergence.records = [];

    return JSON.stringify({ ...stats, records });
  }

  // сравнение предсказанного своего актора с авторитетным player-блоком —
  // до того, как авторитетное состояние станет новой базой предикта
  _observeDivergence(frame) {
    if (!this._divergence) {
      return;
    }

    // playerId приходит в кадре хоста строкой (gameId меты) — наблюдатель
    // помечен -1 и своего актора не имеет
    const id = Number(frame.playerId);
    const authoritative = (frame.body ?? []).find(row => row.id === id);

    if (!Number.isInteger(id) || id < 0 || !authoritative) {
      return;
    }

    const time = frame.serverTime;

    if (this._base) {
      const predicted = this._predictAt(time);

      this._compare(predicted, authoritative, frame);
    }

    // реконсиляция: база — авторитетное состояние на serverTime кадра,
    // история ввода до этого момента больше не переигрывается
    const vy = this._velocityAt(time);

    this._base = { x: authoritative.x, y: authoritative.y, time, vy };
    this._inputs = this._inputs.filter(
      input => input.time + this._offset > time,
    );
  }

  _compare(predicted, authoritative, frame) {
    const dump = this._divergence;
    const cfg = this._divergenceCfg;
    const pair = [
      [predicted.x, authoritative.x],
      [predicted.y, authoritative.y],
    ];
    const delta = pair.map(([a, b]) => a - b);
    const thresholds = pair.map(
      (_, index) => cfg.thresholds?.[index] ?? cfg.defaultThreshold ?? 1,
    );
    const exceeded = delta
      .map((value, index) => (Math.abs(value) > thresholds[index] ? index : -1))
      .filter(index => index !== -1);

    dump.samples += 1;
    delta.forEach((value, index) => {
      dump.maxDelta[index] = Math.max(dump.maxDelta[index], Math.abs(value));
    });

    if (!exceeded.length) {
      return;
    }

    dump.violations += 1;

    if (dump.records.length >= (cfg.capacity ?? 64)) {
      dump.records.shift();
      dump.dropped += 1;
    }

    dump.records.push({
      source: 'state',
      serverTime: frame.serverTime,
      localNow: frame.serverTime - this._offset,
      offset: this._offset,
      inputSeq: frame.seq,
      replayed: {
        from: this._base.time,
        to: frame.serverTime,
        count: this._inputs.length,
      },
      predicted: [predicted.x, predicted.y],
      authoritative: [authoritative.x, authoritative.y],
      delta,
      exceeded,
      thresholds,
    });
  }

  // интегрирование скорости от базы до момента t (серверное время):
  // кусочно-линейно по истории ввода — предикт переигрывает именно её
  _predictAt(t) {
    let { y, time, vy } = this._base;

    for (const input of this._inputs) {
      const at = input.time + this._offset;
      const until = Math.min(at, t);

      if (until > time) {
        y += (vy * (until - time)) / 1000;
        time = until;
      }

      if (at > t) {
        return { x: this._base.x, y };
      }

      vy = input.vy;
    }

    if (t > time) {
      y += (vy * (t - time)) / 1000;
    }

    return { x: this._base.x, y };
  }

  _velocityAt(time) {
    let vy = this._base?.vy ?? 0;

    for (const input of this._inputs) {
      if (input.time + this._offset <= time) {
        vy = input.vy;
      }
    }

    return vy;
  }

  set_active(active) {
    this._active = active;
  }

  set_map() {}

  reset() {
    this._frame = null;
    this._hot = new Float32Array(0);
    this._base = null;
    this._inputs = [];
  }

  // зеркало ClientState::debug_json; у фикстуры буфер — один последний
  // кадр, поэтому окно seq вырождено
  debug_json() {
    return JSON.stringify({
      myGameId: this._frame?.playerId ?? null,
      offset: 0,
      interpolator: {
        buffered: this._frame ? 1 : 0,
        seqWindow: this._frame ? [this._frame.seq, this._frame.seq] : null,
        lastFrame: this._frame
          ? { seq: this._frame.seq, serverTime: this._frame.serverTime }
          : null,
      },
      hotLen: this._hot.length,
      framesOut: 0,
      active: this._active,
    });
  }

  decode_frame(data) {
    try {
      return JSON.stringify(JSON.parse(new TextDecoder().decode(data)));
    } catch {
      return 'null';
    }
  }
}
