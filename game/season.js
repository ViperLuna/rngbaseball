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
  if (!raw) return { unlockedLeagues: ["Rookie"], currentLeague: "Rookie", basebux: 0, inventory: [] };
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

// --- Economy: Basebux, accolades, and loot crates -----------------------------
// Basebux and the pulled-item inventory live in the meta-save, not the
// season save -- they're player-level progress that survives "New Season"
// the same way league unlocks do; only "Fresh Start" wipes them.

const BASE_PAYOUTS = { win: 100, loss: 40 };

// Flat bonuses, paid once per occurrence (a 2-HR game pays the home run
// bonus twice), only for the player's own team, and only if the game was
// actually watched rather than skipped -- that's the whole point of them.
const ACCOLADE_PAYOUTS = { homeRun: 10, shutout: 50, noHitter: 150, cycle: 100 };

// Same six rarities in both crates -- Advanced just shifts the odds hard
// toward the top end. Nothing is ever literally impossible from either one.
const CRATES = {
  basic: {
    label: "Basic Crate",
    price: 75,
    odds: { Common: 0.50, Uncommon: 0.30, Rare: 0.13, Epic: 0.05, Legendary: 0.017, Mythical: 0.003 }
  },
  advanced: {
    label: "Advanced Crate",
    price: 450,
    odds: { Common: 0.10, Uncommon: 0.20, Rare: 0.30, Epic: 0.25, Legendary: 0.12, Mythical: 0.03 }
  }
};

// Detects the player's own accolades from one completed game's history
// entry. `yourLineupNames` is the player's own team's list of player names
// (from teams.json), needed since historyEntry.stats is keyed by player
// name across both teams with no per-player team tag.
function detectAccolades(historyEntry, yourTeam, yourLineupNames) {
  const isHome = historyEntry.home === yourTeam;
  const yourPitcherName = isHome ? historyEntry.pitchers.home : historyEntry.pitchers.away;
  const pitcherLine = historyEntry.stats[yourPitcherName].pitching;

  const accolades = [];
  if (pitcherLine.R === 0) accolades.push({ type: "shutout", label: "Shutout", count: 1, bonus: ACCOLADE_PAYOUTS.shutout });
  if (pitcherLine.H === 0) accolades.push({ type: "noHitter", label: "No-Hitter", count: 1, bonus: ACCOLADE_PAYOUTS.noHitter });

  let homeRuns = 0;
  yourLineupNames.forEach(name => {
    const line = historyEntry.stats[name].batting;
    homeRuns += line.HR;
    const singles = line.H - line.doubles - line.triples - line.HR;
    if (singles >= 1 && line.doubles >= 1 && line.triples >= 1 && line.HR >= 1) {
      accolades.push({ type: "cycle", label: `Cycle (${name})`, count: 1, bonus: ACCOLADE_PAYOUTS.cycle });
    }
  });
  if (homeRuns > 0) {
    accolades.push({ type: "homeRun", label: "Home Run", count: homeRuns, bonus: ACCOLADE_PAYOUTS.homeRun * homeRuns });
  }

  return accolades;
}

// The win/loss base always pays out. Accolades only pay out if `watched` is
// true; otherwise they're returned separately as `forfeited`, so the UI can
// show what was earned alongside what was left on the table by skipping.
function computeGamePayout(historyEntry, yourTeam, yourLineupNames, watched) {
  const won = historyEntry.winner === yourTeam;
  const base = won ? BASE_PAYOUTS.win : BASE_PAYOUTS.loss;
  const accolades = detectAccolades(historyEntry, yourTeam, yourLineupNames);
  const accoladeTotal = accolades.reduce((sum, a) => sum + a.bonus, 0);

  if (watched) {
    return { base, accolades, total: base + accoladeTotal, forfeited: [] };
  }
  return { base, accolades: [], total: base, forfeited: accolades };
}

function rollRarity(crateType) {
  const odds = CRATES[crateType].odds;
  const roll = Math.random();
  let cumulative = 0;
  for (const rarity of Object.keys(odds)) {
    cumulative += odds[rarity];
    if (roll < cumulative) return rarity;
  }
  return "Common"; // floating-point fallback, odds sum to ~1
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
