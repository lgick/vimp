// Chat command '/spawn <count>' — fills the room with bots without a vote.
// It is also what `npm run dev` uses to get a match going (startupCommands in
// dev/main.js).
//
// The engine has no chat commands of its own: `CommandProcessor` is a bare
// registry, so every name a player can type is declared by the game here —
// including the meta ones (/name, /nr, /rank) in src/host/metaCommands.js.
// A name registered twice silently loses one of the two handlers.
export default {
  name: '/spawn',

  // ctx = { participants, chat, scripted, roundManager, voteCoordinator,
  //         timerManager, playerDataSync, teams, spectatorTeam, spectatorId,
  //         isDevMode }
  handler(ctx, gameId, args) {
    // the argument is whatever a player typed: '/spawn -3' must not mean
    // zero bots, and '/spawn 1e9' must not mean a billion loop iterations
    const { maxPlayers } = ctx.participants;
    const requested = Math.max(1, Math.trunc(Number(args[0])) || 1);
    const count = maxPlayers > 0 ? Math.min(requested, maxPlayers) : requested;
    const created = ctx.scripted.createScripted(count);

    // the code is the game's own (src/host/systemMessages.js); the TEXT lives
    // on the client, in modules.chat.params.messages
    ctx.chat.pushSystem('BOTS_SPAWNED', [created]);

    // restart the round so the fresh bots enter the world at once instead of
    // waiting out the current one as corpses — pointless if nobody was added
    if (created > 0) {
      ctx.roundManager.initiateNewRound();
    }
  },
};
