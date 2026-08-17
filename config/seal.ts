/**
 * config/seal.ts — Seal end-to-end encryption for Kelly chat history.
 *
 * Seal has no global access policy: the `seal_approve` package we deploy IS the access control
 * (see move/kelly_chat_seal). The app encrypts each conversation to the owner's identity under
 * that package, and decryption dry-runs `seal_approve` on the key servers. Everything here is
 * env-driven so a mainnet cutover is a single config swap — nothing about the key set or the
 * package id is hard-coded.
 *
 * Until the flag AND the package id AND the key servers are all set, `sealConfigured()` is false
 * and the app keeps chat history in its current (unencrypted, unlisted) form.
 */

/** Master switch. Off ⇒ the encryption path is fully dark (current behavior unchanged). */
export const SEAL_ENABLED = process.env.NEXT_PUBLIC_KELLY_CHAT_SEAL === '1';

/** The deployed kelly_chat_seal package id (namespaces the Seal identities + seal_approve call). */
export const sealPackageId = process.env.NEXT_PUBLIC_SEAL_PACKAGE_ID ?? '';

/** Threshold of key servers that must return a share to decrypt (t-of-n). */
export const sealThreshold = Number(process.env.NEXT_PUBLIC_SEAL_THRESHOLD) || 2;

/**
 * Seal key-server entries for this network (comma-separated). Each entry is either a bare object id
 * (an "independent" server) or `objectId@aggregatorUrl` (a "decentralized"/committee server, which
 * the SDK requires an aggregator endpoint for). Sourced from the Seal docs — a list that changes,
 * so it's config, not code. Example (testnet, 2-of-2):
 *   0x73d05d62…356db75,0xb012378c…1e1e98@https://seal-aggregator-testnet.mystenlabs.com
 */
const sealKeyServerEntries: string[] = (process.env.NEXT_PUBLIC_SEAL_KEY_SERVERS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Just the object ids (used by sealConfigured() to count servers against the threshold). */
export const sealKeyServerIds: string[] = sealKeyServerEntries.map((e) => e.split('@')[0].trim());

/** One key-server config: object id + weight, plus an aggregator URL for committee-mode servers. */
export interface SealServerConfig {
  objectId: string;
  weight: number;
  aggregatorUrl?: string;
}

/** KeyServerConfig[] for the SealClient (equal weight; add an API key here if a server needs one). */
export function sealServerConfigs(): SealServerConfig[] {
  return sealKeyServerEntries.map((entry) => {
    const [objectId, aggregatorUrl] = entry.split('@').map((s) => s.trim());
    return aggregatorUrl ? { objectId, weight: 1, aggregatorUrl } : { objectId, weight: 1 };
  });
}

/** True only when everything Seal needs is present: the flag, the package, and enough servers. */
export function sealConfigured(): boolean {
  return SEAL_ENABLED && sealPackageId.length > 0 && sealKeyServerIds.length >= sealThreshold;
}
