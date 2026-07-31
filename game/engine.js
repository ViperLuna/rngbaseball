// engine.js
// -----------------------------------------------------------------------------
// The actual baseball simulation engine for rngbaseball. This file has no UI
// code in it at all -- it just exposes functions that index.html calls.
//
// What's in here:
//   - League-average outcome rates (real MLB baseline percentages)
//   - The log5 formula (blends a batter's rate and a pitcher's rate into one
//     probability for a specific matchup)
//   - resolvePlateAppearance(): decides what happens on a single at-bat
//     (strikeout, walk, hit, groundout, flyout, double play, sac fly, error)
//   - simulateGame(): plays a full 9-inning game between two teams and
//     returns the play-by-play log plus the final boxscore
//
// Everyone's stats are flat baseline (rating 50 on every stat) for now, since
// the items/gear system isn't wired in yet -- see getBatterRatings() and
// getPitcherRatings() below, that's the one spot to change later.
// -----------------------------------------------------------------------------

const LEAGUE = (() => {
  const K = 22.5;
  const BB = 9.5;
  const SINGLE = 14.5;
  const DOUBLE = 4.8;
  const TRIPLE = 0.2;
  const HR = 3.0;
  const hitTotal = SINGLE + DOUBLE + TRIPLE + HR; // 22.5
  const bipTotal = 100 - K - BB; // 68, "ball in play" share of all PAs
  return {
    K, BB, SINGLE, DOUBLE, TRIPLE, HR,
    HIT_ON_BIP: (hitTotal / bipTotal) * 100,       // ~33.09% of balls in play go for hits
    SINGLE_SHARE_OF_HITS: SINGLE / hitTotal,        // ~64.4%
    DOUBLE_SHARE_OF_HITS: DOUBLE / hitTotal,        // ~21.3%
    TRIPLE_SHARE_OF_HITS: TRIPLE / hitTotal,        // ~0.9%
    HR_SHARE_OF_HITS: HR / hitTotal,                // ~13.3%
    XBH_SHARE_OF_HITS: 1 - (SINGLE / hitTotal),     // ~35.6%, doubles+triples+HR
    GB_SHARE_OF_OUTS: 44,                           // groundball share of batted-ball outs
    ERROR_RATE: 1.5                                 // flat passive trait, % of balls in play
  };
})();

const DP_CHANCE = 0.12;   // conditional chance of turning a double play when eligible (runner on 1st, <2 outs)
const STAT_CAP = 25;      // matches the item builder's per-item cap

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Converts a 1-99 player rating into a real-world rate (percentage), where
// rating 50 always lands exactly on the league average. `slope` controls how
// many percentage points the rate shifts per rating point; `invert` flips the
// direction (used for stats where a higher rating means a *lower* rate, like
// Contact reducing strikeouts).
function ratingToRate(rating, leagueAvgPct, slope, invert) {
  const delta = (rating - 50) * slope;
  const rate = invert ? leagueAvgPct - delta : leagueAvgPct + delta;
  return clamp(rate, 0.5, 75);
}

// The log5 formula (Bill James): blends a batter's rate and a pitcher's rate
// for the same event into the actual probability for this specific matchup,
// anchored against the league-average rate for that event. All three inputs
// are fractions (0-1), not percentages.
function log5(batterRate, pitcherRate, leagueAvg) {
  const num = (batterRate * pitcherRate) / leagueAvg;
  const denom = num + ((1 - batterRate) * (1 - pitcherRate)) / (1 - leagueAvg);
  return num / denom;
}

// Placeholder rating providers -- everyone is flat baseline until the
// items/gear system gets wired in. Swap these out later to apply a player's
// equipped item modifiers on top of a base rating.
function getBatterRatings(player) {
  return { contact: 50, power: 50, discipline: 50, battedBallTendency: 50 };
}
function getPitcherRatings(player) {
  return { stuff: 50, control: 50, contactSuppression: 50, battedBallTendency: 50 };
}

