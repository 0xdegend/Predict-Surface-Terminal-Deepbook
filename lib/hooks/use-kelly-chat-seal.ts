'use client';

/**
 * useKellyChatSeal — the client half of Seal end-to-end encryption for Kelly chat history.
 *
 * Encryption is SILENT: the browser encrypts each conversation to the owner's Seal identity
 * before it's archived, so the app server only ever stores opaque ciphertext. There's no button
 * and no prompt, because anyone may encrypt TO an identity without a signature. Decryption is
 * what proves ownership, so the FIRST time a trader opens an encrypted chat in a session the
 * wallet signs one gas-free session key (~30 min) and every encrypted chat then decrypts
 * transparently for the rest of the session.
 *
 * Dark until config/seal `sealConfigured()` (flag + package + key servers). When off, `on` is
 * false and the chat-history hook keeps storing plaintext exactly as before.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useCurrentAccount, useDAppKit } from '@mysten/dapp-kit-react';
import type { SessionKey } from '@mysten/seal';
import { useV2ReadClient } from '@/lib/sui/grpc';
import { sealConfigured } from '@/config/seal';
import { encryptConversation, decryptConversation, createChatSessionKey } from '@/lib/kelly/chat-seal';
import type { SealEnvelope } from '@/lib/kelly/chat-seal-id';
import type { StoredMessage } from '@/lib/walrus/chat-history';

export interface KellyChatSeal {
  /** True when Seal E2E is fully configured, so encryption is active. */
  on: boolean;
  /** True while a decrypt is waiting on the one-time session-key signature. */
  unlocking: boolean;
  /** Encrypt a transcript to the owner's identity (no signature). Null ⇒ Seal off or a hiccup. */
  encrypt: (conversationId: string, messages: StoredMessage[]) => Promise<SealEnvelope | null>;
  /** Decrypt an encrypted blob's messages, prompting one wallet signature per session if needed.
   *  Returns null for a legacy plaintext blob (caller uses it as-is) or on failure / decline. */
  decrypt: (blob: unknown) => Promise<StoredMessage[] | null>;
}

const norm = (a: string | undefined | null): string | null => (a ? a.toLowerCase() : null);

export function useKellyChatSeal(): KellyChatSeal {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const suiClient = useV2ReadClient();
  const owner = account?.address ?? null;
  const on = sealConfigured();

  const [unlocking, setUnlocking] = useState(false);
  // A session key is reused across decrypts until it expires or the wallet changes.
  const sessionRef = useRef<{ key: SessionKey; addr: string } | null>(null);
  // Serialize session-key creation so opening two chats can't fire two wallet prompts.
  const pendingRef = useRef<Promise<SessionKey | null> | null>(null);

  const encrypt = useCallback(
    async (conversationId: string, messages: StoredMessage[]): Promise<SealEnvelope | null> => {
      if (!on || !owner) return null;
      return encryptConversation(suiClient, owner, conversationId, messages);
    },
    [on, owner, suiClient],
  );

  const ensureSession = useCallback(async (): Promise<SessionKey | null> => {
    if (!owner) return null;
    const addr = norm(owner)!;
    const cur = sessionRef.current;
    if (cur && cur.addr === addr && !cur.key.isExpired()) return cur.key;
    if (pendingRef.current) return pendingRef.current;

    const run = (async (): Promise<SessionKey | null> => {
      try {
        const key = await createChatSessionKey(suiClient, owner, (message) => dAppKit.signPersonalMessage({ message }));
        sessionRef.current = { key, addr };
        return key;
      } catch {
        return null; // trader declined the signature, or the wallet errored
      }
    })();
    pendingRef.current = run;
    try {
      return await run;
    } finally {
      pendingRef.current = null;
    }
  }, [owner, suiClient, dAppKit]);

  const decrypt = useCallback(
    async (blob: unknown): Promise<StoredMessage[] | null> => {
      const env = (blob as { enc?: SealEnvelope } | null)?.enc;
      if (!env || !owner) return null; // legacy plaintext (no enc) → caller uses the blob as-is
      setUnlocking(true);
      try {
        const key = await ensureSession();
        if (!key) return null;
        const messages = await decryptConversation(suiClient, key, env);
        return Array.isArray(messages) ? (messages as StoredMessage[]) : null;
      } finally {
        setUnlocking(false);
      }
    },
    [owner, suiClient, ensureSession],
  );

  return useMemo(() => ({ on, unlocking, encrypt, decrypt }), [on, unlocking, encrypt, decrypt]);
}
