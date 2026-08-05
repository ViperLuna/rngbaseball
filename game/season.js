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
// empty standings/season stats/history, no playoff decided yet, a
// freshly-rolled opponentGear map (gear.js's generateOpponentGear) covering
// every player except yourTeam's -- re-rolled every time a season starts --
// and an empty equippedGear map for the player's own roster (see
// loadouts.html), since nothing's equipped yet at season creation.
// `teams` is teams.json's full team list (not just names), needed to know
// each opponent player's position for gear.js's slot assignment; `items` is
// items.json's items array.
function initializeSeason(league, yourTeam, teams, items) {
  const teamNames = teams.map(t => t.name);
  return {
    seasonInProgress: true,
    league,
    yourTeam,
    schedule: generateSeasonSchedule(teamNames),
    currentRound: 0,
    standings: initStandings(teamNames),
    seasonStats: {},
    gameHistory: [],
    playoff: null,
    opponentGear: generateOpponentGear(teams, yourTeam, league, items),
    equippedGear: {}
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

// gear.js's buildGearedTeam() just needs one { playerName: gear } map --
// opponentGear and equippedGear never overlap (the former explicitly skips
// yourTeam, the latter only ever covers yourTeam), so merging them is safe
// and lets every simulation call site stay agnostic about which side of the
// roster a given player's gear came from.
function fullGearMap(save) {
  return { ...save.opponentGear, ...save.equippedGear };
}

// Chump change -- deliberately a bad trade next to what a crate costs, just
// a way to clear out items you don't want to keep in your inventory.
const SELL_PRICES = { Common: 5, Uncommon: 10, Rare: 20, Epic: 40, Legendary: 75, Mythical: 150 };

// --- Play-by-play cipher: encode ---------------------------------------------
// Turns a game's raw play array (engine.js's simulateHalfInning output, one
// entry per plate appearance plus an optional walk-off marker) into the
// compact newline-delimited string described by PLAY_CATALOG in engine.js --
// see the comment there for the full format. This is cheap enough to store
// for every league game every round, not just the player's own, which is
// what actually caused the localStorage quota to blow past its limit before:
// a full JSON object with a rendered sentence for every play in every game,
// every round, rather than a handful of characters per play.
function encodePlayLine(play) {
  if (play.walkOff) return "WO";
  const code = PLAY_CATALOG.types[play.type].code;
  let line = `${play.side}${play.batterSlot}${code}`;
  if (play.extraBaseAttempt) {
    const result = play.extraBaseAttempt.success ? "SC" : "XX";
    line += `${play.side}${play.extraBaseAttempt.slot}${result}`;
  }
  return line;
}

function encodeGamePlays(rawPlays) {
  return rawPlays.map(encodePlayLine).join("\n");
}

// --- Play-by-play cipher: decode ---------------------------------------------

function pickText(templates) {
  return templates[Math.floor(Math.random() * templates.length)];
}

function fillTemplate(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, key) => vars[key]);
}

function namesFromSlots(slots, lineup) {
  return slots.map(s => lineup[s - 1].name);
}