function rollStrikeout(batterRatings, pitcherRatings) {
  const batterRate = ratingToRate(batterRatings.contact, LEAGUE.K, 0.28, true) / 100;
  const pitcherRate = ratingToRate(pitcherRatings.stuff, LEAGUE.K, 0.28, false) / 100;
  const p = log5(batterRate, pitcherRate, LEAGUE.K / 100);
  return Math.random() < p;
}

// The walk check only ever runs on plate appearances that already survived
// the strikeout check, so the anchor has to be the *conditional* rate (walks
// as a share of non-strikeout PAs), not the raw league-wide 9.5% -- otherwise
// the walk check under-fires relative to how often it's actually reached.
const BB_CONDITIONAL_ANCHOR = (LEAGUE.BB / (100 - LEAGUE.K)) * 100;

function rollWalk(batterRatings, pitcherRatings) {
  const batterRate = ratingToRate(batterRatings.discipline, BB_CONDITIONAL_ANCHOR, 0.14, false) / 100;
  const pitcherRate = ratingToRate(pitcherRatings.control, BB_CONDITIONAL_ANCHOR, 0.14, true) / 100;
  const p = log5(batterRate, pitcherRate, BB_CONDITIONAL_ANCHOR / 100);
  return Math.random() < p;
}

function rollError() {
  return Math.random() < LEAGUE.ERROR_RATE / 100;
}

function rollHitOnBallInPlay(batterRatings, pitcherRatings) {
  const batterRate = ratingToRate(batterRatings.power, LEAGUE.HIT_ON_BIP, 0.30, false) / 100;
  const pitcherRate = ratingToRate(pitcherRatings.contactSuppression, LEAGUE.HIT_ON_BIP, 0.30, true) / 100;
  return Math.random() < log5(batterRate, pitcherRate, LEAGUE.HIT_ON_BIP / 100);
}

// Given it's a hit, decide single vs. an extra-base hit, then which kind.
function rollHitType(batterRatings, pitcherRatings) {
  const xbhLeague = LEAGUE.XBH_SHARE_OF_HITS * 100;
  const batterRate = ratingToRate(batterRatings.power, xbhLeague, 0.35, false) / 100;
  const pitcherRate = ratingToRate(pitcherRatings.contactSuppression, xbhLeague, 0.35, true) / 100;
  const isXBH = Math.random() < log5(batterRate, pitcherRate, xbhLeague / 100);

  if (!isXBH) return "single";

  // Split the extra-base hit into 2B/3B/HR using their fixed relative shares.
  const roll = Math.random() * LEAGUE.XBH_SHARE_OF_HITS;
  if (roll < LEAGUE.HR_SHARE_OF_HITS) return "home_run";
  if (roll < LEAGUE.HR_SHARE_OF_HITS + LEAGUE.TRIPLE_SHARE_OF_HITS) return "triple";
  return "double";
}

function rollGroundballOrFlyball(batterRatings, pitcherRatings) {
  const league = LEAGUE.GB_SHARE_OF_OUTS;
  const batterRate = ratingToRate(batterRatings.battedBallTendency, league, 0.25, false) / 100;
  const pitcherRate = ratingToRate(pitcherRatings.battedBallTendency, league, 0.25, false) / 100;
  return Math.random() < log5(batterRate, pitcherRate, league / 100) ? "groundout" : "flyout";
}

// --- Baserunner state -------------------------------------------------------
// bases = [first, second, third], each either null or a runner name string.

function emptyBases() {
  return [null, null, null];
}

