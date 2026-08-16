/**
 * lib/walrus/chat-history.ts — durable, per-wallet Kelly chat history on Walrus.
 *
 * Each conversation is stored as a JSON blob on Walrus (via the Phase 0 blob layer,
 * [[walrus-phase0]]), and a compact, per-owner INDEX lives in KV so a trader's past
 * chats list without fetching every blob. A conversation is UPDATED as it grows: we
 * write a fresh blob and repoint that conversation's index entry at it (last write
 * wins), so reopening always reads the newest transcript.
 *
 * SERVER-ONLY — writes are signed by the Walrus writer key. The routes gate every
 * call on the wallet session (lib/server/kelly-auth), and every function here takes
 * the owner from that session, so a trader only ever touches their OWN chats.
 *
 * Privacy note: Walrus blobs are public to anyone holding the (unguessable,
 * content-addressed) blobId, and the id is only ever exposed to the authenticated
 * owner. Encrypting the transcript (Seal, like Kelly memory) is a follow-up.
 */
import { storeJson, readBlobJson } from '@/lib/walrus/client';
import { walrusConfig } from '@/config/walrus';
import { kv } from '@/lib/server/kv';

/** A persisted message — a compact, JSON-safe subset of the UI ChatMessage. Only the
 *  parts needed to re-read the conversation (text + a static bet/range summary). */
export interface StoredMessage {
  role: 'user' | 'assistant';
  text: string[];
  /** A binary bet Kelly set up in this message (summary only, not the live card). */
  bet?: { isUp: boolean; strike: number; prob: number; amount?: number };
  /** A range bet Kelly set up in this message. */
  range?: { lower: number; higher: number; prob: number; amount?: number };
}

/** A full stored conversation (the blob body). */
export interface StoredConversation {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

/** A compact index row (kept in KV) so past chats list without a blob fetch. */
export interface ConversationIndexEntry {
  id: string;
  blobId: string;
  createdAt: number;
  updatedAt: number;
  /** Number of messages in the saved transcript. */
  count: number;
  /** The first thing the trader said, for the list row (already trimmed). */
  preview: string;
}

const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES = 500;
const MAX_LINES = 40;
const MAX_LINE_LEN = 4_000;
const PREVIEW_LEN = 90;

function indexKey(owner: string): string {
  return `kelly:chat:${owner.toLowerCase()}`;
}

/* ------------------------------ input hardening -------------------------- */

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function sanitizeMessage(raw: unknown): StoredMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : null;
  if (!role) return null;
  const text = Array.isArray(m.text)
    ? m.text.filter((t): t is string => typeof t === 'string').slice(0, MAX_LINES).map((t) => t.slice(0, MAX_LINE_LEN))
    : [];
  const out: StoredMessage = { role, text };
  const bet = m.bet as Record<string, unknown> | undefined;
  if (bet && num(bet.strike) != null && num(bet.prob) != null) {
    out.bet = { isUp: !!bet.isUp, strike: num(bet.strike)!, prob: num(bet.prob)!, amount: num(bet.amount) };
  }
  const range = m.range as Record<string, unknown> | undefined;
  if (range && num(range.lower) != null && num(range.higher) != null && num(range.prob) != null) {
    out.range = { lower: num(range.lower)!, higher: num(range.higher)!, prob: num(range.prob)!, amount: num(range.amount) };
  }
  return out;
}

/** Coerce untrusted client input into a safe StoredConversation. Returns null when
 *  there's nothing worth saving (no real messages). */
export function sanitizeConversation(rawId: unknown, rawMessages: unknown, now: number): StoredConversation | null {
  const id = typeof rawId === 'string' && /^[a-zA-Z0-9_-]{6,64}$/.test(rawId) ? rawId : null;
  if (!id) return null;
  const messages = Array.isArray(rawMessages)
    ? rawMessages.map(sanitizeMessage).filter((m): m is StoredMessage => !!m).slice(0, MAX_MESSAGES)
    : [];
  // Nothing worth archiving until the trader has actually said something.
  if (!messages.some((m) => m.role === 'user')) return null;
  return { id, createdAt: now, updatedAt: now, messages };
}

/** The list-row preview: the first thing the trader said. */
function previewOf(convo: StoredConversation): string {
  const firstUser = convo.messages.find((m) => m.role === 'user');
  const raw = (firstUser?.text ?? []).join(' ').trim();
  return raw ? raw.slice(0, PREVIEW_LEN) : 'New chat';
}

/* --------------------------------- index --------------------------------- */

const _localIndex = new Map<string, ConversationIndexEntry[]>();

async function readIndex(owner: string): Promise<ConversationIndexEntry[]> {
  const key = indexKey(owner);
  if (kv) {
    const raw = await kv.get(key);
    if (!raw) return [];
    try {
      const arr = (typeof raw === 'string' ? JSON.parse(raw) : raw) as ConversationIndexEntry[];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  return _localIndex.get(key) ?? [];
}

async function writeIndex(owner: string, entries: ConversationIndexEntry[]): Promise<void> {
  const key = indexKey(owner);
  const capped = entries.slice(0, MAX_CONVERSATIONS);
  if (kv) {
    await kv.set(key, JSON.stringify(capped));
  } else {
    _localIndex.set(key, capped);
  }
}

/** Upsert an entry by conversation id, keeping the list ordered newest-updated first. */
export function upsertEntry(entries: ConversationIndexEntry[], entry: ConversationIndexEntry): ConversationIndexEntry[] {
  const rest = entries.filter((e) => e.id !== entry.id);
  return [entry, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
}

/* --------------------------------- save ---------------------------------- */

/**
 * Save (or update) a conversation for a trader: write the transcript blob, then repoint
 * the index entry at it. Returns the id + blobId. Server-only (signs with the writer key).
 */
export async function saveConversation(owner: string, convo: StoredConversation): Promise<{ id: string; blobId: string }> {
  const existing = await readIndex(owner);
  const prior = existing.find((e) => e.id === convo.id);
  const createdAt = prior?.createdAt ?? convo.createdAt;
  const body: StoredConversation = { ...convo, createdAt, updatedAt: convo.updatedAt };

  const { blobId } = await storeJson(body, { epochs: walrusConfig.defaultEpochs, deletable: true });
  const entry: ConversationIndexEntry = {
    id: convo.id,
    blobId,
    createdAt,
    updatedAt: convo.updatedAt,
    count: convo.messages.length,
    preview: previewOf(body),
  };
  await writeIndex(owner, upsertEntry(existing, entry));
  return { id: convo.id, blobId };
}

/* --------------------------------- list ---------------------------------- */

/** A trader's past conversations, newest first. */
export async function listConversations(owner: string, limit = 50): Promise<ConversationIndexEntry[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), MAX_CONVERSATIONS);
  return (await readIndex(owner)).slice(0, n);
}

/** Read one conversation's latest transcript. Only resolves ids in the owner's index
 *  (so a caller can never read another wallet's blob by guessing an id). */
export async function readConversation(owner: string, id: string): Promise<StoredConversation | null> {
  const entry = (await readIndex(owner)).find((e) => e.id === id);
  if (!entry) return null;
  try {
    return await readBlobJson<StoredConversation>(entry.blobId);
  } catch {
    return null;
  }
}

/** Test-only: clear the in-process index (no effect when KV is configured). */
export function _resetChatIndex(): void {
  _localIndex.clear();
}
