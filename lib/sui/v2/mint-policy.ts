/**
 * lib/sui/v2/mint-policy.ts — the odds band the protocol will actually mint.
 *
 * `strike_exposure_config::assert_mint_probability_policy` rejects any mint whose entry
 * probability sits outside [min_entry_probability, max_entry_probability]. Every quoting
 * surface has to gate on the SAME band, because a bet outside it is not a bad price, it is
 * a transaction the chain refuses.
 *
 * WHY THIS MODULE EXISTS. The band used to be the literal `> 0.005 && < 0.995`, copied
 * across seven call sites. The chain enforces 1% to 99%, so those literals opened two dead
 * zones (0.5% to 1%, and 99% to 99.5%) where the app quoted a bet happily, let the trader
 * fund it, and the WALLET was the first thing to say no: on 2026-09-17 a $130.72 bet on
 * 9-12 reached the signature prompt and dry-ran as `MoveAbort ... assert_mint_probability_
 * policy`. A trader reads that as the app being broken, and they are not wrong.
 *
 * The band is per market (`min_entry_probability` / `max_entry_probability` on the market
 * object, carried on the `MarketCreated` event), so it is read from the market rather than
 * assumed. FALLBACK_BAND is only for a caller with no market in hand, and it is the live
 * 9-12 protocol template, verified on chain 2026-09-17 by calling
 * `protocol_config::strike_exposure_template_config` and reading both getters off it.
 *
 * NOTE for the next deployment: 9-12 moved these values OFF `expiry_market` (the getters no
 * longer exist there) and onto `strike_exposure_config`, reachable via the protocol config.
 * `onchainMarketState` therefore cannot read them and fills both fields from its hardcoded
 * TEMPLATE, which happens to match today. If a redeploy widens or narrows the band, the
 * markets built by that path will still claim the old one. Re-verify at every cutover.
 */
import { toFloat } from '@/config/scale';

/** The band a market carries. Both values are 1e9-scaled probabilities on chain. */
export interface ProbabilityBand {
  /** Lowest mintable entry probability, as a fraction (0.01 = 1%). */
  min: number;
  /** Highest mintable entry probability, as a fraction (0.99 = 99%). */
  max: number;
}

/** The 9-12 protocol template, used only when no market is available. */
export const FALLBACK_BAND: ProbabilityBand = { min: 0.01, max: 0.99 };

type BandSource = { min_entry_probability?: string | number; max_entry_probability?: string | number } | undefined;

/**
 * The band this market will mint in. A market missing either bound falls back rather than
 * widening: quoting a bet the chain refuses is worse than declining one it would have taken.
 */
export function mintProbabilityBand(market?: BandSource): ProbabilityBand {
  const min = market?.min_entry_probability != null ? toFloat(market.min_entry_probability) : NaN;
  const max = market?.max_entry_probability != null ? toFloat(market.max_entry_probability) : NaN;
  return {
    min: Number.isFinite(min) && min > 0 ? min : FALLBACK_BAND.min,
    max: Number.isFinite(max) && max > 0 ? max : FALLBACK_BAND.max,
  };
}

/**
 * Whether a mint at these odds would be admitted. Exclusive at both ends: the chain asserts
 * a strict comparison, so a probability exactly on the bound is not mintable.
 */
export function probabilityMintable(entryProb: number, market?: BandSource): boolean {
  const { min, max } = mintProbabilityBand(market);
  return entryProb > min && entryProb < max;
}
