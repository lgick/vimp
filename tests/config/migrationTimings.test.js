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
});
