/**
 * lib/kelly/chat-seal-id.ts — the Seal identity + envelope scheme for encrypted chat.
 *
 * Pure and dependency-light (just Sui's hex/address utils), so it's unit-tested and shared by
 * the client crypto (lib/kelly/chat-seal) and anything that needs to reason about an id.
 *
 * A conversation's Seal identity is the owner's 32-byte address followed by the conversation id.
 * The on-chain `seal_approve` (move/kelly_chat_seal) grants a decryption key only when the
 * requester's address is a PREFIX of this identity — so binding the id to the owner's address is
 * exactly what makes a chat owner-only.
 */
import { fromHex, toHex, normalizeSuiAddress } from '@mysten/sui/utils';

/** The hex identity a conversation is encrypted to: `<owner 32-byte address><conversation id>`. */
export function chatSealId(owner: string, conversationId: string): string {
  const addrHex = normalizeSuiAddress(owner).slice(2); // 64 hex chars, no 0x
  const convoHex = toHex(new TextEncoder().encode(conversationId));
  return addrHex + convoHex;
}

/** The same identity as bytes (for the seal_approve PTB argument). */
export function chatSealIdBytes(owner: string, conversationId: string): Uint8Array {
  return fromHex(chatSealId(owner, conversationId));
}

/** The stored blob shape for an encrypted conversation — an opaque envelope the server never
 *  reads. `ct` is base64 of Seal's encrypted object (the whole transcript). */
export interface SealEnvelope {
  /** Envelope version. */
  v: 1;
  /** Marks the blob as Seal-encrypted (so a reader knows to decrypt). */
  enc: 'seal';
  /** The Seal identity the transcript was encrypted to (hex) — lets a reader rebuild the PTB. */
  id: string;
  /** Base64 of the Seal encrypted object. */
  ct: string;
}

/** Wrap a base64 ciphertext into the stored envelope. */
export function wrapSealEnvelope(id: string, ciphertextB64: string): SealEnvelope {
  return { v: 1, enc: 'seal', id, ct: ciphertextB64 };
}

/** Read an envelope back, or null if the blob isn't a Seal envelope (e.g. legacy plaintext). */
export function readSealEnvelope(blob: unknown): SealEnvelope | null {
  if (!blob || typeof blob !== 'object') return null;
  const e = blob as Record<string, unknown>;
  if (e.enc !== 'seal' || typeof e.ct !== 'string' || typeof e.id !== 'string') return null;
  return { v: 1, enc: 'seal', id: e.id, ct: e.ct };
}
