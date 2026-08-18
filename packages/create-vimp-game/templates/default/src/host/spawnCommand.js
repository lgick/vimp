// Chat command '/spawn <count>' — fills the room with bots without a vote.
// It is also what `npm run dev` uses to get a match going (startupCommands in
// dev/main.js).
//
// The name must not collide with the engine's own commands (/name, /nr,
// /timeleft, /mapname, /rank): those are matched by a switch BEFORE the game
// registry, so a same-named command registers fine and never fires.
export default {
  name: '/spawn',

  // ctx = { participants, chat, scripted, roundManager, voteCoordinator,
  //         timerManager, playerDataSync, teams, spectatorTeam, spectatorId,
  //         isDevMode }
  handler(ctx, gameId, args) {
    const count = Number(args[0]) || 1;
    const created = ctx.scripted.createScripted(count);

    // the code is the game's own (src/host/systemMessages.js); the TEXT lives
    // on the client, in modules.chat.params.messages
    ctx.chat.pushSystem('BOTS_SPAWNED', [created]);

    // restart the round so the fresh bots enter the world at once instead of
    // waiting out the current one as corpses
    ctx.roundManager.initiateNewRound();
  },
};
