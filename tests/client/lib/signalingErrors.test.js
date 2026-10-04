import { describe, it, expect } from 'vitest';
import {
  decideInvalidToken,
  decideUnknownRoom,
} from '../../../packages/engine/src/client/lib/signalingErrors.js';

const decide = (msg, ctx = {}) =>
  decideUnknownRoom({
    msg: { code: 'unknownRoom', ...msg },
    currentRoomId: 'r1',
    promoting: false,
    sessionState: 'connecting',
    offerPending: true,
    memberJoined: true,
    isHost: false,
    ...ctx,
  });

describe('decideUnknownRoom', () => {
  it('ошибка про другую комнату — ignore', () => {
    expect(decide({ re: 'webrtc_offer', roomId: 'r2' })).toBe('ignore');
    expect(
      decide({ re: 'register_host', roomId: 'r2' }, { promoting: true }),
    ).toBe('ignore');
  });

  it('промоушен: ответ на register_host или без re — abandonPromotion', () => {
    expect(
      decide({ re: 'register_host', roomId: 'r1' }, { promoting: true }),
    ).toBe('abandonPromotion');
    expect(decide({}, { promoting: true })).toBe('abandonPromotion');
  });

  it('промоушен: ответ на оффер решается как у гостя', () => {
    expect(decide({ re: 'webrtc_offer' }, { promoting: true })).toBe('leave');
  });

  // регрессия F4: оффер ушёл в момент смены хоста
  it('супервизор в migrating — ignore даже при ожидающем оффере', () => {
    expect(
      decide(
        { re: 'webrtc_offer', roomId: 'r1' },
        { sessionState: 'migrating' },
      ),
    ).toBe('ignore');
    expect(decide({}, { sessionState: 'migrating' })).toBe('ignore');
  });

  it('ответ на оффер, каналы не открыты — leave', () => {
    expect(decide({ re: 'webrtc_offer', roomId: 'r1' })).toBe('leave');
    // старый мастер: без re и roomId
    expect(decide({})).toBe('leave');
  });

  it('оффер не ожидает ответа — ignore', () => {
    expect(decide({ re: 'webrtc_offer' }, { offerPending: false })).toBe(
      'ignore',
    );
  });

  // ревью F9: мастер рестартовал, комнату ещё не вернул хост
  it('ответ на join_room своей комнаты — retryJoin', () => {
    expect(decide({ re: 'join_room', roomId: 'r1' })).toBe('retryJoin');
    expect(
      decide({ re: 'join_room', roomId: 'r1' }, { sessionState: 'migrating' }),
    ).toBe('retryJoin');
  });

  it('join_room: не та комната, хост, нет членства или сессия закрыта — ignore', () => {
    expect(decide({ re: 'join_room', roomId: 'r2' })).toBe('ignore');
    expect(decide({ re: 'join_room' })).toBe('ignore');
    expect(decide({ re: 'join_room', roomId: 'r1' }, { isHost: true })).toBe(
      'ignore',
    );
    expect(
      decide({ re: 'join_room', roomId: 'r1' }, { memberJoined: false }),
    ).toBe('ignore');
    expect(
      decide({ re: 'join_room', roomId: 'r1' }, { sessionState: 'closed' }),
    ).toBe('ignore');
  });

  it('вне комнаты roomId не сравнивается', () => {
    expect(
      decide({ re: 'webrtc_offer', roomId: 'r2' }, { currentRoomId: null }),
    ).toBe('leave');
  });
});

describe('decideInvalidToken', () => {
  const decideToken = (msg, ctx = {}) =>
    decideInvalidToken({
      msg: { code: 'invalidToken', ...msg },
      promoting: false,
      inRoom: true,
      sessionState: 'connected',
      ...ctx,
    });

  it('register_host во время промоушена — отказ от промоушена', () => {
    expect(decideToken({ re: 'register_host' }, { promoting: true })).toBe(
      'abandonPromotion',
    );
  });

  it('register_host без промоушена — прежнее поведение', () => {
    expect(decideToken({ re: 'register_host' })).toBe('logoutAndLeave');
  });

  it('join_room гостя в живом матче — матч продолжается', () => {
    expect(decideToken({ re: 'join_room', roomId: 'r1' })).toBe('keepPlaying');
    expect(
      decideToken({ re: 'join_room' }, { sessionState: 'migrating' }),
    ).toBe('keepPlaying');
  });

  it('join_room в закрытой сессии — выход', () => {
    expect(decideToken({ re: 'join_room' }, { sessionState: 'closed' })).toBe(
      'logoutAndLeave',
    );
  });

  it('вне комнаты — только выход из аккаунта', () => {
    expect(decideToken({ re: 'join_room' }, { inRoom: false })).toBe('logout');
    expect(decideToken({}, { inRoom: false })).toBe('logout');
  });

  it('прочие запросы в комнате — выход из аккаунта и комнаты', () => {
    expect(decideToken({ re: 'reclaim_host' })).toBe('logoutAndLeave');
    expect(decideToken({})).toBe('logoutAndLeave');
  });
});
