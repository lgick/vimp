import { describe, it, expect } from 'vitest';
import {
  POLICY_CLOSE_INFORMS,
  shouldReloadAfterClose,
} from '../../../packages/engine/src/client/network/policyClose.js';
import closeCodes from '../../../packages/engine/src/config/closeCodes.js';

// review-4.md (R4-2): перезагрузка после разрыва — правильное поведение для
// обычного обрыва и вредное для отказа по политике. Раньше эти два вопроса
// решала одна карта сообщений, и коды без текста (4001, 4006) проваливались
// в перезагрузку: origin страницы reload не меняет, а слот в полной комнате
// не освобождает — зато 30 витков выбирают лимит подключений dedicated.

describe('shouldReloadAfterClose', () => {
  it('обычный разрыв перезагрузку разрешает', () => {
    // 1006 — аварийное закрытие браузером, 1000/1001 — штатные
    for (const code of [undefined, 1000, 1001, 1006, 4000, 4002]) {
      expect(shouldReloadAfterClose(code), String(code)).toBe(true);
    }
  });

  it('политические отказы dedicated перезагрузку запрещают', () => {
    // 4001 invalidOrigin, 4006 roomFull, 4008 handshakeTimeout,
    // 4009 tooManyConnections
    for (const code of [4001, 4006, 4008, 4009]) {
      expect(shouldReloadAfterClose(code), String(code)).toBe(false);
    }
  });

  // новый код закрытия обязан быть осознанно отнесён к одной из двух групп:
  // иначе он молча попадёт в «перезагружаемся», как когда-то 4001 и 4006
  // (review-5.md, R5-1)
  it('каждый код из config/closeCodes.js классифицирован', () => {
    const decided = new Set([
      // перезагрузка уместна: обрыв, кик, протухший хост
      closeCodes.staleHost,
      closeCodes.blocked,
      closeCodes.kickForMaxLatency,
      closeCodes.kickForMissedPings,
      closeCodes.kickIdle,
      // перезагрузка бессмысленна
      closeCodes.invalidOrigin,
      closeCodes.roomFull,
      closeCodes.handshakeTimeout,
      closeCodes.tooManyConnections,
    ]);

    expect(new Set(Object.values(closeCodes))).toEqual(decided);
  });
});

describe('POLICY_CLOSE_INFORMS', () => {
  // тексты запасные: handleDisconnect пишет их только тогда, когда сервер
  // причину не прислал сам (terminalInformShown), поэтому они нужны всем
  // кодам запрета — иначе на потерянном TECH_INFORM игрок увидит «матч
  // окончен» вместо настоящей причины (review-5.md, R5-2)
  it('запасной текст есть у каждого кода запрета перезагрузки', () => {
    for (const code of [4001, 4006, 4008, 4009]) {
      expect(POLICY_CLOSE_INFORMS[code], String(code)).toBeTruthy();
    }
  });

  it('каждому тексту соответствует запрет перезагрузки', () => {
    for (const code of Object.keys(POLICY_CLOSE_INFORMS)) {
      expect(shouldReloadAfterClose(Number(code)), code).toBe(false);
    }
  });
});
