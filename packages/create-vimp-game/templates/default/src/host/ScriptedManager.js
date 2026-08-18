// The bot manager: the game half of "scripted participants". The engine calls
// exactly five methods on it — createMap, getCountsPerTeam, createScripted,
// removeScripted, removeOneForHuman — and never anything else
// (docs/ai/03-host-plugin.md § The `scripted` module contract).
//
// It holds no state that a host handoff may not lose: a restored room
// re-creates the map and respawns everyone, and this object is rebuilt from
// scratch. Worker-safe.
export default class ScriptedManager {
  constructor({ participants, coreAdapter, panel, stat, scripted }) {
    this._participants = participants;
    this._coreAdapter = coreAdapter;
    this._panel = panel;
    this._stat = stat;

    // `scripted` in the context is gameConfig.scripted — a config object, not
    // a module
    this._model = scripted.defaultModel;
    this._respawns = null;
  }

  // called on every map load, with the map data ALREADY scaled
  createMap(mapData) {
    this._respawns = mapData.respawns;
  }

  // { teamName: count } — the engine balances the teams by it
  getCountsPerTeam() {
    const counts = {};

    for (const participant of this._participants.getScripted()) {
      counts[participant.team] = (counts[participant.team] ?? 0) + 1;
    }

    return counts;
  }

  // returns how many were actually created — the caller reports that number,
  // not the number asked for
  createScripted(count, teamName = null) {
    if (!this._respawns) {
      return 0;
    }

    const playableTeams = this._participants.getPlayableTeams();
    let created = 0;

    for (let i = 0; i < count; i += 1) {
      if (this._participants.isFull) {
        break;
      }

      // no team asked for: fill the emptiest one, so a room of bots stays
      // balanced without anyone steering it
      const targetTeam =
        teamName ??
        [...playableTeams].sort(
          (a, b) =>
            this._participants.getTeamSize(a) -
            this._participants.getTeamSize(b),
        )[0];

      // the number of respawn points is the hard capacity of a team: past it
      // the engine has nowhere to put the actor
      if (
        !targetTeam ||
        !this._respawns[targetTeam] ||
        this._participants.getTeamSize(targetTeam) >=
          this._respawns[targetTeam].length
      ) {
        continue;
      }

      const gameId = this._participants.createScripted({
        team: targetTeam,
        model: this._model,
      });
      const participant = this._participants.get(gameId);

      // a bot has no socket, so the engine never writes its latency cell —
      // whatever is passed here is what the table shows for the whole match
      this._stat.addUser(gameId, participant.teamId, {
        name: participant.name,
        status: 'dead',
        latency: 'BOT',
      });
      this._panel.addUser(gameId);

      created += 1;
    }

    return created;
  }

  removeScripted(teamName = null) {
    const scripted = this._participants.getScripted();
    const toRemove = teamName
      ? scripted.filter(participant => participant.team === teamName)
      : scripted;

    toRemove.forEach(participant => this._remove(participant.gameId));
  }

  // a human needs a slot in a full team: free one and say whether it worked
  removeOneForHuman(teamName) {
    for (const participant of this._participants.getScripted()) {
      if (participant.team === teamName) {
        this._remove(participant.gameId);

        return true;
      }
    }

    return false;
  }

  _remove(gameId) {
    const participant = this._participants.get(gameId);

    if (!participant || !participant.isScripted) {
      return;
    }

    this._stat.removeUser(gameId, participant.teamId);
    this._panel.removeUser(gameId);
    this._coreAdapter.removePlayer(gameId);
    this._participants.remove(gameId);
  }
}
