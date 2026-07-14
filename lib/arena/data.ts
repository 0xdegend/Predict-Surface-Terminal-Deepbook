/**
 * lib/arena/data.ts — the Degen Arena data model + the two-level prize math.
 *
 * Degen Arena is Skew's faction competition (a PREVIEW — the roster below is
 * illustrative, the countdown is a real clock). The economics are the part that
 * has to be *honest*, because the whole feature is a payout mechanic:
 *
 *   1. Top traders APPLY to found a faction; traders JOIN one.
 *   2. Every faction earns a share of the season's DUSDC prize pool, split into
 *      two parts that encode the two rules the product promises:
 *        · BASE pool  — proportional to the faction's pooled Points, so raw
 *                       performance across the faction determines its cut.
 *        · BONUS pool — rank-weighted, so the TOP factions take an outsized
 *                       slice ("higher rank ⇒ higher share of the pool").
 *   3. Inside a faction, a member's cut of the faction's pool is their own
 *      share of the faction's Points. So your payout compounds both levels:
 *        memberPrize = (yourPoints / factionPoints) × faction.totalPool
 *
 * Everything here is PURE and deterministic (no Date, no Math.random at call
 * time) so the server render and the client hydrate to byte-identical numbers.
 */

/* ------------------------------------------------------------------ *
 * Deterministic helpers — a seeded PRNG so illustrative rosters are stable
 * per name (same seed ⇒ same figures ⇒ no hydration drift).
 * ------------------------------------------------------------------ */
function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A 0x-prefixed 64-hex string derived from a seed — only feeds WalletAvatar's
 *  deterministic identicon art, never an on-chain call. */
function seededAddr(seed: string): string {
  const rng = mulberry32(hashSeed(seed));
  const hex = '0123456789abcdef';
  let out = '0x';
  for (let i = 0; i < 64; i++) out += hex[Math.floor(rng() * 16)];
  return out;
}

/* ------------------------------------------------------------------ *
 * Season — number, label, and a real fixed UTC window so the hero clock
 * genuinely ticks down (mirrors the countdown pattern in rewards/shared).
 * ------------------------------------------------------------------ */
export const SEASON = {
  number: 2,
  label: 'Season 2',
  startMs: Date.UTC(2026, 6, 1, 0, 0, 0), //  1 Jul 2026
  endMs: Date.UTC(2026, 8, 1, 0, 0, 0), //  1 Sep 2026
} as const;

/* ------------------------------------------------------------------ *
 * The prize pool. Illustrative DUSDC, funded by the 1% Skew fee treasury
 * (the same funding story the Quests/Competitions pages already tell).
 *   BASE   — split by pooled Points (performance).
 *   BONUS  — split by faction rank (top factions take more).
 * ------------------------------------------------------------------ */
export const POOL_BASE = 36_000; // DUSDC — points-proportional
export const POOL_BONUS = 84_000; // DUSDC — rank-weighted
export const PRIZE_POOL = POOL_BASE + POOL_BONUS; // 120,000 DUSDC
const BONUS_DECAY = 0.82; // geometric rank weighting for the bonus pool

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */
export interface Member {
  addr: string; // deterministic — feeds WalletAvatar
  name: string;
  volume: number; // DUSDC traded this season
  points: number; // season Points (Skew's ranking metric)
  /** member's share of the faction's Points (0–1), and their projected cut. */
  share: number;
  prize: number; // DUSDC — memberShare × faction.totalPool
}

export interface Faction {
  id: string;
  name: string;
  handle: string; // X profile
  website?: string;
  memberSince: string; // display string
  hue: string; // accent tint for the faction's glyph/rail
  memberCount: number; // total members (roster below shows the top slice)
  members: Member[];
  /* derived */
  rank: number; // 1-based
  totalPoints: number; // whole faction (≥ Σ roster points; rest = unshown)
  totalVolume: number;
  basePool: number; // DUSDC
  bonusPool: number; // DUSDC
  totalPool: number; // basePool + bonusPool
  poolSharePct: number; // totalPool / PRIZE_POOL   (0–1)
  bonusSharePct: number; // bonusPool / POOL_BONUS   (0–1)  ← the "%" beside Bonus Pool
  baseDeltaPct: number; // tiny illustrative live drift on the base pool (0–1)
}

/** The connected-wallet stand-in (showcase). Mirrors the reference profile
 *  card: identity, faction membership, and a per-source Points breakdown. */
export interface You {
  handle: string;
  id: string; // e.g. "#742"
  addr: string;
  points: number;
  rank: number; // rank within the arena (illustrative)
  factionId: string;
  /** per-source contribution grid (Skew-native sources, not the ref's swaps). */
  stats: { label: string; count: number; points: number; hue: string }[];
}

/* ------------------------------------------------------------------ *
 * Seed data — faction meta + a name pool. Member figures are generated
 * deterministically from these so the tables look alive without 70 hand-typed
 * rows, while staying byte-stable across renders.
 * ------------------------------------------------------------------ */