// Replays a game's compact cipher string back into the same per-play shape
// box-score.html and season-game.html already know how to render (text,
// running score, bases-as-names) -- reconstructed on demand instead of
// stored, using the exact same advanceAllRunners/forceAdvance/
// forceAdvanceRunnersOnly functions the live engine uses (they're generic
// about what "identity" sits in a base, so a lineup slot number works
// exactly like a runner's name does here). `awayLineup`/`homeLineup` are
// teams.json lineup arrays -- fixed batting order, needed to resolve a
// play's slot reference back into a player's name.
function decodeGamePlays(playCode, awayLineup, homeLineup) {
  const lines = playCode.split("\n").filter(l => l.length > 0);
  const decoded = [];

  let bases = emptyBases(); // holds lineup slot numbers, not names, until rendered
  let outs = 0;
  let inning = 0;
  let side = null;
  let scoreA = 0, scoreB = 0;

  for (const line of lines) {
    const lineup = side === "A" ? awayLineup : homeLineup;

    if (line === "WO") {
      decoded.push({
        half: side === "A" ? "top" : "bottom", inning,
        text: pickText(PLAY_CATALOG.walkOff),
        scoreA, scoreB,
        bases: bases.map(s => s === null ? null : lineup[s - 1].name)
      });
      break; // always the last line
    }

    const lineSide = line[0];
    if (lineSide !== side) {
      bases = emptyBases();
      outs = 0;
      side = lineSide;
      if (side === "A") inning++;
    }

    const battingLineup = side === "A" ? awayLineup : homeLineup;
    const slot = Number(line[1]);
    const type = PLAY_CODE_TO_TYPE[line.slice(2, 4)];
    const tail = line.slice(4);
    const batterName = battingLineup[slot - 1].name;
    const half = side === "A" ? "top" : "bottom";

    let resultBases, runsScored, scorerSlots, outsAdded, text;

    if (type === "strikeout" || type === "flyout") {
      resultBases = bases; runsScored = 0; scorerSlots = []; outsAdded = 1;
      text = fillTemplate(pickText(PLAY_CATALOG.types[type].text), { batter: batterName });
    } else if (type === "walk" || type === "error") {
      const r = forceAdvance(bases, slot);
      resultBases = r.bases; runsScored = r.runsScored; scorerSlots = r.scorers; outsAdded = 0;
      text = fillTemplate(pickText(PLAY_CATALOG.types[type].text), { batter: batterName })
        + scoringSuffix(namesFromSlots(r.scorers, battingLineup));
    } else if (type === "single" || type === "double" || type === "triple" || type === "home_run") {
      const basesMap = { single: 1, double: 2, triple: 3, home_run: 4 };
      const r = advanceAllRunners(bases, slot, basesMap[type]);
      let finalBases = r.bases, finalRuns = r.runsScored, finalScorers = [...r.scorers], extraOuts = 0;
      let extraText = "";
      if (tail) {
        const atSide = tail[0], atSlot = Number(tail[1]), atResult = tail.slice(2, 4);
        const runnerName = (atSide === "A" ? awayLineup : homeLineup)[atSlot - 1].name;
        finalBases = [...finalBases];
        finalBases[2] = null;
        if (atResult === "SC") {
          finalRuns += 1;
          finalScorers.push(atSlot);
          extraText = ` ${fillTemplate(pickText(PLAY_CATALOG.extraBaseAttempt.success), { runner: runnerName })}`;
        } else {
          extraOuts = 1;
          extraText = ` ${fillTemplate(pickText(PLAY_CATALOG.extraBaseAttempt.fail), { runner: runnerName })}`;
        }
      }
      resultBases = finalBases; runsScored = finalRuns; scorerSlots = finalScorers; outsAdded = extraOuts;
      text = fillTemplate(pickText(PLAY_CATALOG.types[type].text), { batter: batterName })
        + scoringSuffix(namesFromSlots(r.scorers, battingLineup)) + extraText;
    } else if (type === "sac_fly") {
      const scorerSlot = bases[2];
      resultBases = [...bases];
      resultBases[2] = null;
      runsScored = 1; scorerSlots = [scorerSlot]; outsAdded = 1;
      text = fillTemplate(pickText(PLAY_CATALOG.types.sac_fly.text),
        { batter: batterName, scorer: battingLineup[scorerSlot - 1].name });
    } else if (type === "groundout") {
      const forced = forceAdvanceRunnersOnly(bases);
      const inningEndsHere = outs + 1 >= 3;
      runsScored = inningEndsHere ? 0 : forced.runsScored;
      scorerSlots = inningEndsHere ? [] : forced.scorers;
      resultBases = forced.bases; outsAdded = 1;
      const bucket = inningEndsHere ? "endsInning" : (bases[0] ? "runnersAdvance" : "routine");
      text = fillTemplate(pickText(PLAY_CATALOG.types.groundout.text[bucket]), { batter: batterName })
        + scoringSuffix(namesFromSlots(scorerSlots, battingLineup));
    } else { // double_play
      const forced = forceAdvanceRunnersOnly(bases);
      const dpBases = [...forced.bases];
      dpBases[1] = null;
      const dpEndsInning = outs + 2 >= 3;
      runsScored = dpEndsInning ? 0 : forced.runsScored;
      scorerSlots = dpEndsInning ? [] : forced.scorers;
      resultBases = dpBases; outsAdded = 2;
      const bucket = dpEndsInning ? "endsInning" : "continues";
      text = fillTemplate(pickText(PLAY_CATALOG.types.double_play.text[bucket]), { batter: batterName })
        + scoringSuffix(namesFromSlots(scorerSlots, battingLineup));
    }

    outs += outsAdded;
    bases = resultBases;
    if (side === "A") scoreA += runsScored; else scoreB += runsScored;

    decoded.push({
      half, inning, text, scoreA, scoreB,
      bases: bases.map(s => s === null ? null : battingLineup[s - 1].name)
    });
  }

  return decoded;
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
    playCode: encodeGamePlays(rawResult.plays),
    stats: rawResult.stats,
    pitchers: { away: findPitcher(awayTeam).name, home: findPitcher(homeTeam).name }
  };
}

