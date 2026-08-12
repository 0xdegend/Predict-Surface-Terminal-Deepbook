/**
 * config/socials.ts — Skew's public social accounts.
 *
 * ONE list, read by the header icon cluster and the "More" menu (desktop dropdown
 * + mobile sheet). To add a platform, append an entry here and give its `id` an
 * icon in `SOCIAL_ICON` (app/_components/social-links.tsx); it shows up in both
 * places automatically. The handle mirrors the @skew_sui tag used in every share
 * card, so the whole app points at the same account.
 */
export interface SocialLink {
  /** Stable key; also selects the icon in SOCIAL_ICON. */
  id: 'x' | 'discord' | 'telegram';
  /** Platform name, e.g. "X". */
  label: string;
  /** Public handle, e.g. "@skew_sui". */
  handle: string;
  /** Canonical profile URL (opened in a new tab). */
  url: string;
}

export const SOCIALS: SocialLink[] = [
  { id: 'x', label: 'X', handle: '@skew_sui', url: 'https://x.com/skew_sui' },
  // Add Discord / Telegram here when they're live, e.g.
  // { id: 'discord', label: 'Discord', handle: 'Skew', url: 'https://discord.gg/…' },
];
