import { describe, it, expect } from 'vitest';
import {
  CHANGE_HOST_VOTE,
  answerValue,
  changeHostTitle,
  parseChangeHost,
  rejectionMessageKey,
  resultMessage,
} from '../../../packages/engine/src/client/lib/hostVoteCommand.js';

// Голосование «Change host» (host-migration этап 10): /changehost
// перехватывается только в лобби-режиме — там голоса считает мастер

describe('parseChangeHost', () => {
  it('в лобби /changehost перехватывается', () => {
    expect(parseChangeHost('/changehost', 'lobby')).toBe('start');
    expect(parseChangeHost('  /changehost  ', 'lobby')).toBe('start');
  });

  it('с аргументами — подсказка, хосту всё равно не уходит', () => {
    expect(parseChangeHost('/changehost now', 'lobby')).toBe('usage');
  });

  it('в solo и dedicated не перехватывается', () => {
    for (const mode of ['solo', 'dedicated']) {
      expect(parseChangeHost('/changehost', mode)).toBe(null);
    }
  });

  it('другие сообщения и команды не трогает', () => {
    for (const text of ['hello', '/changehosts', '/like', 'x /changehost']) {
      expect(parseChangeHost(text, 'lobby')).toBe(null);
    }
  });
});

describe('окно и ответы', () => {
  it('имя голосования — с зарезервированным префиксом @', () => {
    expect(CHANGE_HOST_VOTE.startsWith('@')).toBe(true);
  });

  it('заголовок называет инициатора', () => {
    expect(changeHostTitle('user3')).toBe('Change host? (started by user3)');
    expect(changeHostTitle(null)).toBe('Change host?');
  });

  it('ответ окна → значение host_vote_answer', () => {
    expect(answerValue('Yes')).toBe('yes');
    expect(answerValue('No')).toBe('no');
    expect(answerValue('maybe')).toBe(null);
  });
});

describe('сообщения чата', () => {
  it('отказы мастера → коды', () => {
    expect(rejectionMessageKey({ code: 'noSuccessor' })).toBe(
      'HOST_VOTE_NO_SUCCESSOR',
    );
    expect(
      rejectionMessageKey({ code: 'voteRejected', reason: 'roomCooldown' }),
    ).toBe('HOST_VOTE_RECENT');
    expect(
      rejectionMessageKey({ code: 'voteRejected', reason: 'userCooldown' }),
    ).toBe('HOST_VOTE_RECENT');
    expect(rejectionMessageKey({ code: 'voteRejected', reason: 'host' })).toBe(
      'HOST_VOTE_IS_HOST',
    );
    expect(
      rejectionMessageKey({ code: 'voteRejected', reason: 'active' }),
    ).toBe('HOST_VOTE_ACTIVE');
    expect(
      rejectionMessageKey({ code: 'voteRejected', reason: 'migrating' }),
    ).toBe('HOST_VOTE_UNAVAILABLE');
    // фантом без пира к хосту: отдельного текста у игр нет
    expect(
      rejectionMessageKey({ code: 'voteRejected', reason: 'notConnected' }),
    ).toBe('HOST_VOTE_UNAVAILABLE');
    expect(rejectionMessageKey({ code: 'unknownRoom' })).toBe(null);
  });

  it('итог: прошло / не прошло со счётом, отмена', () => {
    expect(resultMessage({ passed: true, yes: 3, eligibleCount: 4 })).toEqual({
      key: 'HOST_VOTE_PASSED',
      params: ['3', '4'],
    });
    expect(resultMessage({ passed: false, yes: 1, eligibleCount: 3 })).toEqual({
      key: 'HOST_VOTE_FAILED',
      params: ['1', '3'],
    });
    expect(resultMessage({ passed: false, cancelled: true, yes: 1 })).toEqual({
      key: 'HOST_VOTE_CANCELLED',
      params: [],
    });
  });
});
