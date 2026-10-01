import AbstractTimer from '../../../lib/AbstractTimer.js';
import clock from '../../../lib/clock.js';

// окно метрик здоровья цикла (host-migration этап 9a): раз в столько мс
// цикл отдаёт onLoopStats — хост решает по ним, не пора ли отдать роль
const LOOP_STATS_WINDOW_MS = 1000;

// Singleton TimerManager

let timerManager;

class TimerManager extends AbstractTimer {
  constructor(timers, callbacks) {
    super();

    if (timerManager) {
      return timerManager;
    }

    timerManager = this;

    this._mapTime = timers.mapTime;
    this._roundTime = timers.roundTime;
    this._timeStep = timers.timeStep;
    this._voteTime = timers.voteTime;
    this._timeBlockedVote = timers.timeBlockedVote;
    this._teamChangeGracePeriod = timers.teamChangeGracePeriod;
    this._roundRestartDelay = timers.roundRestartDelay;
    this._mapChangeDelay = timers.mapChangeDelay;
    this._idleCheckInterval = timers.idleCheckInterval;
    this._rttPingInterval = timers.rttPingInterval;

    this._callbacks = callbacks;

    // временные метки для расчетов оставшегося времени
    this._startMapTime = 0;
    this._startRoundTime = 0;

    // фактическая длительность текущего таймера карты (после эстафеты
    // Worker'ов карта продолжается с остатком времени, а не заново)
    this._currentMapDuration = this._mapTime;

    // переменные для самокорректирующегося игрового цикла
    this._lastShotTime = 0;
    this._expectedTickTime = 0;

    // максимально допустимая дельта времени в секундах,
    // для предотвращения "прыжков" в симуляции после долгих пауз
    this._maxDeltaTime = 0.1;

    // окно метрик цикла: живёт только пока цикл крутится — на паузе метрик
    // нет (иначе заморозка выглядела бы перегрузкой)
    this._loopStats = null;

    // заморозка (host-migration этап 5): момент паузы — пока он задан,
    // остатки карты/раунда не убывают
    this._pausedAt = null;

    // цель отложенной смены карты: колбэк — замыкание, а контрольной точке
    // нужна декларация (её колбэк строится заново при восстановлении)
    this._pendingMapChange = null;
  }

  // «сейчас» для остатков: на паузе время карты и раунда стоит
  _now() {
    return this._pausedAt ?? clock.now();
  }

  // запускает все основные игровые таймеры (карта, игровой цикл, раунд)
  startGameTimers() {
    this.startMapTimer();
    this._startGameLoop();
    this.startRoundTimer();
    this._startRttPingTimer();
  }

  // останавливает все основные игровые таймеры
  stopGameTimers() {
    this._stopGameLoop();
    this.stopRoundTimer();
    this.stopMapTimer();
    this._stopRoundRestartDelay();
    this._stopMapChangeDelay();
    this._stopRttPingTimer();
  }

  // запускает таймер до конца текущей карты (duration — остаток времени
  // при возобновлении после эстафеты Worker'ов, Этап 5.2)
  startMapTimer(duration = this._mapTime) {
    this.stopMapTimer();
    this._startMapTime = clock.now();
    this._currentMapDuration = duration;
    this._startTimer('map', this._callbacks.onMapTimeEnd, duration);
  }

  // останавливает таймер карты
  stopMapTimer() {
    this._stopTimer('map');
  }

  // возвращает оставшееся время до конца карты в миллисекундах
  getMapTimeLeft() {
    const timeLeft =
      this._currentMapDuration - (this._now() - this._startMapTime);

    return Math.max(0, timeLeft);
  }

  // возобновляет игровые таймеры после эстафеты Worker'ов (Этап 5.2):
  // карта — с остатком времени, раунд стартует отдельно (initiateNewRound)
  resumeGameTimers(mapTimeLeft) {
    this.startMapTimer(mapTimeLeft ?? this._mapTime);
    this._startGameLoop();
    this._startRttPingTimer();
  }