// Advance every existing runner by `numBases`, then place the batter.
// Used for hits, where the rule is "everyone moves up by the hit's base
// count," not just forced runners. Returns the names of anyone who scored
// so the play-by-play text can announce them.
function advanceAllRunners(bases, batterName, numBases) {
  const scorers = [];
  const newBases = emptyBases();
  for (let i = 2; i >= 0; i--) {
    if (bases[i] === null) continue;
    const newPos = i + numBases;
    if (newPos >= 3) scorers.push(bases[i]);
    else newBases[newPos] = bases[i];
  }
  const batterPos = numBases - 1;
  if (batterPos >= 3) scorers.push(batterName);
  else newBases[batterPos] = batterName;
  return { bases: newBases, runsScored: scorers.length, scorers };
}

// Force-advance runners exactly one base, cascading from first base outward,
// only moving a runner if the base behind them is being filled, and placing
// the batter on first. Used for walks and errors, where the batter actually
// reaches base safely. NOT for groundouts/double plays -- see
// forceAdvanceRunnersOnly() below for those, where the batter is out.
function forceAdvance(bases, batterName) {
  const newBases = [...bases];
  if (newBases[0] === null) {
    newBases[0] = batterName;
    return { bases: newBases, runsScored: 0, scorers: [] };
  }
  // first is occupied, so the runner there is forced to second
  if (newBases[1] === null) {
    newBases[1] = newBases[0];
    newBases[0] = batterName;
    return { bases: newBases, runsScored: 0, scorers: [] };
  }
  // first and second occupied, runner on second is forced to third
  if (newBases[2] === null) {
    newBases[2] = newBases[1];
    newBases[1] = newBases[0];
    newBases[0] = batterName;
    return { bases: newBases, runsScored: 0, scorers: [] };
  }
  // bases loaded, forced runner from third scores
  const scorer = newBases[2];
  newBases[2] = newBases[1];
  newBases[1] = newBases[0];
  newBases[0] = batterName;
  return { bases: newBases, runsScored: 1, scorers: [scorer] };
}

// Same cascade as forceAdvance(), but for plays where the batter is retired
// (a groundout, or the batter's half of a double play) rather than reaching
// base -- so first base is left empty instead of being occupied by the
// batter's name. Preceding forced runners still advance normally.
function forceAdvanceRunnersOnly(bases) {
  if (bases[0] === null) {
    return { bases: [...bases], runsScored: 0, scorers: [] };
  }
  if (bases[1] === null) {
    return { bases: [null, bases[0], bases[2]], runsScored: 0, scorers: [] };
  }
  if (bases[2] === null) {
    return { bases: [null, bases[0], bases[1]], runsScored: 0, scorers: [] };
  }
  // bases loaded, forced runner from third scores, first base stays empty
  const scorer = bases[2];
  return { bases: [null, bases[0], bases[1]], runsScored: 1, scorers: [scorer] };
}

// Builds the "X scores!" (or "X and Y score!") suffix to append to a play's
// text whenever the play produced any runs outside the sac-fly case (which
// already announces its own scorer inline).
function scoringSuffix(scorers) {
  if (scorers.length === 0) return "";
  if (scorers.length === 1) return ` ${scorers[0]} scores!`;
  const last = scorers[scorers.length - 1];
  const rest = scorers.slice(0, -1).join(", ");
  return ` ${rest} and ${last} score!`;
}

// --- Plate appearance resolution --------------------------------------------

