import { vi } from 'vitest';
import Publisher from '../../../packages/engine/src/lib/Publisher.js';

// Общие фейки сценариев client/session/*: сигналинг мастера (Publisher +
// шпионы отправки) и минимальный lobby-конфиг.

const SIGNALING_METHODS = [
  'connect',
  'registerHost',
  'reclaimHost',
  'updateHost',
  'joinRoom',
  'memberUpdate',
  'standbyStatus',
  'roomPeers',
  'probeAck',
  'hostUnreachable',
  'promoteFailed',
  'handoffBegin',
  'hostHealth',
  'hostLeaving',
  'hostClosing',
  'leaveRoom',
  'hostVoteStart',
  'hostVoteAnswer',
];

export function makeSignaling() {
  const signaling = {
    publisher: new Publisher(),
    iceServers: [{ urls: 'stun:example' }],
    connected: true,
    emit(type, msg = {}) {
      this.publisher.emit(type, { type, ...msg });
    },
  };

  for (const name of SIGNALING_METHODS) {
    signaling[name] = vi.fn();
  }

  return signaling;
}

export function makeConfig(overrides = {}) {
  return {
    create: { hostSocketId: 'host', heartbeatInterval: 5000 },
    webrtc: { connectTimeoutMs: 8000, offerRetryMs: 2000 },
    reconnect: { baseDelay: 1000, maxDelay: 8000 },
    session: {
      joinRetryWindowMs: 30000,
      linkWaitMaxMs: 10000,
      migrationPollMs: 1000,
    },
    quickPlay: { autoCreate: true, createDelayMinMs: 0, createDelayMaxMs: 0 },
    roomUrl: roomId => `/rooms/${roomId}`,
    quickPlayUrl: gameId => `/quick-play/${gameId}`,
    maps: {
      manifestUrl: game => `/maps/${game.id}/manifest.json`,
      baseUrl: game => `/maps/${game.id}`,
    },
    worker: { manifestUrl: '/worker/manifest.json' },
    game: {
      manifestUrl: id => `/games/${id}/manifest.json`,
      versionManifestUrl: (id, version) => `/games/${id}/${version}.json`,
    },
    migration: {
      minTokenLifetimeMs: 60000,
      standbyStatusIntervalMs: 1000,
      peersReportIntervalMs: 2000,
      checkpointIntervalMs: 1000,
      standbyChunkBytes: 16384,
      standbyHighWaterBytes: 65536,
      standbyReopenDelayMs: 500,
      standbyReopenMaxDelayMs: 5000,
      handoffSlowMs: 3000,
      handoffDeadlineMs: 10000,
      deferMaxMs: 30000,
      finalWaitMs: 1500,
      maxRestoreAgeMs: 10000,
      tokenHandoffLeadMs: 120000,
      tokenHandoffRetryMs: 5000,
      leaveFlushTimeoutMs: 2000,
      auto: {
        enabled: true,
        hostHealthIntervalMs: 2000,
        fpsReportIntervalMs: 5000,
      },
    },
    ...overrides,
  };
}

// фейковый fetch по таблице url → тело (null — 404)
export function makeFetch(routes) {
  return vi.fn(async url => {
    if (!Object.hasOwn(routes, url)) {
      throw new Error(`offline: ${url}`);
    }

    const body = routes[url];

    return {
      ok: body !== null,
      status: body === null ? 404 : 200,
      json: async () => body,
    };
  });
}
