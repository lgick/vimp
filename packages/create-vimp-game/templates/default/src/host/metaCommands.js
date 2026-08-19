// The chat commands the engine used to own. It owns none now:
// `CommandProcessor` is a bare registry, so a game that wants a nickname
// change, a round restart or a rank readout declares them itself — and the
// same name may mean something else, or nothing, in the next game.
//
// Two more the engine used to have are left out here because they only make
// sense in a game with a round timer and several maps: '/timeleft'
// (`ctx.timerManager.getMapTimeLeft()`) and '/mapname'
// (`ctx.roundManager.currentMap`). Add them the same way if yours has both.
//
// The message codes below are the engine's own (group 'c'); their texts live
// in `modules.chat.params.messages` (src/config/client.js).

// ctx = { participants, chat, scripted, roundManager, voteCoordinator,
//         timerManager, playerDataSync, teams, spectatorTeam, spectatorId,
//         isDevMode }

/// '/name <nickname>' — the engine validates and announces it itself.
export const nameCommand = {
  name: '/name',

  handler(ctx, gameId, args) {
    ctx.roundManager.changeName(gameId, args.join(' '));
  },
};

/// '/nr' — restart the round; dev builds only.
export const newRoundCommand = {
  name: '/nr',

  handler(ctx, gameId) {
    if (ctx.isDevMode) {
      ctx.roundManager.initiateNewRound();
    } else {
      ctx.chat.pushSystemByUser(gameId, 'COMMANDS_NOT_FOUND');
    }
  },
};

/// '/rank' — the per-(user, game) number the auth service keeps.
export const rankCommand = {
  name: '/rank',

  handler(ctx, gameId) {
    ctx.chat.pushSystemByUser(gameId, 'RANK', [
      ctx.playerDataSync.getRank(gameId),
    ]);
  },
};