function resolvePlateAppearance(batter, pitcher, bases, outs) {
  const batterRatings = getBatterRatings(batter);
  const pitcherRatings = getPitcherRatings(pitcher);

  if (rollStrikeout(batterRatings, pitcherRatings)) {
    return { type: "strikeout", bases, outsAdded: 1, runsScored: 0, scorers: [],
      text: `${batter.name} strikes out.` };
  }

  if (rollWalk(batterRatings, pitcherRatings)) {
    const result = forceAdvance(bases, batter.name);
    return { type: "walk", bases: result.bases, outsAdded: 0, runsScored: result.runsScored,
      scorers: result.scorers,
      text: `${batter.name} draws a walk.${scoringSuffix(result.scorers)}` };
  }

  if (rollHitOnBallInPlay(batterRatings, pitcherRatings)) {
    const hitType = rollHitType(batterRatings, pitcherRatings);
    const basesMap = { single: 1, double: 2, triple: 3, home_run: 4 };
    const result = advanceAllRunners(bases, batter.name, basesMap[hitType]);
    const labels = { single: "singles", double: "doubles", triple: "triples", home_run: "homers" };
    return { type: hitType, bases: result.bases, outsAdded: 0, runsScored: result.runsScored,
      scorers: result.scorers,
      text: `${batter.name} ${labels[hitType]}.${scoringSuffix(result.scorers)}` };
  }

  // What would otherwise be an out has a small flat chance of being an error
  // instead -- errors are a passive trait, unaffected by ratings or items.
  if (rollError()) {
    const result = forceAdvance(bases, batter.name);
    return { type: "error", bases: result.bases, outsAdded: 0, runsScored: result.runsScored,
      scorers: result.scorers,
      text: `${batter.name} reaches on an error.${scoringSuffix(result.scorers)}` };
  }

  // Out on a ball in play.
  const shape = rollGroundballOrFlyball(batterRatings, pitcherRatings);

  if (shape === "flyout") {
    // Sac fly rule: runner on third, fewer than 2 outs, run scores automatically.
    if (bases[2] !== null && outs < 2) {
      const scorer = bases[2];
      const newBases = [...bases];
      newBases[2] = null;
      return { type: "sac_fly", bases: newBases, outsAdded: 1, runsScored: 1, scorers: [scorer],
        text: `${batter.name} hits a sac fly. ${scorer} scores!` };
    }
    return { type: "flyout", bases, outsAdded: 1, runsScored: 0, scorers: [],
      text: `${batter.name} flies out.` };
  }

  // Groundout: figure out forced advancement first, then decide if it's a
  // plain out or a double play (the common "21" case: runner on first,
  // fewer than 2 outs, defense targets second then relays to first). The
  // batter is out in both cases, so use forceAdvanceRunnersOnly() -- not
  // forceAdvance(), which would incorrectly leave the batter standing on
  // first as if they'd reached safely.
  const dpEligible = bases[0] !== null && outs < 2;
  const forced = forceAdvanceRunnersOnly(bases);

  if (dpEligible && Math.random() < DP_CHANCE) {
    // The runner forced from first to second is also retired; everyone
    // else who was forced still completes their advance safely.
    const dpBases = [...forced.bases];
    dpBases[1] = null;
    const dpEndsInning = outs + 2 >= 3;
    // A run doesn't count if the inning-ending out is a force play (the
    // batter or a preceding runner being forced out negates any run scored
    // on the same play), so nullify it here rather than just in the text.
    const dpRuns = dpEndsInning ? 0 : forced.runsScored;
    const dpScorers = dpEndsInning ? [] : forced.scorers;
    return { type: "double_play", bases: dpBases, outsAdded: 2, runsScored: dpRuns,
      scorers: dpScorers,
      text: `${batter.name} grounds into a double play${dpEndsInning ? " to end the inning." : "."}${scoringSuffix(dpScorers)}` };
  }

  const inningEnds = outs + 1 >= 3;
  const groundoutRuns = inningEnds ? 0 : forced.runsScored;
  const groundoutScorers = inningEnds ? [] : forced.scorers;
  let groundoutText;
  if (inningEnds) {
    groundoutText = `${batter.name} grounds out to end the inning.`;
  } else if (bases[0]) {
    groundoutText = `${batter.name} grounds out, runners advance.`;
  } else {
    groundoutText = `${batter.name} grounds out, batter out at first.`;
  }
  return { type: "groundout", bases: forced.bases, outsAdded: 1, runsScored: groundoutRuns,
    scorers: groundoutScorers,
    text: `${groundoutText}${scoringSuffix(groundoutScorers)}` };
}

