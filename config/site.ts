/**
 * Single source of truth for site-level identity used by SEO/metadata, the
 * robots file, and the sitemap. Keep marketing copy here, not inline in layout.
 *
 * `siteUrl` resolves the absolute origin used for canonical + OG image URLs:
 *   1. NEXT_PUBLIC_SITE_URL — set this to the production domain.
 *   2. VERCEL_URL           — the per-deployment URL on Vercel (preview/prod).
 *   3. localhost            — local dev fallback.
 */
// `||` (not `??`): Next inlines an unset NEXT_PUBLIC_* var as an empty string,
// and `'' ?? x` keeps the empty string — which would throw `new URL('')`. `||`
// falls through on both empty-string and undefined.
export const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

export const siteConfig = {
  name: 'Skew',
  url: siteUrl,
  title: 'Skew · Trade the shape of volatility',
  description:
    'Trade the shape of volatility on Sui. Skew is a live 3-D SVI volatility-surface terminal for DeepBook Predict — watch the surface breathe, click any strike or expiry, and mint a binary or range bet in one transaction.',
  ogImage: '/skew-og-image.png',
  ogImageAlt:
    'Skew — a live 3-D SVI volatility-surface trading terminal for DeepBook Predict on Sui.',
  ogImageWidth: 1635,
  ogImageHeight: 962,
  /** Public routes worth indexing (dynamic /trader/* is excluded). */
  routes: ['', '/portfolio', '/vault', '/leaderboard', '/risk'] as const,
} as const;
