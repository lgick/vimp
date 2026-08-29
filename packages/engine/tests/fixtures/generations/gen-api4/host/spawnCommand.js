// Игровая чат-команда фикстуры: '/spawn <count>' — создаёт scripted-
// участников без голосования (зеркало vimp-tanks/src/host/botCommand.js,
// упрощённое — доказывает только регистрацию HostPlugin.chatCommands).
// Регистрируется в движковом CommandProcessor.
export default {
  name: '/spawn',
  handler(ctx, gameId, args) {
    const count = Number(args[0]) || 1;
    const created = ctx.scripted.createScripted(count);

    ctx.chat.pushSystem('SCRIPTED_SPAWNED', [created]);
    ctx.roundManager.initiateNewRound();
  },
};