// A tiny per-half-inning runs summary, only still needed to migrate saves
// from before the play-by-play cipher existed (compactGameHistory below) --
// new games never call this, since box-score.html just decodes playCode
// fresh instead.
function computeInningRuns(plays) {
  const inningRuns = {};
  let halfStartA = 0, halfStartB = 0, prevScoreA = 0, prevScoreB = 0;
  let lastHalf = null, lastInning = null;
  plays.forEach(play => {
    if (play.half !== lastHalf || play.inning !== lastInning) {
      halfStartA = prevScoreA;
      halfStartB = prevScoreB;
      lastHalf = play.half;
      lastInning = play.inning;
    }
    const key = `${play.half}-${play.inning}`;
    inningRuns[key] = play.half === "top" ? play.scoreA - halfStartA : play.scoreB - halfStartB;
    prevScoreA = play.scoreA;
    prevScoreB = play.scoreB;
  });
  return inningRuns;
}

// One-time (and self-repairing) migration for saves from before the
// play-by-play cipher existed: strips the old full play-by-play log back
// out of any already-saved game that isn't yours (those saves predate
// playCode entirely, so they can't be upgraded to it -- there's no way to
// recover which play type/batter slot produced an already-rendered
// sentence). Returns true if it actually changed anything, so callers know
// whether the save needs writing back out.
function compactGameHistory(save) {
  let changed = false;
  save.gameHistory.forEach(g => {
    const isYourGame = g.away === save.yourTeam || g.home === save.yourTeam;
    if (!isYourGame && g.plays) {
      if (!g.inningRuns) g.inningRuns = computeInningRuns(g.plays);
      if (!g.maxInning) g.maxInning = Math.max(...g.plays.map(p => p.inning));
      delete g.plays;
      changed = true;
    }
  });
  return changed;
}

