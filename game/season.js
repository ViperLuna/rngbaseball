// season.js
// -----------------------------------------------------------------------------
// Shared data/logic for the season loop: the league ladder, the two
// localStorage saves (meta-progress and the in-progress season), standings
// bookkeeping, cumulative season stat merging, and simulating a full round
// of games. No UI code lives here -- every season-related page (index.html,
// league-select.html, team-select.html, season.html, team-stats.html,
// box-score.html) includes this file.
//
// Some functions here (initializeSeason, simulateRound, buildGameHistoryEntry,
// mergeGameStatsIntoSeason) call into engine.js (simulateGame, ensurePlayer,
// findPitcher) and schedule.js (generateSeasonSchedule). Any page that calls
// those functions must load engine.js and schedule.js *before* this file.
// Pages that only need the league ladder or plain save/load (like
// index.html) don't need those other two files at all.
//
// Two separate localStorage keys:
//   - META_KEY ("rngbaseball_meta"): which leagues are unlocked. Survives
//     "New Season" -- only "Fresh Start" wipes it back to Rookie-only.
//   - SAVE_KEY ("rngbaseball_save"): the current season in progress (chosen
//     team, schedule, standings, cumulative season stats, full per-game
//     history including play-by-play, and playoff state once the regular
//     season ends). Wiped by both "New Season" and "Fresh Start".
// -----------------------------------------------------------------------------

const LEAGUES = ["Rookie", "A", "AA", "AAA", "Majors", "Elite"];

function nextLeague(current) {
  const idx = LEAGUES.indexOf(current);
  if (idx === -1 || idx === LEAGUES.length - 1) return null;
  return LEAGUES[idx + 1];
}

// --- Meta-progress save (survives New Season) --------------------------------

const META_KEY = "rngbaseball_meta";

function getMeta() {
  const raw = localStorage.getItem(META_KEY);
  if (!raw) return { unlockedLeagues: ["Rookie"], currentLeague: "Rookie" };
  return JSON.parse(raw);
}
function setMeta(meta) {
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}
function clearMeta() {
  localStorage.removeItem(META_KEY);
}

// --- Season save ---------------------------------------------------------------

const SAVE_KEY = "rngbaseball_save";

function getSave() {
  const raw = localStorage.getItem(SAVE_KEY);
  return raw ? JSON.parse(raw) : null;
}
function setSave(data) {
  localStorage.setItem(SAVE_KEY, JSON.stringify(data));
}
function clearSave() {
  localStorage.removeItem(SAVE_KEY);
}

function initStandings(teamNames) {
  const standings = {};
  teamNames.forEach(name => {
    standings[name] = { wins: 0, losses: 0, runsFor: 0, runsAgainst: 0 };
  });
  return standings;
}

// Builds a brand new season save: a fresh shuffled round-robin schedule,
// empty standings/season stats/history, no playoff decided yet.
function initializeSeason(league, yourTeam, teamNames) {
  return {
    seasonInProgress: true,
    league,
    yourTeam,
    schedule: generateSeasonSchedule(teamNames),
    currentRound: 0,
    standings: initStandings(teamNames),
    seasonStats: {},
    gameHistory: [],
    playoff: null
  };
}

function applyGameToStandings(standings, historyEntry) {
  const { home, away, scoreHome, scoreAway, winner } = historyEntry;
  standings[home].runsFor += scoreHome;
  standings[home].runsAgainst += scoreAway;
  standings[away].runsFor += scoreAway;
  standings[away].runsAgainst += scoreHome;
  if (winner === home) {
    standings[home].wins++;
    standings[away].losses++;
  } else {
    standings[away].wins++;
    standings[home].losses++;
  }
}

function mergeStatLineInto(target, source) {
  target.batting.AB += source.batting.AB;
  target.batting.H += source.batting.H;
  target.batting.doubles += source.batting.doubles;
  target.batting.triples += source.batting.triples;
  target.batting.HR += source.batting.HR;
  target.batting.BB += source.batting.BB;
  target.batting.K += source.batting.K;
  target.batting.R += source.batting.R;
  target.pitching.outs += source.pitching.outs;
  target.pitching.H += source.pitching.H;
  target.pitching.BB += source.pitching.BB;
  target.pitching.K += source.pitching.K;
  target.pitching.R += source.pitching.R;
}

function mergeGameStatsIntoSeason(seasonStats, gameStats) {
  for (const name in gameStats) {
    mergeStatLineInto(ensurePlayer(seasonStats, name), gameStats[name]);
  }
}

// The full per-play stats snapshot on each play (used only to animate the
// live reveal) would make season-long storage of every game far bigger than
// it needs to be -- history playback just needs the running score and text,
// so this strips the snapshot back down before a game gets saved.
function trimPlaysForHistory(plays) {
  return plays.map(p => ({ half: p.half, inning: p.inning, text: p.text, scoreA: p.scoreA, scoreB: p.scoreB }));
}

function buildGameHistoryEntry(round, rawResult, awayTeam, homeTeam) {
  return {
    round,
    away: awayTeam.name,
    home: homeTeam.name,
    scoreAway: rawResult.scoreA,
    scoreHome: rawResult.scoreB,
    winner: rawResult.winner,
    errors: { away: rawResult.errors.A, home: rawResult.errors.B },
    plays: trimPlaysForHistory(rawResult.plays),
    stats: rawResult.stats,
    pitchers: { away: findPitcher(awayTeam).name, home: findPitcher(homeTeam).name }
  };
}

// Simulates every game in one round. `teamsByName` is a { name: teamObject }
// lookup built from teams.json. Returns one entry per game with the raw
// engine result (needed for the live-reveal UI on your own game) alongside
// the already-trimmed history entry (ready to push into gameHistory).
function simulateRound(schedule, roundIndex, teamsByName) {
  return schedule[roundIndex].map(({ home, away }) => {
    const awayTeam = teamsByName[away];
    const homeTeam = teamsByName[home];
    const rawResult = simulateGame(awayTeam, homeTeam);
    return {
      home, away, awayTeam, homeTeam, rawResult,
      historyEntry: buildGameHistoryEntry(roundIndex, rawResult, awayTeam, homeTeam)
    };
  });
}

// Ranks by wins, then run differential, then a random tiebreak for true
// ties, and returns the top two team names -- the two who play for the
// league championship.
function determineTopTwo(standings) {
  const entries = Object.entries(standings).map(([name, rec]) => ({
    name,
    wins: rec.wins,
    diff: rec.runsFor - rec.runsAgainst,
    tiebreak: Math.random()
  }));
  entries.sort((a, b) => b.wins - a.wins || b.diff - a.diff || b.tiebreak - a.tiebreak);
  return [entries[0].name, entries[1].name];
}
