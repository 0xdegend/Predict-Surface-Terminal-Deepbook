/**
 * How the two trade modes are NAMED and DRAWN — one source, because two controls
 * describe them: the Easy ⇄ Pro toggle in the header and the first-visit
 * experience dialog. They were carrying their own copies of the icons, which is exactly
 * how a pair like this drifts.
 *
 * ICON CHOICE. The old pair was a lightning bolt and settings sliders: the two most
 * generic glyphs in any startup UI, and neither says anything about a trading screen.
 * These are literal instead.
 *
 *   Easy → arrows up and down. That IS the product: one decision, two directions.
 *   Pro  → a panelled workspace, which is literally what that screen is (surface,
 *          market picker, ticket rail).
 *
 * Both are otherwise unused in the app, so neither picks up a second meaning. Candidates
 * that read well but were already spoken for: `LuChartSpline` (the Odds rail tab),
 * `LuChartCandlestick` (BTC Options), `LuLayers` and `LuActivity` (used throughout).
 */
import { LuArrowUpDown, LuPanelsTopLeft } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import type { TradeView } from '@/lib/store/trade-view-store';

export const TRADE_MODE_ICON: Record<TradeView, IconType> = {
  simple: LuArrowUpDown,
  advanced: LuPanelsTopLeft,
};

/**
 * The mode's name, as it appears on every control that offers the choice.
 *
 * The KEYS are not the labels, and should stay `simple` / `advanced`: they are the
 * `TradeView` values the store persists, the cookie the server reads to pick a landing
 * route, and the discriminator throughout lib/store/trade-view. Renaming them would
 * strand every trader who already has the old value saved. Only the strings below are
 * read by a human, which is the whole point of keeping them in one place.
 *
 * "Easy" and "Pro", both short and both plain. Do NOT pick these for their length: the
 * toggle used to be a flex row sized to its content, so a long word on one side pushed
 * the seam off centre and the swap circle landed on top of the label. That is fixed in
 * TradeModeToggle (equal grid halves), so any pair of words sits evenly now and the copy
 * is free to be chosen on how it reads.
 */
export const TRADE_MODE_LABEL: Record<TradeView, string> = {
  simple: 'Easy',
  advanced: 'Pro',
};
