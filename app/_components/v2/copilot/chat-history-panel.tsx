'use client';

/**
 * ChatHistoryPanel — Kelly's "past chats" slide-over. Lists the trader's saved
 * conversations (from the Walrus-backed archive) and opens any one as a read-only
 * transcript. Presentational: all the loading/saving lives in useKellyChatHistory.
 *
 * Signed out, it explains that history needs a one-time wallet sign-in (the same
 * session Kelly memory uses); this device's current chat still persists locally.
 */
import { useEffect, useState } from 'react';
import {
  LuX,
  LuArrowLeft,
  LuMessageSquare,
  LuTrendingUp,
  LuTrendingDown,
  LuBrackets,
  LuHistory,
  LuLock,
  LuCornerDownLeft,
} from 'react-icons/lu';
import { useNow } from '@/lib/hooks/use-now';
import { num } from '@/lib/format';
import type { KellyChatHistory } from '@/lib/hooks/use-kelly-chat-history';
import type { StoredConversation, StoredMessage } from '@/lib/walrus/chat-history';

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`;
}

export function ChatHistoryPanel({
  onClose,
  history,
  signedIn,
  onSignIn,
  onContinue,
}: {
  onClose: () => void;
  history: KellyChatHistory;
  signedIn: boolean;
  onSignIn: () => void;
  /** Reopen a past chat in the live thread to keep talking. Omit to keep it read-only. */
  onContinue?: (convo: StoredConversation) => void;
}) {
  const { refreshList, loadConversation, conversations, listLoading } = history;
  const now = useNow(60_000);
  const [viewing, setViewing] = useState<StoredConversation | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  // The panel is mounted only while open (the parent gates it), so a fresh mount
  // starts on the list and refetches once.
  useEffect(() => {
    refreshList();
  }, [refreshList]);

  async function openConversation(id: string) {
    setLoadingId(id);
    const convo = await loadConversation(id);
    setLoadingId(null);
    if (convo) setViewing(convo);
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Past chats">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative flex h-full w-full max-w-md flex-col border-l border-line bg-bg-1 shadow-2xl">
        {/* header */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          {viewing ? (
            <button
              onClick={() => setViewing(null)}
              className="group glass-inset inline-flex items-center gap-1.5 px-2 py-1.5 text-[12px] text-text-2 transition-all hover:border-(--accent-line) hover:text-text-1"
            >
              <LuArrowLeft size={13} /> Back
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-text-1">
              <LuHistory size={14} className="text-accent" /> Past chats
            </span>
          )}
          <button
            onClick={onClose}
            aria-label="Close"
            className="group glass-inset ml-auto inline-flex h-7 w-7 items-center justify-center text-text-2 transition-all hover:border-(--accent-line) hover:text-text-1"
          >
            <LuX size={14} />
          </button>
        </div>

        {/* body */}
        {viewing ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Transcript convo={viewing} />
            </div>
            {onContinue && (
              <div className="border-t border-line p-3">
                <button
                  onClick={() => onContinue(viewing)}
                  className="group glass-inset inline-flex w-full items-center justify-center gap-1.5 px-3 py-2.5 text-[12.5px] font-medium text-text-1 transition-all hover:border-(--accent-line)"
                >
                  <LuCornerDownLeft size={14} className="text-accent" /> Continue this chat
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!signedIn ? (
              <SignedOut onSignIn={onSignIn} />
            ) : listLoading && conversations.length === 0 ? (
              <ListSkeleton />
            ) : conversations.length === 0 ? (
              <Empty />
            ) : (
              <ul className="divide-y divide-line">
                {conversations.map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => void openConversation(c.id)}
                      disabled={loadingId != null}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/3 disabled:opacity-60"
                    >
                      <LuMessageSquare size={15} className="flex-none text-text-3" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-text-1">{c.preview}</span>
                        <span className="mt-0.5 block text-[10.5px] tabular-nums text-text-3">
                          {ago(c.updatedAt, now)} · {c.count} messages
                        </span>
                      </span>
                      {loadingId === c.id && <span className="h-3.5 w-3.5 flex-none animate-spin rounded-full border-2 border-line border-t-accent" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------- transcript ------------------------------ */

function Transcript({ convo }: { convo: StoredConversation }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      {convo.messages.map((m, i) => (
        <Bubble key={i} m={m} />
      ))}
    </div>
  );
}

function Bubble({ m }: { m: StoredMessage }) {
  const isUser = m.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-xl px-3 py-2 text-[12.5px] leading-relaxed ${
          isUser ? 'bg-(--accent-soft) text-text-1' : 'glass-inset text-text-2'
        }`}
      >
        {m.text.map((line, i) => (
          <p key={i} className={i > 0 ? 'mt-1.5' : undefined}>
            {line}
          </p>
        ))}
        {m.bet && (
          <span className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-black/20 px-2 py-1 font-mono text-[11px] text-text-1">
            {m.bet.isUp ? <LuTrendingUp size={12} className="text-up" /> : <LuTrendingDown size={12} className="text-down" />}
            {m.bet.isUp ? 'UP' : 'DOWN'} ${num(m.bet.strike, 0)} · {Math.round(m.bet.prob * 100)}%
            {m.bet.amount != null ? ` · $${num(m.bet.amount, 0)}` : ''}
          </span>
        )}
        {m.range && (
          <span className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-black/20 px-2 py-1 font-mono text-[11px] text-text-1">
            <LuBrackets size={12} className="text-accent" />${num(m.range.lower, 0)}–${num(m.range.higher, 0)} · {Math.round(m.range.prob * 100)}%
            {m.range.amount != null ? ` · $${num(m.range.amount, 0)}` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

/* --------------------------------- states --------------------------------- */

function SignedOut({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <LuLock size={22} className="text-text-3" />
      <p className="text-[13px] text-text-1">Unlock your saved chats</p>
      <p className="max-w-xs text-[12px] leading-relaxed text-text-2">
        A quick, gas-free signature (separate from connecting your wallet) keeps your saved chats private and lets them
        follow you across devices. It lasts about a week. Your current chat stays on this device either way.
      </p>
      <button
        onClick={onSignIn}
        className="group glass-inset mt-1 inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium text-text-2 transition-all hover:border-(--accent-line) hover:text-text-1"
      >
        Unlock chats
      </button>
    </div>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <LuMessageSquare size={22} className="text-text-3" />
      <p className="text-[13px] text-text-1">No past chats yet</p>
      <p className="max-w-xs text-[12px] leading-relaxed text-text-2">
        Your conversations with Kelly are saved here as you go, so you can come back and read them any time.
      </p>
    </div>
  );
}

function ListSkeleton() {
  return (
    <ul className="divide-y divide-line">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-4 py-3.5">
          <span className="h-4 w-4 flex-none rounded skeleton" />
          <span className="min-w-0 flex-1">
            <span className="block h-3.5 w-40 rounded skeleton" />
            <span className="mt-1.5 block h-2.5 w-24 rounded skeleton" />
          </span>
        </li>
      ))}
    </ul>
  );
}
