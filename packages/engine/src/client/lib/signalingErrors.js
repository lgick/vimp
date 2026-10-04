/**
 * Что делать с error {code: 'unknownRoom'} мастера.
 * @param {Object} ctx
 * @param {Object} ctx.msg - сообщение ошибки ({ code, re, roomId }).
 * @param {string|null} ctx.currentRoomId
 * @param {boolean} ctx.promoting - вкладка занимает комнату (hostPromotion).
 * @param {string|null} ctx.sessionState - состояние SessionSupervisor.
 * @param {boolean} ctx.offerPending - текущий транспорт — WebRTC, ещё не открыт.
 * @param {boolean} [ctx.memberJoined] - вкладка объявила членство join_room.
 * @param {boolean} [ctx.isHost] - вкладка — хост комнаты.
 * @returns {'abandonPromotion'|'leave'|'retryJoin'|'ignore'}
 */
export function decideUnknownRoom({
  msg,
  currentRoomId,
  promoting,
  sessionState,
  offerPending,
  memberJoined = false,
  isHost = false,
}) {
  if (msg.roomId && currentRoomId && msg.roomId !== currentRoomId) {
    return 'ignore';
  }

  if (promoting && (!msg.re || msg.re === 'register_host')) {
    return 'abandonPromotion';
  }

  // мастер рестартовал, а хост ещё не вернул комнату reclaim_host — вход
  // повторяется (P2P-матч при этом жив)
  if (msg.re === 'join_room') {
    return msg.roomId === currentRoomId &&
      !isHost &&
      memberJoined &&
      sessionState !== 'closed'
      ? 'retryJoin'
      : 'ignore';
  }

  // комната сменяет хоста: исход решат host_changed / room_closed и таймер
  // миграции супервизора, а не ответ на оффер, ушедший в момент смены
  if (sessionState === 'migrating') {
    return 'ignore';
  }

  if ((!msg.re || msg.re === 'webrtc_offer') && offerPending) {
    return 'leave';
  }

  return 'ignore';
}

/**
 * Что делать с error {code: 'invalidToken'} мастера (истёкший вход).
 * @param {Object} ctx
 * @param {Object} ctx.msg - сообщение ошибки ({ code, re, roomId }).
 * @param {boolean} ctx.promoting - вкладка занимает комнату (hostPromotion).
 * @param {boolean} ctx.inRoom - вкладка в комнате.
 * @param {string|null} ctx.sessionState - состояние SessionSupervisor.
 * @returns {'abandonPromotion'|'keepPlaying'|'logoutAndLeave'|'logout'}
 */
export function decideInvalidToken({ msg, promoting, inRoom, sessionState }) {
  if (msg.re === 'register_host' && promoting) {
    return 'abandonPromotion';
  }

  // гость в живом матче: токен нужен мастеру, а не P2P-соединению с хостом
  if (msg.re === 'join_room' && inRoom && sessionState !== 'closed') {
    return 'keepPlaying';
  }

  return inRoom ? 'logoutAndLeave' : 'logout';
}
