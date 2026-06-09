/**
 * config/enoki.ts — Enoki (zkLogin + sponsored-tx) configuration.
 *
 * Browser-safe values ONLY: the Enoki PUBLIC api key and the Google OAuth client
 * id, both from NEXT_PUBLIC_* env. The PRIVATE Enoki key is server-only (backend
 * sponsorship) and must never be imported into client code, so it lives nowhere
 * in this file.
 *
 * zkLogin sign-in is enabled only when both public values are present, so the app
 * degrades gracefully to wallet-only connect when they're absent (e.g. a fork
 * without Enoki keys still builds and runs).
 */
export const enokiConfig = {
  /** Enoki PUBLIC api key (safe in the browser; sponsorship is gated by the
   *  move-target allowlist configured in the Enoki portal). */
  apiKey: process.env.NEXT_PUBLIC_ENOKI_API_KEY ?? '',
  /** Google OAuth 2.0 Web client id. */
  googleClientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '',
} as const;

/** True when zkLogin can be offered (both public values configured). */
export const enokiEnabled = !!enokiConfig.apiKey && !!enokiConfig.googleClientId;
