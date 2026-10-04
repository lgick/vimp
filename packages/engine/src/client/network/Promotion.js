import { decodeCheckpoint } from '../../lib/checkpointCodec.js';
import { sanitizeRoomSettings } from '../../lib/roomSettings.js';
import HostController from './HostController.js';
import { isConfirmedGame } from './HostPrewarm.js';

// Преемник становится хостом (host-migration этап 7.4). Режим checkpoint:
// матч поднимается из последней контрольной точки беты — в прогретом
// Worker'е (HostPrewarm, этап 6), если он той же версии игры, иначе в новом.
// Готовность Worker'а (матч на паузе) — onReady: дальше владелец
// (client/session/PromotionFlow.js) берёт на себя роль хоста — register_host с
// promotionToken, приём офферов, возобновление своего игрока. Режим planned
// (плановая передача, этап 8) — то же, но сначала ждём финальную точку
// замороженного хоста (продолжение с того же тика); не дождались за
// finalWaitMs или мастер повторил promote режимом checkpoint (хост пропал
// посреди передачи) — берём последнюю периодическую. Режим cold
// (точки нет) обходится без этого класса: отложенный промоушен в
// sessionStorage и перезагрузка в комнату (savePendingPromotion ниже).
//
// Без DOM и сигналинга: всё внешнее инъектируется.

// ключ отложенного холодного промоушена в sessionStorage
export const PROMOTION_STORAGE_KEY = 'vimp.promotion';

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

// promote мастера: годен ли для промоушена этой вкладкой
function isPromotion(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.roomId === 'string' &&
    value.roomId !== '' &&
    Number.isInteger(value.epoch) &&
    value.epoch > 0 &&
    typeof value.promotionToken === 'string' &&
    TOKEN_PATTERN.test(value.promotionToken)
  );
}

/**
 * Сохраняет холодный промоушен перед перезагрузкой страницы в комнату.
 * @param {Storage|null} storage - sessionStorage.
 * @param {Object} promote - { roomId, epoch, promotionToken, settings }.
 * @param {string} gameId
 * @returns {boolean} false — сохранить не удалось (хранилище недоступно).
 */
export function savePendingPromotion(storage, promote, gameId) {
  if (!storage || !isPromotion(promote) || typeof gameId !== 'string') {
    return false;
  }

  try {
    storage.setItem(
      PROMOTION_STORAGE_KEY,
      JSON.stringify({
        roomId: promote.roomId,
        epoch: promote.epoch,
        promotionToken: promote.promotionToken,
        gameId,
        settings:
          promote.settings && typeof promote.settings === 'object'
            ? promote.settings
            : {},
      }),
    );

    return true;
  } catch {
    return false;
  }
}

/**
 * Забирает отложенный промоушен: запись удаляется при любом исходе —
 * повторная перезагрузка не должна снова занимать комнату.
 * @param {Storage|null} storage - sessionStorage.
 * @returns {Object|null} { roomId, epoch, promotionToken, gameId, settings }.
 */
export function takePendingPromotion(storage) {
  if (!storage) {
    return null;
  }

  let raw = null;

  try {
    raw = storage.getItem(PROMOTION_STORAGE_KEY);
    storage.removeItem(PROMOTION_STORAGE_KEY);
  } catch {
    return null;
  }

  if (!raw) {
    return null;
  }

  let value;

  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isPromotion(value) || typeof value.gameId !== 'string') {
    return null;
  }

  return {
    roomId: value.roomId,
    epoch: value.epoch,
    promotionToken: value.promotionToken,
    gameId: value.gameId,
    settings:
      value.settings && typeof value.settings === 'object'
        ? value.settings
        : {},
  };
}

