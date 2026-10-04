// Выбор преемника (беты) комнаты — host-migration этап 6. Чистая функция:
// всё, что она знает о комнате, ей передают описанием, часы — аргументом.
// SignalingServer собирает описание из реестра и сессий и хранит
// результат в комнате.

// ярус P2P-связности по типу выбранного локального ICE-кандидата: игрок,
// которому для связи со старым хостом нужен ретранслятор (relay), в роли
// хоста не дотянется до части игроков напрямую, а TURN необязателен
const ICE_TIER = { host: 0, srflx: 0, prflx: 0, relay: 2 };
const UNKNOWN_ICE_TIER = 1;

/**
 * Ярус связности участника: 0 — прямой кандидат, 1 — неизвестно, 2 — relay.
 * relayPenalty (неудачный промоушен, этап 7) приравнивает его к relay.
 * @param {Object} member
 * @returns {number}
 */
export function iceTier(member) {
  if (member.relayPenalty) {
    return ICE_TIER.relay;
  }

  return ICE_TIER[member.caps?.iceType] ?? UNKNOWN_ICE_TIER;
}

// score неизвестен (pong ещё не пришёл) — хуже любого измеренного
const scoreOf = member =>
  Number.isFinite(member.score) ? member.score : Infinity;

/**
 * Может ли участник стать бетой прямо сейчас.
 * @param {Object} member - { memberId, live, caps, joinedAt, demotedUntil,
 *   confirmed }; confirmed: false — хост не подтвердил WebRTC-соединение с
 *   ним (room_peers), фантом без пира не получит ни точек, ни роли.
 * @param {string|null} hostMemberId
 * @param {number} now
 * @param {number} minMemberAgeMs
 * @param {boolean} [allowHidden] - аварийный промоушен (этап 7): скрытая
 *   вкладка (и слабый FPS) лучше закрытой комнаты.
 * @param {number} [minFps] - FPS рендера не ниже (этап 9c); неизвестный FPS
 *   (старый клиент) не отсеивается.
 * @returns {boolean}
 */
export function isCandidate(
  member,
  hostMemberId,
  now,
  minMemberAgeMs,
  allowHidden = false,
  minFps = 0,
) {
  const fps = member.caps?.fps;

  return (
    member.memberId !== hostMemberId &&
    member.live === true &&
    member.caps?.canHost === true &&
    (allowHidden || member.caps?.hidden !== true) &&
    (allowHidden || !Number.isFinite(fps) || fps >= minFps) &&
    now - member.joinedAt >= minMemberAgeMs &&
    !(member.demotedUntil > now) &&
    member.confirmed !== false
  );
}

// порядок кандидатов: ярус связности, затем score, затем кто раньше вошёл
function compareCandidates(a, b) {
  return (
    iceTier(a) - iceTier(b) ||
    scoreOf(a) - scoreOf(b) ||
    a.joinedAt - b.joinedAt
  );
}

/**
 * Выбирает бету комнаты с гистерезисом.
 * @param {Object} room
 * @param {string|null} room.hostMemberId
 * @param {string|null} room.successorMemberId - текущая бета.
 * @param {Object|null} room.challenger - { memberId, since }: кандидат,
 *   который лучше текущей беты, и с какого момента.
 * @param {Array<Object>} room.members - { memberId, live, caps, joinedAt,
 *   score, demotedUntil, relayPenalty, confirmed }.
 * @param {number} now
 * @param {Object} opts
 * @param {number} opts.minMemberAgeMs
 * @param {number} opts.switchRatio - лучший заменяет текущего, если его
 *   score ≤ switchRatio × score текущего (или ярус связности лучше)...
 * @param {number} opts.switchSustainMs - ...дольше этого.
 * @param {boolean} [opts.allowHidden] - кандидат и со скрытой вкладкой.
 * @param {number} [opts.minFps] - минимальный FPS рендера беты.
 * @returns {{ successorMemberId: string|null, challenger: Object|null }}
 */
export function pickSuccessor(room, now, opts) {
  const { minMemberAgeMs, switchRatio, switchSustainMs, allowHidden, minFps } =
    opts;
  const candidates = room.members
    .filter(member =>
      isCandidate(
        member,
        room.hostMemberId,
        now,
        minMemberAgeMs,
        allowHidden,
        minFps,
      ),
    )
    .sort(compareCandidates);
  const best = candidates[0] ?? null;
  const current = candidates.find(
    member => member.memberId === room.successorMemberId,
  );

  // беты нет или она перестала быть кандидатом — сразу лучший
  if (!current) {
    return { successorMemberId: best?.memberId ?? null, challenger: null };
  }

  const keep = challenger => ({
    successorMemberId: current.memberId,
    challenger,
  });

  if (best === current) {
    return keep(null);
  }

  // смена беты стоит повторного прогрева и трафика: только заметно лучший
  // кандидат, и только если он держит перевес долго
  const better =
    iceTier(best) < iceTier(current) ||
    scoreOf(best) <= switchRatio * scoreOf(current);

  if (!better) {
    return keep(null);
  }

  if (room.challenger?.memberId !== best.memberId) {
    return keep({ memberId: best.memberId, since: now });
  }

  if (now - room.challenger.since >= switchSustainMs) {
    return { successorMemberId: best.memberId, challenger: null };
  }

  return keep(room.challenger);
}
