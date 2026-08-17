'use client';

/**
 * lib/kelly/chat-seal.ts — client-side Seal encryption for Kelly chat history.
 *
 * TRUE end-to-end: the browser encrypts a conversation to the owner's Seal identity BEFORE it
 * ever leaves for the archive route, and decrypts it back here on read. The app server only ever
 * stores + serves an opaque ciphertext envelope, so it can never read a chat. Decryption is gated
 * on-chain by move/kelly_chat_seal::policy::seal_approve (owner-only), evaluated by the Seal key
 * servers against a one-time, wallet-signed session key.
 *
 * Encryption needs no signature (anyone may encrypt TO an identity); only decryption prompts the
 * one-time session-key signature. All calls fail soft — a Seal hiccup must never lose a chat.
 * Dark until config/seal `sealConfigured()` is true (flag + package + key servers all set).
 */
import { SealClient, SessionKey, type SealCompatibleClient } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64, fromBase64, fromHex } from '@mysten/sui/utils';
import { sealServerConfigs, sealPackageId, sealThreshold } from '@/config/seal';
import { chatSealId, wrapSealEnvelope, readSealEnvelope, type SealEnvelope } from '@/lib/kelly/chat-seal-id';

/** One SealClient per Sui client (its key-server public keys + share cache live inside). */
let _client: SealClient | null = null;
let _clientFor: SealCompatibleClient | null = null;

function getSealClient(suiClient: SealCompatibleClient): SealClient {
  if (_client && _clientFor === suiClient) return _client;
  _client = new SealClient({ suiClient, serverConfigs: sealServerConfigs(), verifyKeyServers: false });
  _clientFor = suiClient;
  return _client;
}

/** Encrypt a conversation to its owner's identity. Returns the opaque envelope to store, or null
 *  if Seal isn't configured / a hiccup — the caller then stores plaintext as before (fail soft). */
export async function encryptConversation(
  suiClient: SealCompatibleClient,
  owner: string,
  conversationId: string,
  transcript: unknown,
): Promise<SealEnvelope | null> {
  if (!sealPackageId) return null;
  try {
    const id = chatSealId(owner, conversationId);
    const data = new TextEncoder().encode(JSON.stringify(transcript));
    const { encryptedObject } = await getSealClient(suiClient).encrypt({
      threshold: sealThreshold,
      packageId: sealPackageId,
      id,
      data,
    });
    return wrapSealEnvelope(id, toBase64(encryptedObject));
  } catch {
    return null;
  }
}

/** The seal_approve dry-run PTB the key servers evaluate: it calls our owner-only policy with the
 *  conversation's identity. The session key certifies the sender, so only the owner passes. */
async function sealApproveTxBytes(suiClient: SealCompatibleClient, idHex: string): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${sealPackageId}::policy::seal_approve`,
    arguments: [tx.pure.vector('u8', Array.from(fromHex(idHex)))],
  });
  return await tx.build({ client: suiClient, onlyTransactionKind: true });
}

/**
 * A one-time, wallet-signed Seal session key (default 30 min), so a trader signs once to read
 * their encrypted chats for the session. `sign` is dapp-kit's signPersonalMessage.
 */
export async function createChatSessionKey(
  suiClient: SealCompatibleClient,
  owner: string,
  sign: (message: Uint8Array) => Promise<{ signature: string }>,
): Promise<SessionKey> {
  const sessionKey = await SessionKey.create({ address: owner, packageId: sealPackageId, ttlMin: 30, suiClient });
  const { signature } = await sign(sessionKey.getPersonalMessage());
  await sessionKey.setPersonalMessageSignature(signature);
  return sessionKey;
}

/** Decrypt a stored blob back to the transcript. Returns null if it isn't a Seal envelope (legacy
 *  plaintext — the caller uses it directly) or on any decrypt failure (fail soft). */
export async function decryptConversation(
  suiClient: SealCompatibleClient,
  sessionKey: SessionKey,
  blob: unknown,
): Promise<unknown | null> {
  const env = readSealEnvelope(blob);
  if (!env) return null;
  try {
    const txBytes = await sealApproveTxBytes(suiClient, env.id);
    const plaintext = await getSealClient(suiClient).decrypt({
      data: fromBase64(env.ct),
      sessionKey,
      txBytes,
    });
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}