interface FactionSeed {
  id: string;
  name: string;
  handle: string;
  website?: string;
  memberSince: string;
  hue: string;
  memberCount: number;
  topPoints: number; // #1 member's points; the roster decays from here
  topVolume: number; // #1 member's volume
  rosterSize: number;
  names: string[];
}

// Hues drawn from the app's icon palette (metric.tsx HUE) so factions feel
// native to the terminal rather than a stock rainbow.
const FACTION_SEEDS: FactionSeed[] = [
  {
    id: 'skew-syndicate',
    name: 'Skew Syndicate',
    handle: '@skew_syndicate',
    website: 'skew.trade',
    memberSince: 'Jan 14, 2026',
    hue: '#4dd6b0',
    memberCount: 41280,
    topPoints: 42_400_000,
    topVolume: 133_460_000,
    rosterSize: 9,
    names: ['pointfarmcapital', 'vol.sui', 'El33', 'theta.gang', 'MS1308', 'dwarfswift', 'Grzybomir', 'tibah', 'Mac'],
  },
  {
    id: 'theta-gang',
    name: 'Theta Gang',
    handle: '@theta_gang',
    website: 'thetagang.xyz',
    memberSince: 'Jan 21, 2026',
    hue: '#9d92e8',
    memberCount: 27030,
    topPoints: 31_800_000,
    topVolume: 96_120_000,
    rosterSize: 9,
    names: ['skewmaster', 'gammahunter', '0xnocturne', 'pico.sol', 'decaydealer', 'MasaShi', 'nightjar', 'ridgewalker', 'ceteris'],
  },
  {
    id: 'vol-vultures',
    name: 'Vol Vultures',
    handle: '@vol_vultures',
    memberSince: 'Feb 03, 2026',
    hue: '#6aa6e6',
    memberCount: 18770,
    topPoints: 24_100_000,
    topVolume: 71_540_000,
    rosterSize: 9,
    names: ['carrion.eth', 'ironcondor', 'wingspan', 'updraft', 'talon', 'kettle', 'scree', 'fenwick', 'lorne'],
  },
  {
    id: 'gamma-guild',
    name: 'Gamma Guild',
    handle: '@gamma_guild',
    website: 'gammaguild.io',
    memberSince: 'Feb 09, 2026',
    hue: '#d9a94e',
    memberCount: 13710,
    topPoints: 18_600_000,
    topVolume: 58_020_000,
    rosterSize: 9,
    names: ['squeezeplay', 'convexity', 'pinrisk', 'dealer.eth', 'flowstate', 'hedger', 'lattice', 'quill', 'orbit'],
  },
  {
    id: 'delta-forge',
    name: 'Delta Forge',
    handle: '@delta_forge',
    memberSince: 'Feb 17, 2026',
    hue: '#f0796b',
    memberCount: 11050,
    topPoints: 15_480_000,
    topVolume: 49_330_000,
    rosterSize: 9,
    names: ['anvil', 'sparks.sui', 'temper', 'ferrous', 'quench', 'bellows', 'ingot', 'smelt', 'draff'],
  },
  {
    id: 'nocturne-cartel',
    name: 'Nocturne Cartel',
    handle: '@nocturne',
    website: 'nocturne.gg',
    memberSince: 'Feb 24, 2026',
    hue: '#b08be0',
    memberCount: 8940,
    topPoints: 12_240_000,
    topVolume: 38_770_000,
    rosterSize: 9,
    names: ['duskrunner', 'moonless', 'gravel', 'obscura', 'lantern', 'shroud', 'vesper', 'umbra', 'noctis'],
  },
  {
    id: 'ludus-legion',
    name: 'Ludus Legion',
    handle: '@ludus_legion',
    memberSince: 'Mar 02, 2026',
    hue: '#5fc9c0',
    memberCount: 6620,
    topPoints: 9_360_000,
    topVolume: 29_540_000,
    rosterSize: 9,
    names: ['retiarius', 'murmillo', 'secutor', 'hoplomachus', 'thraex', 'velites', 'bestiarius', 'sagitta', 'galea'],
  },
  {
    id: 'degen-union',
    name: 'The Degen Union',
    handle: '@degen_union',
    website: 'degenunion.xyz',
    memberSince: 'Mar 11, 2026',
    hue: '#e0a36a',
    memberCount: 4930,
    topPoints: 6_180_000,
    topVolume: 21_010_000,
    rosterSize: 9,
    names: ['aped.eth', 'fullport', 'sizelord', 'rugcheck', 'liquidated', 'moonboy', 'jeeter', 'copium', 'wagmi.sui'],
  },
];

/* ------------------------------------------------------------------ *
 * Build — expand seeds into a rostered, ranked, prize-allocated arena.
 * Runs once at module load (pure ⇒ SSR-safe).
 * ------------------------------------------------------------------ */