// Simulates every game in one round. `teamsByName` is a { name: teamObject }
// lookup built from teams.json; `opponentGear` is the season save's gear
// map, merged onto each team's lineup (gear.js's buildGearedTeam) before
// simulating so opponent gear actually affects the game. Returns one entry
// per game with the raw engine result (needed for the live-reveal UI on
// your own game) alongside the already cipher-encoded history entry (ready
// to push into gameHistory).
function simulateRound(schedule, roundIndex, teamsByName, opponentGear) {
  return schedule[roundIndex].map(({ home, away }) => {
    const awayTeam = buildGearedTeam(teamsByName[away], opponentGear);
    const homeTeam = buildGearedTeam(teamsByName[home], opponentGear);
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
const ACCOLADE_PAYOUTS = { homeRun: 10, shutout: 50, noHitter: 150, cycle: 100, blowout: 25 };

// A win by this many runs or more counts as a blowout -- happens in
// roughly 1 in 10 games, so it's priced between the common home run
// bonus and the rarer shutout one.
const BLOWOUT_MARGIN = 7;

// Every crate opening rolls this many items, each an independent pull
// against the crate's odds table below (so two Commons, two Mythicals, or
// anything in between are all possible from the same crate).
const ITEMS_PER_CRATE = 2;

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
  },
  // Priced and tuned as a late-season "closing the gap before Elite" option,
  // not something meant to be a day-one buy -- meaningfully better than
  // Advanced's odds, but still leaves real room to miss.
  premium: {
    label: "Premium Crate",
    price: 1000,
    odds: { Common: 0.02, Uncommon: 0.08, Rare: 0.20, Epic: 0.30, Legendary: 0.32, Mythical: 0.08 }
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

  const margin = Math.abs(historyEntry.scoreAway - historyEntry.scoreHome);
  if (historyEntry.winner === yourTeam && margin >= BLOWOUT_MARGIN) {
    accolades.push({ type: "blowout", label: "Blowout Win", count: 1, bonus: ACCOLADE_PAYOUTS.blowout });
  }

  return accolades;
}

// The win/loss base is credited the instant a game is recorded (season.html,
// same moment as standings/history/currentRound) -- it doesn't depend on the
// reveal ever being opened, let alone finished, so there's nothing to lose
// by navigating away early.
function computeBasePayout(historyEntry, yourTeam) {
  return historyEntry.winner === yourTeam ? BASE_PAYOUTS.win : BASE_PAYOUTS.loss;
}

// Accolades only pay out if `watched` is true; otherwise they're returned
// separately as `forfeited`, so the UI can show what was earned alongside
// what was left on the table by skipping.
function computeAccoladePayout(historyEntry, yourTeam, yourLineupNames, watched) {
  const accolades = detectAccolades(historyEntry, yourTeam, yourLineupNames);
  if (watched) return { accolades, forfeited: [] };
  return { accolades: [], forfeited: accolades };
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

// --- Season-end bonus ---------------------------------------------------------
// A one-time payout once the season's final outcome is known: either the
// championship game resolves, or the player's own team fails to qualify.
// Three independent pieces -- team placement, total wins, and individual
// league-leaderboard finishes -- all computed from state that's already
// fully final by this point, so (like the base win/loss payout) none of it
// depends on anything being watched. The caller is responsible for only
// ever applying the result once; computeSeasonEndBonus itself is a pure
// read of already-settled save state, safe to call repeatedly.

const SEASON_END_PAYOUTS = {
  championship: 1000,
  runnerUp: 500,
  thirdPlace: 250,
  topTenTeam: 10,   // 4th-10th place
  perWin: 10,
  statTopTen: 10,
  statLeader: 30    // stacks on top of statTopTen for the same category
};

// Stats worth a season-end leaderboard bonus -- deliberately excludes
// plain counting stats (AB, BB, R, IP, hits allowed) that mostly just
// track playing time rather than being something worth leading the league
// in. `dir` "desc" means highest wins (e.g. HR); "asc" means lowest wins
// (e.g. batting strikeouts, ERA).
// `label` (not `key`) is what shows up in the payout breakdown -- matters
// for K specifically, since a pitcher bats too and can independently place
// in both the batting-strikeouts and pitching-strikeouts categories; using
// the bare key for both would make that look like the same bonus twice.
const BATTING_LEADER_STATS = [
  { key: "AVG", label: "AVG", dir: "desc" },
  { key: "HR", label: "HR", dir: "desc" },
  { key: "doubles", label: "2B", dir: "desc" },
  { key: "triples", label: "3B", dir: "desc" },
  { key: "K", label: "K (batting)", dir: "asc" }
];
const PITCHING_LEADER_STATS = [
  { key: "ERA", label: "ERA", dir: "asc" },
  { key: "K", label: "K (pitching)", dir: "desc" }
];

// One row per league player for a stat pool -- every batter across every
// team's lineup (pitchers included, since they bat too), or every team's
// one starting pitcher. Same shape leaders.html builds for display.
function battingLeaderRows(teams, seasonStats) {
  const rows = [];
  teams.forEach(team => {
    team.lineup.forEach(p => {
      const line = (seasonStats[p.name] || newStatLine()).batting;
      rows.push({
        name: p.name, team: team.name,
        AVG: battingAverage(line), HR: line.HR, doubles: line.doubles, triples: line.triples, K: line.K
      });
    });
  });
  return rows;
}
function pitchingLeaderRows(teams, seasonStats) {
  return teams.map(team => {
    const pitcher = findPitcher(team);
    const line = (seasonStats[pitcher.name] || newStatLine()).pitching;
    return { name: pitcher.name, team: team.name, ERA: era(line), K: line.K };
  });
}

// The value at the top-10 cutoff, and the single best value -- ties at
// either boundary all count (three players tied for 10th means 12 players
// clear the bar), matching how team placement below treats standings ties.
function topTenAndLeaderValue(rows, key, dir) {
  const values = rows.map(r => r[key]).sort((a, b) => dir === "asc" ? a - b : b - a);
  return { topTenValue: values[Math.min(9, values.length - 1)], leaderValue: values[0] };
}
function clearsBar(value, bar, dir) {
  return dir === "asc" ? value <= bar : value >= bar;
}

// Every league-leaderboard bonus your own roster earned this season: +10
// for each stat category a player lands in the league top 10 for, +30 more
// on top of that for each category they outright lead (leading always
// counts as clearing the top-10 bar too, so both stack for that category).
function computeStatBonuses(teams, seasonStats, yourLineupNames, yourPitcherName) {
  const battingRows = battingLeaderRows(teams, seasonStats);
  const pitchingRows = pitchingLeaderRows(teams, seasonStats);
  const lines = [];

  BATTING_LEADER_STATS.forEach(({ key, label, dir }) => {
    const { topTenValue, leaderValue } = topTenAndLeaderValue(battingRows, key, dir);
    battingRows.filter(r => yourLineupNames.includes(r.name)).forEach(r => {
      if (!clearsBar(r[key], topTenValue, dir)) return;
      const leader = clearsBar(r[key], leaderValue, dir);
      lines.push({ name: r.name, stat: label, leader, bonus: SEASON_END_PAYOUTS.statTopTen + (leader ? SEASON_END_PAYOUTS.statLeader : 0) });
    });
  });

  PITCHING_LEADER_STATS.forEach(({ key, label, dir }) => {
    const { topTenValue, leaderValue } = topTenAndLeaderValue(pitchingRows, key, dir);
    const r = pitchingRows.find(row => row.name === yourPitcherName);
    if (!r || !clearsBar(r[key], topTenValue, dir)) return;
    const leader = clearsBar(r[key], leaderValue, dir);
    lines.push({ name: r.name, stat: label, leader, bonus: SEASON_END_PAYOUTS.statTopTen + (leader ? SEASON_END_PAYOUTS.statLeader : 0) });
  });

  return { lines, total: lines.reduce((sum, l) => sum + l.bonus, 0) };
}

// Regular-season standings rank, treating a true tie (identical wins and
// run differential) as a shared rank rather than resolving it -- same
// "ties count" philosophy as the stat leaderboards above. Only used for the
// non-qualifying placement tiers below; the top two spots are decided by
// who actually plays (and wins) the championship game.
function standingsRank(standings, yourTeam) {
  const entries = Object.entries(standings).map(([name, rec]) => ({
    name, wins: rec.wins, diff: rec.runsFor - rec.runsAgainst
  }));
  entries.sort((a, b) => b.wins - a.wins || b.diff - a.diff);

  let rank = 1;
  for (let i = 0; i < entries.length; i++) {
    if (i > 0 && (entries[i].wins !== entries[i - 1].wins || entries[i].diff !== entries[i - 1].diff)) rank = i + 1;
    if (entries[i].name === yourTeam) return rank;
  }
  return entries.length;
}

function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`;
}

// Championship result decides the top two tiers; everyone else is priced
// off final standings position. Clipped at "3rd place" for the vanishingly
// rare case of a team tying a qualifying record but losing the (already
// random) tiebreak for the actual playoff spot -- keeps the top two payouts
// tied exclusively to actually playing (and winning) the championship game.
function computePlacementBonus(save) {
  if (save.playoff.wonLeague) return { label: "League Champion", bonus: SEASON_END_PAYOUTS.championship };
  if (save.playoff.yourTeamQualified) return { label: "Runner-Up", bonus: SEASON_END_PAYOUTS.runnerUp };

  const rank = Math.max(3, standingsRank(save.standings, save.yourTeam));
  if (rank === 3) return { label: "3rd Place", bonus: SEASON_END_PAYOUTS.thirdPlace };
  if (rank <= 10) return { label: `Finished ${ordinal(rank)}`, bonus: SEASON_END_PAYOUTS.topTenTeam };
  return { label: `Finished ${ordinal(rank)}`, bonus: 0 };
}

// The full season-end bonus breakdown. `teams` is teams.json's full team
// list (needed for every roster + every pitcher across the league, not
// just yourTeam's).
function computeSeasonEndBonus(save, teams) {
  const yourTeamObj = teams.find(t => t.name === save.yourTeam);
  const yourLineupNames = yourTeamObj.lineup.map(p => p.name);
  const yourPitcherName = findPitcher(yourTeamObj).name;

  const placement = computePlacementBonus(save);
  const winBonus = save.standings[save.yourTeam].wins * SEASON_END_PAYOUTS.perWin;
  const stats = computeStatBonuses(teams, save.seasonStats, yourLineupNames, yourPitcherName);

  return { placement, winBonus, stats: stats.lines, total: placement.bonus + winBonus + stats.total };
}