// --- Per-player stat tracking ------------------------------------------------
// Deliberately basic -- counting stats only, enough to derive AVG and ERA.
// No earned-vs-unearned distinction (every run allowed counts against the
// pitcher); that's a level of detail this game isn't trying to model.

function newStatLine() {
  return {
    batting: { AB: 0, H: 0, doubles: 0, triples: 0, HR: 0, BB: 0, K: 0, R: 0 },
    pitching: { outs: 0, H: 0, BB: 0, K: 0, R: 0 }
  };
}

function ensurePlayer(stats, name) {
  if (!stats[name]) stats[name] = newStatLine();
  return stats[name];
}

const HIT_TYPES = { single: null, double: "doubles", triple: "triples", home_run: "HR" };

// Updates the shared stats accumulator with the outcome of one plate
// appearance. `battingCountsAsAtBat` follows official scoring: walks and
// sac flies aren't at-bats, everything else (including reaching on an
// error, which isn't a hit) is.
function recordPlateAppearance(stats, batterName, pitcherName, result) {
  const batting = ensurePlayer(stats, batterName).batting;
  const pitching = ensurePlayer(stats, pitcherName).pitching;

  pitching.outs += result.outsAdded;

  if (result.type === "walk") {
    batting.BB++;
    pitching.BB++;
  } else if (result.type === "strikeout") {
    batting.AB++;
    batting.K++;
    pitching.K++;
  } else if (result.type === "sac_fly") {
    // not an at-bat, not a hit, just an out (and the run is handled below)
  } else if (HIT_TYPES.hasOwnProperty(result.type)) {
    batting.AB++;
    batting.H++;
    pitching.H++;
    const extraBaseField = HIT_TYPES[result.type];
    if (extraBaseField) batting[extraBaseField]++;
  } else {
    // error, groundout, flyout, double_play -- an at-bat, not a hit
    batting.AB++;
  }

  if (result.scorers && result.scorers.length > 0) {
    for (const name of result.scorers) {
      ensurePlayer(stats, name).batting.R++;
    }
    pitching.R += result.scorers.length;
  }
}

function battingAverage(line) {
  return line.AB > 0 ? line.H / line.AB : 0;
}
function era(line) {
  const ip = line.outs / 3;
  return ip > 0 ? (line.R * 9) / ip : 0;
}

// --- Half-inning / full game simulation -------------------------------------

// `walkOffTarget`, when given, is "how many runs the batting team needs to
// score this half-inning to take the lead." The instant they reach it, the
// half-inning (and the game) ends immediately -- no need to finish the 3
// outs. Only relevant for the home team batting in the 9th or later.
//
// `plays` is a shared, flat, chronological array that every play across the
// whole game gets pushed onto, each entry carrying a snapshot of the score
// and stats *as of that play*. The game itself is still fully computed
// instantly and deterministically here -- `plays` just gives the UI enough
// per-play detail to animate a paced reveal afterward (play log, box score,
// and stats pane all updating together) without needing to touch this
// simulation logic at all.
//
// `errors` is a shared { A, B } counter of errors charged to each team's
// fielders (not the batting team), for the box score's E column.
//
// Real walk-off rule: the game ends the instant the winning run scores, so
// any other runner who'd also cross the plate on the same play does NOT
// get credited -- even though they're clearly about to score too -- except
// on a home run, where the official exception for a fair ball leaving the
// park lets the batter and everyone else score in full. This caps a play's
// runsScored/scorers/text down to just what's needed to reach the target
// when that's fewer than the play naturally produced.
function applyWalkOffCap(result, runsSoFar, walkOffTarget) {
  if (walkOffTarget === null || result.type === "home_run" || result.scorers.length === 0) return result;
  const neededRuns = walkOffTarget - runsSoFar;
  if (result.scorers.length <= neededRuns) return result;

  const cappedScorers = result.scorers.slice(0, neededRuns);
  const oldSuffix = scoringSuffix(result.scorers);
  const newSuffix = scoringSuffix(cappedScorers);
  return {
    ...result,
    runsScored: neededRuns,
    scorers: cappedScorers,
    text: oldSuffix ? result.text.slice(0, result.text.length - oldSuffix.length) + newSuffix : result.text
  };
}