  // запускает таймер до конца текущего раунда. duration — остаток при
  // восстановлении из контрольной точки: старт раунда тогда «виртуальный»
  // (в прошлом), чтобы прошедшее время раунда и грейс смены команды
  // считались от настоящего начала
  startRoundTimer(duration = this._roundTime) {
    this.stopRoundTimer();
    this._startRoundTime = clock.now() - (this._roundTime - duration);
    this._startTimer('round', this._callbacks.onRoundTimeEnd, duration);
  }

  // останавливает таймер раунда
  stopRoundTimer() {
    this._stopTimer('round');
  }

  // возвращает оставшееся время до конца раунда в секундах
  getRoundTimeLeft() {
    return Math.floor(this.getRoundTimeLeftMs() / 1000);
  }

  // то же в миллисекундах (контрольная точка не теряет долей секунды)
  getRoundTimeLeftMs() {
    return Math.max(0, this._roundTime - (this._now() - this._startRoundTime));
  }

  // проверяет возможно сменить команду игроку в текущем раунде
  canChangeTeamInCurrentRound() {
    const roundTime = this._now() - this._startRoundTime;

    return roundTime <= this._teamChangeGracePeriod;
  }

  // логика одного "тика" игрового цикла
  _loopTick() {
    const now = clock.monotonic();
    let dt = (now - this._lastShotTime) / 1000;
    this._lastShotTime = now;

    this._countLoopTick(dt);

    // если dt аномально большой (система "спала"), ограничить его
    // и сбросить ожидаемое время, чтобы цикл не пытался "наверстать".
    if (dt > this._maxDeltaTime) {
      dt = this._maxDeltaTime;
      this._expectedTickTime = now; // сброс базы для расчета дрейфа
    }

    this._callbacks.onShotTick(dt);
    this._flushLoopStats(now);

    const drift = now - this._expectedTickTime;
    const nextTimeout = Math.max(0, this._timeStep - drift);
    this._expectedTickTime += this._timeStep;

    // регистрация следующего шага цикла через _startTimer,
    // чтобы его можно было остановить по ключу 'gameLoop'
    this._startTimer('gameLoop', () => this._loopTick(), nextTimeout);
  }

  // итерация цикла в окно метрик: срезанное капом dt — время, которое
  // симуляция не прожила (отстаёт от реального)
  _countLoopTick(dt) {
    const stats = this._loopStats;

    stats.ticks += 1;
    stats.maxGapMs = Math.max(stats.maxGapMs, dt * 1000);

    if (dt > this._maxDeltaTime) {
      stats.lostMs += (dt - this._maxDeltaTime) * 1000;
    }
  }

  // окно метрик закрыто — отдать и начать новое
  _flushLoopStats(now) {
    const stats = this._loopStats;
    const windowMs = now - stats.startedAt;

    if (windowMs < LOOP_STATS_WINDOW_MS) {
      return;
    }

    this._loopStats = this._newLoopStats(now);
    this._callbacks.onLoopStats?.({
      tickRate: Math.round((stats.ticks * 10000) / windowMs) / 10,
      maxGapMs: Math.round(stats.maxGapMs),
      lostMs: Math.round(stats.lostMs),
      windowMs: Math.round(windowMs),
    });
  }

  _newLoopStats(now) {
    return { startedAt: now, ticks: 0, maxGapMs: 0, lostMs: 0 };
  }

  // инициализирует и запускает игровой цикл (обновление кадров)
  _startGameLoop() {
    this._stopGameLoop();

    this._lastShotTime = clock.monotonic();
    this._loopStats = this._newLoopStats(this._lastShotTime);
    this._expectedTickTime = this._lastShotTime + this._timeStep;

    // запуск первого таймаута, который инициирует цикл
    this._startTimer('gameLoop', () => this._loopTick(), this._timeStep);
  }