export default class Promotion {
  /**
   * @param {Object} options
   * @param {Object} options.promote - promote мастера { roomId, epoch,
   *   promotionToken, mode: 'checkpoint' | 'planned', reason }.
   * @param {Object} options.receiver - StandbyReceiver (latest(),
   *   waitForFinal(), lastSeenSeq).
   * @param {number} [options.finalWaitMs] - ожидание финальной точки
   *   (mode planned).
   * @param {number} [options.maxRestoreAgeMs] - точка, полученная раньше,
   *   не поднимается: откат на столько — хуже холодного старта.
   * @param {Function} [options.now] - часы (мс, как receivedAt приёмника).
   * @param {Object|null} [options.prewarm] - HostPrewarm (take()).
   * @param {Function} options.prepareRoom - (settings, gameRef) →
   *   Promise<{ room, workerUrl, mapsVersion, codeVersion }>.
   * @param {string} options.hostSocketId - socketId своего игрока в Worker'е.
   * @param {Function} [options.createController] - (room, opts) →
   *   HostController (тесты).
   * @param {Function} [options.decode] - распаковка точки (тесты).
   * @param {Object} [options.diagnostics]
   * @param {Object} [options.hostCallbacks] - { onLobbyInfoChange,
   *   onMapChange } — колбэки Worker'а, которые живут дольше промоушена.
   * @param {Function} [options.hasSession] - () → есть ли у своего игрока
   *   секрет места: без него он не вернётся в поднятый матч, а комнату
   *   хостила бы вкладка без игрока — промоушен отклоняется сразу.
   * @param {Function} [options.holdSession] - плановая передача: поставить
   *   сессию своего игрока на паузу, не закрывая транспорт к замороженному
   *   хосту — по нему идёт финальная точка.
   * @param {Function} options.onReady - ({ controller, room, prepared,
   *   lobbyInfo }) матч поднят на паузе.
   * @param {Function} options.onFailed - (error) поднять не удалось.
   */
  constructor({
    promote,
    receiver,
    finalWaitMs = 3000,
    maxRestoreAgeMs = 15000,
    now = () => Date.now(),
    prewarm = null,
    prepareRoom,
    hostSocketId,
    createController = (room, opts) => new HostController(room, opts),
    decode = decodeCheckpoint,
    diagnostics = null,
    hostCallbacks = {},
    hasSession = () => true,
    holdSession = () => {},
    onReady,
    onFailed,
  }) {
    this._promote = promote;
    this._receiver = receiver;
    this._finalWaitMs = finalWaitMs;
    this._maxRestoreAgeMs = maxRestoreAgeMs;
    this._now = now;
    this._prewarm = prewarm;
    this._prepareRoom = prepareRoom;
    this._hostSocketId = hostSocketId;
    this._createController = createController;
    this._decode = decode;
    this._diagnostics = diagnostics;
    this._hostCallbacks = hostCallbacks;
    this._hasSession = hasSession;
    this._holdSession = holdSession;
    this._onReady = onReady;
    this._onFailed = onFailed;

    // 'idle' | 'starting' | 'ready' | 'failed' | 'cancelled'
    this._state = 'idle';
    this._controller = null;
    // прервать ожидание финальной точки (mode planned)
    this._skipFinalWait = null;
  }

  get state() {
    return this._state;
  }

  // { roomId, epoch, promotionToken } — для register_host и promote_failed
  get promotion() {
    const { roomId, epoch, promotionToken } = this._promote;

    return { roomId, epoch, promotionToken };
  }

  /**
   * Поднимает матч из последней точки. Результат — onReady/onFailed.
   * @returns {Promise<void>}
   */
  async start() {
    if (this._state !== 'idle') {
      return;
    }

    this._state = 'starting';

    // сама, не дожидаясь host_migrating: его порядок относительно promote
    // и наличие зависят от версии мастера
    if (this._promote.mode === 'planned') {
      this._holdSession();
    }

    try {
      await this._start();
    } catch (e) {
      this._fail(e);
    }
  }

  /**
   * Повторный promote той же эпохи и токена режимом checkpoint: хост пропал
   * посреди плановой передачи, финальной точки не будет.
   * @param {Object} promote
   * @returns {boolean} true — это повтор нашего промоушена.
   */
  degrade(promote) {
    if (
      promote?.roomId !== this._promote.roomId ||
      promote?.epoch !== this._promote.epoch ||
      promote?.promotionToken !== this._promote.promotionToken
    ) {
      return false;
    }

    this._skipFinalWait?.();

    return true;
  }

  /**
   * promote_cancelled или уход из комнаты: поднятый Worker гасится, ответы
   * опоздавших колбэков игнорируются.
   */
  cancel() {
    if (this._state === 'starting') {
      this._controller?.destroy();
      this._controller = null;
    }

    if (this._state !== 'failed') {
      this._state = 'cancelled';
    }

    this._skipFinalWait?.();
  }