function simulateHalfInning(battingTeam, pitcher, lineupState, walkOffTarget, stats, plays, inning, half, scoreRef, fieldingTeamLetter, errors) {
  let outs = 0;
  let bases = emptyBases();
  let runs = 0;
  const log = [];

  while (outs < 3) {
    const batter = battingTeam.lineup[lineupState.index];
    const result = applyWalkOffCap(resolvePlateAppearance(batter, pitcher, bases, outs), runs, walkOffTarget);

    outs += result.outsAdded;
    runs += result.runsScored;
    bases = result.bases;
    log.push(result.text);
    recordPlateAppearance(stats, batter.name, pitcher.name, result);
    if (result.type === "error") errors[fieldingTeamLetter]++;
    lineupState.index = (lineupState.index + 1) % battingTeam.lineup.length;

    if (half === "top") scoreRef.A += result.runsScored;
    else scoreRef.B += result.runsScored;

    plays.push({
      half, inning, text: result.text,
      scoreA: scoreRef.A, scoreB: scoreRef.B,
      stats: JSON.parse(JSON.stringify(stats)),
      errors: { ...errors }
    });

    if (walkOffTarget !== null && runs >= walkOffTarget) {
      log.push("Walk-off! The game ends here.");
      plays.push({
        half, inning, text: "Walk-off! The game ends here.",
        scoreA: scoreRef.A, scoreB: scoreRef.B,
        stats: JSON.parse(JSON.stringify(stats)),
        errors: { ...errors }
      });
      break;
    }
  }

  return { runs, log };
}

function findPitcher(team) {
  return team.lineup.find(p => p.position === "P");
}

function simulateGame(teamA, teamB) {
  const lineupStateA = { index: 0 };
  const lineupStateB = { index: 0 };
  const pitcherA = findPitcher(teamA);
  const pitcherB = findPitcher(teamB);
  const stats = {};
  teamA.lineup.forEach(p => ensurePlayer(stats, p.name));
  teamB.lineup.forEach(p => ensurePlayer(stats, p.name));

  const innings = [];
  const plays = [];
  const errors = { A: 0, B: 0 };
  const scoreRef = { A: 0, B: 0 };
  let inning = 1;

  while (true) {
    const top = simulateHalfInning(teamA, pitcherB, lineupStateA, null, stats, plays, inning, "top", scoreRef, "B", errors);

    // From the 9th inning on, the home team doesn't bat at all if they're
    // already ahead after the top half -- the game's already decided.
    const homeAlreadyWinning = inning >= 9 && scoreRef.B > scoreRef.A;
    let bottom = { runs: 0, log: ["(not needed -- game already decided)"] };
    if (!homeAlreadyWinning) {
      const walkOffTarget = inning >= 9 ? (scoreRef.A - scoreRef.B) + 1 : null;
      bottom = simulateHalfInning(teamB, pitcherA, lineupStateB, walkOffTarget, stats, plays, inning, "bottom", scoreRef, "A", errors);
    }

    innings.push({ inning, top, bottom });

    // The game can't end in a tie -- keep playing extra innings until
    // someone's actually ahead once the 9th (or later) is complete.
    if (inning >= 9 && scoreRef.A !== scoreRef.B) break;
    inning++;
  }

  const scoreA = scoreRef.A;
  const scoreB = scoreRef.B;

  return {
    teamA: teamA.name,
    teamB: teamB.name,
    scoreA,
    scoreB,
    innings,
    plays,
    errors,
    winner: scoreA > scoreB ? teamA.name : teamB.name,
    stats
  };
}