  // останавливает игровой цикл
  _stopGameLoop() {
    this._stopTimer('gameLoop');
  }

  // запускает таймер голосования
  startVoteTimer(voteName, onEndCallback) {
    this._startTimer(`vote:${voteName}`, onEndCallback, this._voteTime);
  }

  // останавливает все активные таймеры голосования
  stopAllVoteTimers() {
    for (const key of this._timers.keys()) {
      if (key.startsWith('vote:')) {
        this._stopTimer(key);
      }
    }
  }

  // запускает таймер, блокирующий возможность инициировать
  // новое голосование в заданной категории (duration — остаток кулдауна
  // из контрольной точки)
  startVoteBlockTimer(
    voteCategory,
    onEndCallback,
    duration = this._timeBlockedVote,
  ) {
    this._startTimer(`voteBlock:${voteCategory}`, onEndCallback, duration);
  }

  // кулдауны голосований с остатками: [{ name, leftMs }]
  getVoteCooldowns() {
    return [...this._timers.keys()]
      .filter(key => key.startsWith('voteBlock:'))
      .map(key => ({
        name: key.slice('voteBlock:'.length),
        leftMs: this._timeLeft(key),
      }));
  }

  // останавливает все таймеры блокировки
  stopAllBlockedVoteTimers() {
    for (const key of this._timers.keys()) {
      if (key.startsWith('voteBlock:')) {
        this._stopTimer(key);
      }
    }
  }

  // проверяет наличие блокирующего таймера
  isVoteBlocked(voteCategory) {
    return this._hasTimer(`voteBlock:${voteCategory}`);
  }

  // запускает отложенный перезапуск раунда
  startRoundRestartDelay() {
    this._startTimer(
      'roundRestartDelay',
      this._callbacks.onRoundTimeEnd,
      this._roundRestartDelay,
    );
  }

  // останавливает отложенный перезапуск раунда
  _stopRoundRestartDelay() {
    this._stopTimer('roundRestartDelay');
  }

  // запускает отложенную смену карты (после голосования). targetMap —
  // декларация цели для контрольной точки; duration — остаток при
  // восстановлении
  startMapChangeDelay(
    onEndCallback,
    { targetMap = null, duration = this._mapChangeDelay } = {},
  ) {
    this._pendingMapChange = targetMap;
    this._startTimer('mapChangeDelay', onEndCallback, duration);
  }

  // останавливает отложенную смену карты
  _stopMapChangeDelay() {
    this._stopTimer('mapChangeDelay');
  }

  // ***** контрольная точка (host-migration этап 5) ***** //

  /**
   * Остатки по всем дедлайнам. Активные голосования (vote:*) не
   * переносятся: их resultFunc — замыкания.
   * @returns {Object} { mapTimeLeft, roundTimeLeft, roundElapsed,
   *   teamChangeGraceLeft, pending, voteCooldowns }. mapTimeLeft считается
   *   и у остановленного таймера (эстафета снимает таймеры до сбора меты);
   *   roundTimeLeft null — раунд не идёт (завершается).
   */
  serialize() {
    const roundElapsed = Math.max(0, this._now() - this._startRoundTime);
    const pending = [];

    if (this._hasTimer('roundRestartDelay')) {
      pending.push({
        kind: 'roundRestart',
        leftMs: this._timeLeft('roundRestartDelay'),
      });
    }

    if (this._hasTimer('mapChangeDelay') && this._pendingMapChange !== null) {
      pending.push({
        kind: 'mapChange',
        leftMs: this._timeLeft('mapChangeDelay'),
        targetMap: this._pendingMapChange,
      });
    }

    return {
      mapTimeLeft: this.getMapTimeLeft(),
      roundTimeLeft: this._hasTimer('round') ? this.getRoundTimeLeftMs() : null,
      roundElapsed,
      teamChangeGraceLeft: Math.max(
        0,
        this._teamChangeGracePeriod - roundElapsed,
      ),
      pending,
      voteCooldowns: this.getVoteCooldowns(),
    };
  }