  // точка, из которой поднимается матч: финальная (planned) или последняя
  // периодическая
  async _pickCheckpoint() {
    const receiver = this._receiver;

    if (this._promote.mode !== 'planned' || !receiver?.waitForFinal) {
      return receiver?.latest() ?? null;
    }

    let final = null;

    try {
      final = await new Promise((resolve, reject) => {
        this._skipFinalWait = () => resolve(null);
        receiver.waitForFinal(0, this._finalWaitMs).then(resolve, reject);
      });
    } catch {
      final = null; // не дождались — откат к периодической минимален
    } finally {
      this._skipFinalWait = null;
    }

    return final ?? receiver.latest() ?? null;
  }

  async _start() {
    if (!isPromotion(this._promote)) {
      throw new Error('invalid promote message');
    }

    if (!this._hasSession()) {
      throw new Error('no session to resume the own player with');
    }

    const latest = await this._pickCheckpoint();

    if (this._state !== 'starting') {
      return; // отменили, пока ждали финальную точку
    }

    if (!latest) {
      throw new Error('no checkpoint to restore from');
    }

    // поток точек мог встать задолго до падения хоста (ревью F8): отказ —
    // promote_failed, мастер переходит к холодному старту. Финальная точка
    // плановой передачи свежая всегда
    if (this._now() - latest.receivedAt > this._maxRestoreAgeMs) {
      throw new Error('checkpoint is too old to restore from');
    }

    // копия: буфер уходит в Worker списком переноса, а точка приёмника
    // должна остаться целой (повторная попытка, отладка)
    const bytes = latest.bytes.slice();
    const { meta } = await this._decode(latest.bytes);
    const gameRef = meta?.room?.game ?? null;

    if (!gameRef?.id || !gameRef.version) {
      throw new Error('checkpoint has no room.game');
    }

    // игру и её версию подтверждает мастер: точка от хоста — недоверенная
    if (!isConfirmedGame(gameRef, this._promote.game ?? null)) {
      throw new Error('checkpoint game is not the room game');
    }

    if (this._state !== 'starting') {
      return; // отменили, пока распаковывали
    }

    const settings = sanitizeRoomSettings(meta.room?.settings);
    const seqFloor = Math.max(this._receiver.lastSeenSeq ?? 0, latest.seq ?? 0);

    // прогретый Worker годится только той же версии игры, что в точке
    const warm = this._prewarm?.take() ?? null;
    const warmMatches =
      warm &&
      warm.prepared?.gameRef?.id === gameRef.id &&
      warm.prepared?.gameRef?.version === gameRef.version;

    if (warm && !warmMatches) {
      warm.controller.destroy();
    }

    // копия: prepareHostRoom мутирует аргумент (isDevMode, game, maps)
    const prepared = warmMatches
      ? warm.prepared
      : await this._prepareRoom({ ...settings }, gameRef);

    if (this._state !== 'starting') {
      if (warmMatches) {
        warm.controller.destroy();
      }

      return;
    }

    // точка недоверенная: из неё — только настройки комнаты, а игра, карты
    // и dev-режим — свои (prepared.room)
    const room = {
      ...prepared.room,
      ...settings,
      hostSocketId: this._hostSocketId,
      roomId: this._promote.roomId,
      epoch: this._promote.epoch,
    };

    const callbacks = {
      seqFloor,
      onReady: msg => this._ready(room, prepared, msg),
      onError: msg =>
        this._fail(new Error(msg?.message || 'worker init failed')),
      onLobbyInfoChange: info => this._hostCallbacks.onLobbyInfoChange?.(info),
      onMapChange: mapName => this._hostCallbacks.onMapChange?.(mapName),
    };

    if (warmMatches) {
      this._controller = warm.controller;
      this._controller.initFromCheckpoint(room, bytes, callbacks);
    } else {
      this._controller = this._createController(room, {
        workerUrl: prepared.workerUrl ?? undefined,
        diagnostics: this._diagnostics ?? undefined,
        checkpoint: bytes,
        ...callbacks,
      });
    }
  }

  _ready(room, prepared, msg) {
    if (this._state !== 'starting') {
      return;
    }

    this._state = 'ready';
    this._onReady({
      controller: this._controller,
      room,
      prepared,
      lobbyInfo: msg?.lobbyInfo ?? null,
    });
  }

  _fail(error) {
    if (this._state !== 'starting') {
      return;
    }

    this._state = 'failed';
    this._controller?.destroy();
    this._controller = null;
    this._onFailed(error);
  }
}
