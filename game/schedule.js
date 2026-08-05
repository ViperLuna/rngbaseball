// schedule.js
// -----------------------------------------------------------------------------
// Generates a double round-robin season schedule for a flat list of team
// names: every team plays every other team twice, once at each venue (58
// rounds x 15 games for the current 30-team league), no divisions/leagues,
// using the standard "circle method" for pairings so every matchup is
// covered exactly once per leg with no repeats and no team skipped in a
// round.
//
// Team order is shuffled first so the pairings/order differ every time a
// season is created. Leg 1's home/away side is picked randomly per pairing;
// leg 2 is an exact mirror of leg 1 with home/away swapped for each of the
// same pairings, which guarantees every team hosts each opponent exactly
// once and visits exactly once across the full season -- no greedy balance
// pass needed, the mirroring makes the split exact by construction.
//
// Exposes `generateSeasonSchedule(teamNames)`, returning an array of rounds:
//   [ [ {home, away}, ... 15 games ], ... 58 rounds ]
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
  const pairRounds = [];

  // Circle method: rotating[0] stays fixed, everyone else rotates around it.
  // Each round pairs position i with position n-1-i.
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      pairs.push([rotating[i], rotating[n - 1 - i]]);
    }
    pairRounds.push(pairs);
    const last = rotating.pop();
    rotating.splice(1, 0, last);
  }

  const leg1 = pairRounds.map(pairs => pairs.map(([t1, t2]) =>
    Math.random() < 0.5 ? { home: t1, away: t2 } : { home: t2, away: t1 }
  ));
  const leg2 = leg1.map(pairs => pairs.map(({ home, away }) => ({ home: away, away: home })));

  return [...leg1, ...leg2];
}
