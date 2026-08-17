'use client';

/**
 * useKellyChatHistory — persist + browse Kelly conversations.
 *
 * Two layers, mirroring how the app treats other Walrus data:
 *   - a localStorage WORKING COPY (instant, this-device) so a reload can continue the
 *     current chat, and
 *   - a durable WALRUS ARCHIVE (cross-device, listable) written through the auth-gated
 *     /api/kelly/chat route, debounced while chatting and flushed on tab-away / new chat.
 *
 * The archive only runs when the trader is signed in (the same wallet session Kelly
 * memory uses); without it, chats still persist locally on this device. Dark behind
 * NEXT_PUBLIC_KELLY_HISTORY. The server-only storage module is referenced by TYPE only,
 * so its Walrus SDK is never bundled here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StoredMessage, StoredConversation, ConversationIndexEntry } from '@/lib/walrus/chat-history';
import type { SealEnvelope } from '@/lib/kelly/chat-seal-id';

const KELLY_HISTORY = process.env.NEXT_PUBLIC_KELLY_HISTORY === '1';
const SAVE_DEBOUNCE_MS = 4_000;

/** The Seal encrypt/decrypt seam (from useKellyChatSeal). Optional — when absent or `off`,
 *  chats are stored in plaintext exactly as before. */
export interface ChatSealSeam {
  on: boolean;
  encrypt: (conversationId: string, messages: StoredMessage[]) => Promise<SealEnvelope | null>;
  decrypt: (blob: unknown) => Promise<StoredMessage[] | null>;
}

function newConversationId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
const workingKey = (owner: string) => `kelly:chat:working:${owner.toLowerCase()}`;

interface WorkingCopy {
  id: string;
  messages: StoredMessage[];
  updatedAt: number;
}

export interface KellyChatHistory {
  enabled: boolean;
  /** True when Seal E2E is active, so new archives are encrypted before they leave the browser. */
  sealOn: boolean;
  /** The current working conversation id (stable until newChat / restore). */
  conversationId: string;
  /** Save the current transcript: localStorage now + a debounced Walrus archive. */
  persist: (messages: StoredMessage[]) => void;
  /** Archive the current chat and start a fresh one. */
  newChat: () => void;
  /** Read this device's saved working chat (to continue it after a reload), or null. */
  restore: () => StoredMessage[] | null;
  /** Adopt a saved conversation as the working chat so new turns continue it: its id
   *  becomes the working id (new turns append + re-archive under it) and it's mirrored
   *  to this device. The caller loads the messages into the visible thread. */
  resume: (convo: StoredConversation) => void;
  conversations: ConversationIndexEntry[];
  listLoading: boolean;
  refreshList: () => void;
  loadConversation: (id: string) => Promise<StoredConversation | null>;
}