  /**
   * Запускает игровые таймеры с остатками из serialize(): карта, раунд,
   * цикл, пинги, отложенный перезапуск раунда, кулдауны голосований.
   * Отложенную смену карты (pending mapChange) поднимает RoundManager —
   * колбэк его.
   * @param {Object} state - результат serialize().
   */
  resumeFromState(state) {
    this.startMapTimer(state.mapTimeLeft ?? this._mapTime);

    if (state.roundTimeLeft !== null && state.roundTimeLeft !== undefined) {
      this.startRoundTimer(state.roundTimeLeft);
    } else {
      // раунд завершается (таймер снят) — прошедшее время всё равно нужно
      // грейсу смены команды
      this._startRoundTime = clock.now() - (state.roundElapsed ?? 0);
    }

    for (const item of state.pending ?? []) {
      if (item.kind === 'roundRestart') {
        this._startTimer(
          'roundRestartDelay',
          this._callbacks.onRoundTimeEnd,
          item.leftMs,
        );
      }
    }

    for (const { name, leftMs } of state.voteCooldowns ?? []) {
      this.startVoteBlockTimer(name, () => {}, leftMs);
    }

    this._startGameLoop();
    this._startRttPingTimer();
  }

  get isPaused() {
    return this._pausedAt !== null;
  }

  // заморозка: все отсчёты (цикл, карта, раунд, отложенные вызовы,
  // голосования, пинги, проверка бездействия) встают с остатками
  pause() {
    if (this._pausedAt !== null) {
      return;
    }

    this._pausedAt = clock.now();
    this._pauseTimers();
  }

  // разморозка: остатки дотикивают, цикл стартует заново (без «прыжка» dt)
  resume() {
    if (this._pausedAt === null) {
      return;
    }

    const pausedFor = clock.now() - this._pausedAt;

    this._pausedAt = null;
    this._startMapTime += pausedFor;
    this._startRoundTime += pausedFor;

    const loopPaused = this._timeLeft('gameLoop') !== null;

    this._resumeTimers(key => key !== 'gameLoop');

    if (loopPaused) {
      this._startGameLoop();
    }
  }

  // логика одного "тика" для проверки на бездействие
  _idleCheckTick() {
    this._callbacks.onIdleCheck();

    // перезапуск таймера для следующей проверки
    this._startTimer(
      'idleCheck',
      () => this._idleCheckTick(),
      this._idleCheckInterval,
    );
  }

  // запускает периодическую проверку на бездействие
  startIdleCheckTimer() {
    // если есть интервал и callback
    if (this._idleCheckInterval && this._callbacks.onIdleCheck) {
      this.stopIdleCheckTimer();
      this._idleCheckTick();
    }
  }

  // останавливает проверку на бездействие (публичный: пауза эстафеты
  // Worker'ов не должна кикать за бездействие)
  stopIdleCheckTimer() {
    this._stopTimer('idleCheck');
  }

  // логика одного "тика" для отправки пингов
  _rttPingTick() {
    this._callbacks.onSendPing();

    // перезапуск таймера для следующего пинга
    this._startTimer(
      'rttPing',
      () => this._rttPingTick(),
      this._rttPingInterval,
    );
  }

  // запускает отправку пингов
  _startRttPingTimer() {
    // если есть интервал и callback
    if (this._rttPingInterval && this._callbacks.onSendPing) {
      this._stopRttPingTimer();
      this._rttPingTick();
    }
  }

  // останавливает отправку пингов
  _stopRttPingTimer() {
    this._stopTimer('rttPing');
  }
}

// Сброс синглтона. Нужен только тем, кто крутит больше одного матча в
// процессе — headless-runner (devtools/resetHostSingletons.js) и тесты;
// в браузерной вкладке матч всегда один, поэтому прод его не зовёт.
export const resetTimerManager = () => {
  timerManager = null;
};

export default TimerManager;
