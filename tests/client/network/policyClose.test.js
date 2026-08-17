import { describe, it, expect } from 'vitest';
import {
  POLICY_CLOSE_INFORMS,
  shouldReloadAfterClose,
} from '../../../packages/engine/src/client/network/policyClose.js';

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
});

describe('POLICY_CLOSE_INFORMS', () => {
  it('текст есть у кодов, причину которых сервер не присылает', () => {
    for (const code of [4001, 4008, 4009]) {
      expect(POLICY_CLOSE_INFORMS[code], String(code)).toBeTruthy();
    }
  });

  it('у 4006 текста нет: причину приносит TECH_INFORM перед закрытием', () => {
    // иначе движковый текст затёр бы пришедшее с сервера «room is full»
    expect(POLICY_CLOSE_INFORMS[4006]).toBeUndefined();
  });

  it('каждому тексту соответствует запрет перезагрузки', () => {
    for (const code of Object.keys(POLICY_CLOSE_INFORMS)) {
      expect(shouldReloadAfterClose(Number(code)), code).toBe(false);
    }
  });
});