export function useKellyChatHistory({
  owner,
  signedIn,
  seal,
}: {
  owner: string | null;
  signedIn: boolean;
  seal?: ChatSealSeam;
}): KellyChatHistory {
  const enabled = KELLY_HISTORY;
  const sealOn = !!seal?.on;
  const [conversationId, setConversationId] = useState('');
  const idRef = useRef('');
  const latestRef = useRef<StoredMessage[]>([]);
  const savedSigRef = useRef('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [conversations, setConversations] = useState<ConversationIndexEntry[]>([]);
  const [listLoading, setListLoading] = useState(false);
  // Keep the latest Seal seam in a ref so the debounced flush / load closures use it without
  // being torn down and re-created on every render.
  const sealRef = useRef<ChatSealSeam | undefined>(seal);
  useEffect(() => {
    sealRef.current = seal;
  }, [seal]);

  const setId = useCallback((id: string) => {
    idRef.current = id;
    setConversationId(id);
  }, []);

  // Establish the working conversation id once the owner is known (reusing the saved
  // one on this device so a reload continues the same chat).
  useEffect(() => {
    if (!enabled || idRef.current) return;
    let id = '';
    if (owner && typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(workingKey(owner));
        if (raw) {
          const wc = JSON.parse(raw) as WorkingCopy;
          if (wc?.id) id = wc.id;
        }
      } catch {
        // ignore a malformed working copy
      }
    }
    setId(id || newConversationId());
  }, [enabled, owner, setId]);

  const flushToWalrus = useCallback(
    async (messages: StoredMessage[]) => {
      if (!enabled || !signedIn || !idRef.current) return;
      if (!messages.some((m) => m.role === 'user')) return;
      const last = messages[messages.length - 1];
      const sig = `${idRef.current}:${messages.length}:${(last?.text ?? []).join('|').slice(0, 48)}`;
      if (sig === savedSigRef.current) return; // nothing new since the last save
      savedSigRef.current = sig;
      try {
        // Seal on ⇒ encrypt in the browser and send only the opaque envelope. If encryption
        // hiccups we FAIL CLOSED (skip this archive, retry next turn) rather than fall back to
        // plaintext — once a trader's chats are private, we never write their words in the clear.
        const sealSeam = sealRef.current;
        let payload: Record<string, unknown>;
        if (sealSeam?.on) {
          const envelope = await sealSeam.encrypt(idRef.current, messages);
          if (!envelope) {
            savedSigRef.current = '';
            return;
          }
          payload = { id: idRef.current, enc: envelope, count: messages.length };
        } else {
          payload = { id: idRef.current, messages };
        }
        const r = await fetch('/api/kelly/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!r.ok) savedSigRef.current = ''; // let a later save retry
      } catch {
        savedSigRef.current = '';
      }
    },
    [enabled, signedIn],
  );

  const persist = useCallback(
    (messages: StoredMessage[]) => {
      if (!enabled || !owner || !idRef.current) return;
      latestRef.current = messages;
      try {
        window.localStorage.setItem(
          workingKey(owner),
          JSON.stringify({ id: idRef.current, messages, updatedAt: Date.now() } satisfies WorkingCopy),
        );
      } catch {
        // storage full / unavailable — the debounced Walrus save still runs
      }
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => void flushToWalrus(latestRef.current), SAVE_DEBOUNCE_MS);
    },
    [enabled, owner, flushToWalrus],
  );

  const restore = useCallback((): StoredMessage[] | null => {
    if (!enabled || !owner || typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(workingKey(owner));
      if (!raw) return null;
      const wc = JSON.parse(raw) as WorkingCopy;
      if (wc?.messages?.length && wc.messages.some((m) => m.role === 'user')) {
        if (wc.id) setId(wc.id);
        latestRef.current = wc.messages;
        return wc.messages;
      }
    } catch {
      // ignore a malformed working copy
    }
    return null;
  }, [enabled, owner, setId]);

  const resume = useCallback(
    (convo: StoredConversation) => {
      if (!enabled || !owner) return;
      // Flush the chat we're leaving so it isn't lost, then adopt the loaded one.
      if (latestRef.current.length) void flushToWalrus(latestRef.current);
      setId(convo.id);
      latestRef.current = convo.messages;
      savedSigRef.current = ''; // let the first new turn re-archive under this id
      try {
        window.localStorage.setItem(
          workingKey(owner),
          JSON.stringify({ id: convo.id, messages: convo.messages, updatedAt: Date.now() } satisfies WorkingCopy),
        );
      } catch {
        // storage full / unavailable — the debounced Walrus save still runs on the next turn
      }
    },
    [enabled, owner, flushToWalrus, setId],
  );

  const newChat = useCallback(() => {
    if (latestRef.current.length) void flushToWalrus(latestRef.current);
    if (owner) {
      try {
        window.localStorage.removeItem(workingKey(owner));
      } catch {
        // ignore
      }
    }
    latestRef.current = [];
    savedSigRef.current = '';
    setId(newConversationId());
  }, [flushToWalrus, owner, setId]);

  const refreshList = useCallback(() => {
    if (!enabled || !signedIn) {
      setConversations([]);
      return;
    }
    setListLoading(true);
    fetch('/api/kelly/chat?limit=50')
      .then((r) => (r.ok ? r.json() : { conversations: [] }))
      .then((d: { conversations?: ConversationIndexEntry[] }) => setConversations(d.conversations ?? []))
      .catch(() => setConversations([]))
      .finally(() => setListLoading(false));
  }, [enabled, signedIn]);

  const loadConversation = useCallback(
    async (id: string): Promise<StoredConversation | null> => {
      if (!enabled) return null;
      try {
        const r = await fetch(`/api/kelly/chat/${encodeURIComponent(id)}`);
        if (!r.ok) return null;
        const d = (await r.json()) as { conversation: (StoredConversation & { enc?: unknown }) | null };
        const convo = d.conversation;
        if (!convo) return null;
        // Encrypted blob (has an `enc` envelope): decrypt in the browser, prompting the one-time
        // session-key signature on first open. Legacy plaintext blobs have `messages` and pass through.
        if (convo.enc) {
          const messages = await sealRef.current?.decrypt(convo);
          if (!messages) return null; // Seal off, declined, or a decrypt error — can't show it
          return { id: convo.id, createdAt: convo.createdAt, updatedAt: convo.updatedAt, messages };
        }
        return convo;
      } catch {
        return null;
      }
    },
    [enabled],
  );

  // Best-effort flush when the tab goes away (reload / close / navigate).
  useEffect(() => {
    if (!enabled) return;
    const onHide = () => {
      if (latestRef.current.length) void flushToWalrus(latestRef.current);
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [enabled, flushToWalrus]);

  return { enabled, sealOn, conversationId, persist, newChat, restore, resume, conversations, listLoading, refreshList, loadConversation };
}
