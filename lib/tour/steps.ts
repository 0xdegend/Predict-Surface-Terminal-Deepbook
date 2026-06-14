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
    id: 'chip',
    target: '[data-tour="chip"]',
    title: 'Live market',
    short: 'Live feed',
    body: 'Spot and forward stream here in real time. Click the chip for protocol status — your at-a-glance read on whether the market is live or paused.',
  },
  {
    id: 'surface',
    target: '[data-tour="surface"]',
    title: 'The volatility surface',
    short: 'Surface',
    body: 'The actual SVI surface the protocol prices against — strike × expiry × implied vol, updating live. Hover a node to inspect it, click one to load that exact trade.',
  },
  {
    id: 'picker',
    target: '[data-tour="picker"]',
    title: 'Pick a market',
    short: 'Markets',
    body: 'Browse active oracles as friendly cards or a dense table. Selecting one focuses it on the surface and pre-fills the ticket.',
  },
  {
    id: 'svi',
    target: '[data-tour="svi"]',
    title: 'Live SVI parameters',
    short: 'SVI',
    body: 'The raw smile parameters driving the surface, refreshed from on-chain oracle events the moment they land.',
  },
  {
    id: 'ticket',
    target: '[data-tour="ticket"]',
    title: 'Trade ticket',
    short: 'Ticket',
    body: 'Set your size and mint a binary or range in a single transaction. Quotes come straight from the chain, so the price you see is the price you pay.',
  },
];
