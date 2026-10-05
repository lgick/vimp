import { describe, it, expect } from 'vitest';
import lobby from '../../packages/engine/src/config/lobby.js';
import master from '../../packages/engine/src/config/master.js';
import hostDefaults from '../../packages/engine/src/config/hostDefaults.js';

// Связки таймингов миграции хоста между клиентом (config/lobby.js), мастером
// (config/master.js) и Worker'ом (config/hostDefaults.js): каждая записана в
// комментариях конфигов, нарушение молча ломает смену хоста (ревью F12).

describe('связки таймингов миграции хоста', () => {
  it('handoffDeadlineMs хоста > handoffTimeoutMs мастера', () => {
    // иначе хост бросает передачу раньше, чем мастер её отменит: матч
    // размораживается, пока бета ещё регистрируется
    expect(lobby.migration.handoffDeadlineMs).toBeGreaterThan(
      master.room.handoffTimeoutMs,
    );
  });

  it('checkpointMaxAgeMs мастера >= 2 периодов standby_status', () => {
    // иначе один потерянный статус беты делает её точку «несвежей» и
    // миграция уходит в cold с потерей матча
    expect(master.room.checkpointMaxAgeMs).toBeGreaterThanOrEqual(
      2 * lobby.migration.standbyStatusIntervalMs,
    );
  });

  it('migrationWaitMs гостя покрывает бету с точкой и одного cold-кандидата', () => {
    // иначе гость уходит в быструю игру, пока мастер ещё ждёт кандидата
    // (без продления по host_migrating.waitMs от старого мастера)
    expect(lobby.session.migrationWaitMs).toBeGreaterThanOrEqual(
      master.room.promotionTimeoutMs + master.room.coldPromotionTimeoutMs,
    );
  });

  it('reconnectWindowMs гостя < resumeGraceMs хоста', () => {
    // иначе гость ещё пытается вернуться, а хост уже отдал его место
    expect(lobby.session.reconnectWindowMs).toBeLessThan(
      hostDefaults.resumeGraceMs,
    );
  });

  it('maxRestoreAgeMs беты >= checkpointMaxAgeMs мастера', () => {
    // иначе мастер выбирает бету с точкой, которую она сама откажется
    // восстанавливать
    expect(lobby.migration.maxRestoreAgeMs).toBeGreaterThanOrEqual(
      master.room.checkpointMaxAgeMs,
    );
  });

  it('resumeSilenceGraceMs гостя >= resumeWaitMs восстановленного матча', () => {
    // иначе сторожок тишины рвёт транспорт гостя, вернувшегося первым, пока
    // новый хост ждёт остальных
    expect(lobby.session.resumeSilenceGraceMs).toBeGreaterThanOrEqual(
      hostDefaults.resumeWaitMs,
    );
  });

  it('linkWaitMaxMs ожидания по ссылке покрывает migrationWaitMs', () => {
    // иначе вход по ссылке сдаётся раньше гостя, уже сидящего в комнате
    expect(lobby.session.linkWaitMaxMs).toBeGreaterThanOrEqual(
      lobby.session.migrationWaitMs,
    );
  });

  it('peersReportGraceMs голосования > периода room_peers хоста', () => {
    // после смены хоста голосование ждёт первого room_peers нового хоста;
    // потерянный первый отчёт повторится внутри окна, а не после него
    expect(master.room.vote.peersReportGraceMs).toBeGreaterThan(
      lobby.migration.peersReportIntervalMs,
    );
  });

  it('joinRetryWindowMs гостя покрывает бэкофф сигналинга хоста', () => {
    // после рестарта мастера комнату возвращает только reclaim_host
    // хоста, а его сигналинг переподключается не позже reconnect.maxDelay;
    // запас — на подключение и проверку токена
    expect(lobby.session.joinRetryWindowMs).toBeGreaterThanOrEqual(
      lobby.reconnect.maxDelay + 10000,
    );
  });
});
