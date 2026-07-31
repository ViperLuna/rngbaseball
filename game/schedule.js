// schedule.js
// -----------------------------------------------------------------------------
// Generates a single round-robin season schedule for a flat list of team
// names: every team plays every other team exactly once (29 rounds x 15
// games for the current 30-team league), no divisions/leagues, using the
// standard "circle method" for pairings so every matchup is covered exactly
// once with no repeats and no team skipped in a round.
//
// Team order is shuffled first so the pairings/order differ every time a
// season is created. Home/away is then assigned with a simple greedy
// balance pass: for each game, whichever of the two teams has fewer home
// games so far gets this one (ties broken randomly). That keeps every team
// as close to a 14/15 home/away split as the odd 29-game schedule allows,
// without needing any special-casing for a "your team" or any other team.
//
// Exposes `generateSeasonSchedule(teamNames)`, returning an array of rounds:
//   [ [ {home, away}, ... 15 games ], ... 29 rounds ]
// -----------------------------------------------------------------------------

function shuffleTeams(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateSeasonSchedule(teamNames) {
  const rotating = shuffleTeams(teamNames);
  const n = rotating.length;
  const rounds = [];

  // Circle method: rotating[0] stays fixed, everyone else rotates around it.
  // Each round pairs position i with position n-1-i.
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      pairs.push([rotating[i], rotating[n - 1 - i]]);
    }
    rounds.push(pairs);
    const last = rotating.pop();
    rotating.splice(1, 0, last);
  }

  const homeCounts = {};
  teamNames.forEach(name => homeCounts[name] = 0);

  return rounds.map(pairs => pairs.map(([t1, t2]) => {
    let home, away;
    if (homeCounts[t1] < homeCounts[t2]) { home = t1; away = t2; }
    else if (homeCounts[t2] < homeCounts[t1]) { home = t2; away = t1; }
    else if (Math.random() < 0.5) { home = t1; away = t2; }
    else { home = t2; away = t1; }
    homeCounts[home]++;
    return { home, away };
  }));
}
