// Сводка здоровья хоста за эпизод скрытой вкладки (host-migration этап
// 9a): браузер троттлит Worker скрытой вкладки (этап 0), и в журнал
// клиентских ошибок уходит, насколько просел матч, — одна запись на эпизод,
// а не на каждую секунду (журнал дедуплицирует по коду и хранит details
// только первой записи).
//
// Эпизод закрывается возвратом видимости, потерей роли хоста или
// выгрузкой страницы (flush). Следующие эпизоды той же сессии журнал
// склеивает с первым: растёт счётчик, details остаются первого — осознанно.
// Эпизод без единой метрики (матч стоял, скрытие короче окна цикла) не
// пишется. Без DOM: видимость сообщает владелец.

export const HIDDEN_HEALTH_CODE = 'engine.host.hiddenHealth';

export default class HiddenHostHealthLog {
  /**
   * @param {Object} options
   * @param {Function} options.warn - (code, summary) запись в журнал.
   * @param {boolean} [options.hidden] - вкладка скрыта в момент создания.
   * @param {Function} [options.now] - монотонные часы, мс.
   */
  constructor({ warn, hidden = false, now = () => performance.now() }) {
    this._warn = warn;
    this._now = now;
    this._episode = null;

    this.setHidden(hidden);
  }

  setHidden(hidden) {
    if (hidden && !this._episode) {
      this._episode = {
        startedAt: this._now(),
        samples: 0,
        minTickRate: Infinity,
        maxGapMs: 0,
        lostMs: 0,
      };
    } else if (!hidden) {
      this.flush();
    }
  }

  // метрика Worker'а (HostController.onHealth): в зачёт только скрытой вкладки
  add(health) {
    const episode = this._episode;

    if (!episode || !health) {
      return;
    }

    episode.samples += 1;
    episode.minTickRate = Math.min(episode.minTickRate, health.tickRate);
    episode.maxGapMs = Math.max(episode.maxGapMs, health.maxGapMs);
    episode.lostMs += health.lostMs;
  }

  // закрыть эпизод (если идёт) и записать сводку
  flush() {
    const episode = this._episode;

    this._episode = null;

    if (!episode || episode.samples === 0) {
      return;
    }

    this._warn(HIDDEN_HEALTH_CODE, {
      hiddenMs: Math.round(this._now() - episode.startedAt),
      samples: episode.samples,
      minTickRate: episode.minTickRate,
      maxGapMs: episode.maxGapMs,
      lostMs: episode.lostMs,
    });
  }
}
