import ScriptedManager from './ScriptedManager.js';

// Factory of the game's host modules (HostPlugin.createModules). The engine
// reads exactly ONE key off the result — `scripted`; anything else returned
// here is never called by it.
//
// The context is { participants, coreAdapter, panel, stat, chat,
// socketManager, scripted } — there is no timerManager and no
// voteCoordinator in it (those exist only in a chat-command context).
export default function createModules(ctx) {
  return { scripted: new ScriptedManager(ctx) };
}
