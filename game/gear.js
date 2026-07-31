// gear.js
// -----------------------------------------------------------------------------
// Generates opponent gear loadouts -- the player's own team's gear is a
// separate system (equipped from the store-pulled inventory, not built yet).
// Every opponent player (anyone not on the player's own team) gets one
// gacha roll per season: first whether they're geared at all, then which
// rarity, per OPPONENT_GEAR_RAMP below. Both of a player's applicable slots
// (Bat+Helmet for a batter, Hat+Glove for a pitcher -- pitchers never get
// batting gear here, matching how the engine treats them) draw from that
// same rarity tier, so a player reads as "a Legendary guy," not a mismatched
// grab-bag. This re-rolls fresh every time a new season is created.
//
// Opponents only ever pull from items with a positive stat value -- a
// negative-value item existing in the data at all is a real risk for the
// player's own store pulls, but an opponent's rarity tier is meant to be a
// guarantee (Elite is supposed to be the hardest league, full stop), so a
// cursed roll would undercut that.
//
// No dependency on engine.js/schedule.js -- just plain data + Math.random().
// Any page building/using a season (team-select.html, season.html) should
// load this before season.js, since initializeSeason()/simulateRound() call
// into generateOpponentGear()/buildGearedTeam() below.
// -----------------------------------------------------------------------------

const OPPONENT_GEAR_RAMP = {
  Rookie: { coverage: 0, odds: {} },
  A: { coverage: 0.35, odds: { Common: 0.70, Uncommon: 0.30 } },
  AA: { coverage: 0.55, odds: { Common: 0.35, Uncommon: 0.45, Rare: 0.20 } },
  AAA: { coverage: 0.75, odds: { Uncommon: 0.30, Rare: 0.45, Epic: 0.20, Legendary: 0.05 } },
  Majors: { coverage: 1.0, odds: { Rare: 0.15, Epic: 0.45, Legendary: 0.35, Mythical: 0.05 } },
  Elite: { coverage: 1.0, odds: { Mythical: 1.0 } }
};

function rollOpponentRarity(odds) {
  const roll = Math.random();
  let cumulative = 0;
  for (const rarity of Object.keys(odds)) {
    cumulative += odds[rarity];
    if (roll < cumulative) return rarity;
  }
  return Object.keys(odds)[0];
}

// Many items carry a second stat as a tradeoff (e.g. +3 Power / -2 Contact),
// so "positive" has to mean every stat on the item, not just the first one
// -- otherwise a mixed item could sneak a hidden downside into a guaranteed
// opponent rarity tier.
function pickPositiveItem(items, rarity, slot) {
  const pool = items.filter(i => i.rarity === rarity && i.slot === slot && i.stats.every(s => s.value > 0));
  return pool[Math.floor(Math.random() * pool.length)];
}

// Returns null (ungeared) or a { slot: item } object covering the player's
// two applicable slots for their role.
function rollOpponentGearForPlayer(position, league, items) {
  const tier = OPPONENT_GEAR_RAMP[league];
  if (Math.random() >= tier.coverage) return null;

  const rarity = rollOpponentRarity(tier.odds);
  const slots = position === "P" ? ["Hat", "Glove"] : ["Bat", "Helmet"];
  const gear = {};
  slots.forEach(slot => {
    const item = pickPositiveItem(items, rarity, slot);
    if (item) gear[slot] = item;
  });
  return gear;
}

// Builds a { playerName: gear } map for every player NOT on yourTeam across
// the full 30-team league. `items` is items.json's items array.
function generateOpponentGear(teams, yourTeam, league, items) {
  const gearMap = {};
  teams.forEach(team => {
    if (team.name === yourTeam) return;
    team.lineup.forEach(p => {
      const gear = rollOpponentGearForPlayer(p.position, league, items);
      if (gear) gearMap[p.name] = gear;
    });
  });
  return gearMap;
}

// Merges a season's opponentGear map onto a copy of a team's lineup, ready
// to hand to engine.js's simulateGame(). Players missing from the map (the
// player's own team, or an opponent who rolled ungeared) are left with no
// `gear` field -- getBatterRatings()/getPitcherRatings() treat that as
// baseline, same as any lineup fetched straight from teams.json.
function buildGearedTeam(team, gearMap) {
  return {
    name: team.name,
    lineup: team.lineup.map(p => ({ ...p, gear: gearMap[p.name] || null }))
  };
}