function buildMembers(seed: FactionSeed): { members: Omit<Member, 'share' | 'prize'>[]; totalPoints: number; totalVolume: number } {
  const rng = mulberry32(hashSeed(seed.id));
  const members: Omit<Member, 'share' | 'prize'>[] = [];
  let decay = 1;
  for (let i = 0; i < seed.rosterSize; i++) {
    // Descending curve with a little jitter so ranks don't read as a formula.
    const jitter = 0.86 + rng() * 0.28;
    const points = Math.round(seed.topPoints * decay * jitter);
    // Volume loosely tracks points but with its own noise (some grind volume,
    // some snipe) — mirrors the ref where volume and XP rank differently.
    const volume = Math.round(seed.topVolume * decay * (0.7 + rng() * 0.9));
    members.push({ addr: seededAddr(`${seed.id}:${seed.names[i]}`), name: seed.names[i], points, volume });
    decay *= 0.62 + rng() * 0.14;
  }
  members.sort((a, b) => b.points - a.points);
  const rosterPoints = members.reduce((s, m) => s + m.points, 0);
  const rosterVolume = members.reduce((s, m) => s + m.volume, 0);
  // The shown roster is only the top slice — inflate the faction total to stand
  // in for the unshown long tail, so member shares realistically sum to < 100%.
  const totalPoints = Math.round(rosterPoints * 1.34);
  const totalVolume = Math.round(rosterVolume * 1.42);
  return { members, totalPoints, totalVolume };
}

function buildArena(): { factions: Faction[]; you: You } {
  // 1) Expand + rank by pooled Points.
  const staged = FACTION_SEEDS.map((seed) => ({ seed, ...buildMembers(seed) }));
  staged.sort((a, b) => b.totalPoints - a.totalPoints);

  const grandPoints = staged.reduce((s, f) => s + f.totalPoints, 0);
  const bonusWeights = staged.map((_, rank) => Math.pow(BONUS_DECAY, rank));
  const bonusWeightSum = bonusWeights.reduce((s, w) => s + w, 0);

  const factions: Faction[] = staged.map((f, i) => {
    // BASE — proportional to pooled Points (performance).
    const basePool = (POOL_BASE * f.totalPoints) / grandPoints;
    // BONUS — rank-weighted (top factions take an outsized slice).
    const bonusSharePct = bonusWeights[i] / bonusWeightSum;
    const bonusPool = POOL_BONUS * bonusSharePct;
    const totalPool = basePool + bonusPool;

    // Member cut = own share of faction Points × faction's total pool.
    const members: Member[] = f.members.map((m) => {
      const share = m.points / f.totalPoints;
      return { ...m, share, prize: share * totalPool };
    });

    // A tiny deterministic live-drift on the base pool (cosmetic "↗" flavour,
    // like the ref's base-pool delta) — never negative in the showcase.
    const baseDeltaPct = (0.00004 + (hashSeed(f.seed.id) % 40) / 1_000_00) * (1 - i * 0.03);

    return {
      id: f.seed.id,
      name: f.seed.name,
      handle: f.seed.handle,
      website: f.seed.website,
      memberSince: f.seed.memberSince,
      hue: f.seed.hue,
      memberCount: f.seed.memberCount,
      members,
      rank: i + 1,
      totalPoints: f.totalPoints,
      totalVolume: f.totalVolume,
      basePool,
      bonusPool,
      totalPool,
      poolSharePct: totalPool / PRIZE_POOL,
      bonusSharePct,
      baseDeltaPct,
    };
  });

  // The connected-wallet stand-in — a member of the #2 faction (mirrors the
  // reference, where "you" belong to the second-ranked faction).
  const home = factions[1] ?? factions[0];
  const stats = [
    { label: 'Positions', count: 214, points: 1_284_000, hue: '#4dd6b0' },
    { label: 'Ranges', count: 63, points: 486_000, hue: '#9d92e8' },
    { label: 'Referrals', count: 4, points: 92_000, hue: '#6aa6e6' },
    // Points from supplying the vault (LP → PLP). "Vault" over "Liquidity"/"PLP"
    // so it reads plainly and points back to the Vault page where you do it.
    { label: 'Vault', count: 11, points: 341_000, hue: '#d9a94e' },
  ];
  const you: You = {
    handle: '@0xskew',
    id: '#742',
    addr: seededAddr('you:0xskew'),
    points: stats.reduce((s, x) => s + x.points, 0),
    rank: 128,
    factionId: home.id,
    stats,
  };

  return { factions, you };
}

const ARENA = buildArena();
export const FACTIONS: Faction[] = ARENA.factions;
export const YOU: You = ARENA.you;

/** Look up a faction by id (drill-in view). */
export function getFaction(id: string | null): Faction | undefined {
  if (!id) return undefined;
  return FACTIONS.find((f) => f.id === id);
}

/** Arena-wide totals for the hero economics panel. */
export function arenaTotals() {
  return {
    factions: FACTIONS.length,
    members: FACTIONS.reduce((s, f) => s + f.memberCount, 0),
    points: FACTIONS.reduce((s, f) => s + f.totalPoints, 0),
    volume: FACTIONS.reduce((s, f) => s + f.totalVolume, 0),
  };
}
