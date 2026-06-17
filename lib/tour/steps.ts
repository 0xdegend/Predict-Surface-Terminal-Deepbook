/**
 * Guided-tour step config for the home (Trade) screen. Ordered top-to-bottom so
 * the spotlight walks the page the way a trader's eye would. Each `target` is a
 * CSS selector for a `data-tour="..."` anchor placed on the real section — the
 * overlay resolves these at runtime and silently skips any that aren't mounted
 * (e.g. the trade ticket only renders once there are tradeable markets).
 */
export interface TourStep {
  id: string;
  /** Selector for the section to spotlight. */
  target: string;
  /** Full heading (used elsewhere); the stepper uses `short`. */
  title: string;
  /** Compact label for the bottom stepper card so all steps fit without scroll. */
  short: string;
  body: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "chip",
    target: '[data-tour="chip"]',
    title: "Live price",
    short: "Price",
    body: "The current price updates here in real time. Tap it to check whether the market is live or paused.",
  },
  {
    id: "surface",
    target: '[data-tour="surface"]',
    title: "The live map",
    short: "Map",
    body: "This 3-D shape is a live map of every bet you can make. Left–right is the price, front–back is the deadline, and the height and color show how big a move the market expects. Hover a point to see its odds; click one to set up that trade.",
  },
  {
    id: "picker",
    target: '[data-tour="picker"]',
    title: "Pick a market",
    short: "Markets",
    body: "Browse the live markets as simple cards or a compact table. Pick one and it loads into your bet slip, ready to trade.",
  },
  {
    id: "svi",
    target: '[data-tour="svi"]',
    title: "The odds curve",
    short: "Odds",
    body: "The curve and numbers behind the prices on the map. They refresh live, the moment the market moves.",
  },
  {
    id: "ticket",
    target: '[data-tour="ticket"]',
    title: "Your bet slip",
    short: "Bet slip",
    body: "Choose how much to bet and place it in a single step. The price comes straight from the live market — what you see is what you pay.",
  },
];
