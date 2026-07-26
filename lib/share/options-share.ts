/**
 * Options-page share cards — the pure data model + the X post copy. Kept free of
 * any browser / canvas imports so the tweet text is unit-testable and the type can
 * be shared by the widgets, the renderer, and the modal.
 *
 * Three kinds, each an "advertisement" for the Options page:
 *  - market_read    — the plain-language "what BTC is doing + why" take (with the fox).
 *  - expected_range — the probable range by a chosen horizon (the iconic options stat).
 *  - bold_odds      — a punchy probability from the ladder, made to be argued with.
 */
export type ReadTone = 'up' | 'down' | 'warn' | 'neutral';

export type OptionsShareCard =
  | {
      kind: 'market_read';
      asset: string;
      headline: string;
      lines: { tone: ReadTone; text: string }[];
      /** Fear & greed, for the fox's mood + tint. Null when unavailable. */
      sentiment: { value: number; label: string } | null;
    }
  | {
      kind: 'expected_range';
      asset: string;
      /** Reference (forward) price the band centers on. */
      forward: number;
      /** Live price marker within the band (null → centered). */
      spot: number | null;
      /** 1σ move as a percent (e.g. 1.8 = ±1.8%). */
      sigmaPct: number;
      lowPrice: number;
      highPrice: number;
      /** Plain horizon label, e.g. "2h 53m" or "13m". */
      horizon: string;
    }
  | {
      kind: 'bold_odds';
      asset: string;
      strike: number;
      /** Chance the asset finishes above (isUp) / the featured side, as a percent. */
      chancePct: number;
      /** Payout multiple if it wins. */
      payoutX: number;
      horizon: string;
      isUp: boolean;
    };

export type OptionsShareKind = OptionsShareCard['kind'];

/** "$64,646" — whole-dollar, thousands-separated. */
export function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** The X post text for a card. Plain language, no em-dashes, tagged @skew_sui.
 *  The image itself is attached by the modal (copy-then-paste); this is the words. */
export function optionsShareText(card: OptionsShareCard): string {
  switch (card.kind) {
    case 'market_read':
      return (
        `🦊 Here's ${card.asset} right now:\n\n` +
        `"${card.headline}"\n\n` +
        `I read the live options surface for you on @skew_sui. Come see what's moving 👇`
      );
    case 'expected_range':
      return (
        `${card.asset} is expected to stay between ${money(card.lowPrice)} and ${money(card.highPrice)} ` +
        `over the next ${card.horizon}. About a 2 in 3 chance.\n\n` +
        `Trade the range on the live surface @skew_sui 👇`
      );
    case 'bold_odds':
      return (
        `The market gives ${card.asset} a ${Math.round(card.chancePct)}% chance of ` +
        `${card.isUp ? 'holding above' : 'staying below'} ${money(card.strike)} over the next ${card.horizon}. ` +
        `Pays ${card.payoutX.toFixed(2)}x if it does.\n\n` +
        `Think it's wrong? Trade it on @skew_sui 👇`
      );
  }
}
