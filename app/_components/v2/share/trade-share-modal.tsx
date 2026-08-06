'use client';

/**
 * TradeShareModal — the sender side of a shared trade link. Turns the currently
 * configured trade (a ref-less TradeRecipe the ticket builds) into a /t/<token>
 * link and offers copy + one-tap share to X, Telegram, and WhatsApp. An optional
 * name is folded in as attribution so the recipient sees "Alex set up a trade".
 *
 * It only produces a link; it never signs or places anything. The recipient re-quotes
 * live and confirms on their own ticket. The OG preview image is added in Phase 4 (the
 * link already unfurls via /t/[token] metadata).
 */
import { useEffect, useMemo, useState } from 'react';
import { LuCopy, LuCheck } from 'react-icons/lu';
import { FaXTwitter, FaTelegram, FaWhatsapp } from 'react-icons/fa6';
import { Modal } from '@/app/_components/ui/modal';
import { encodeRecipe, normalizeRecipe, recipeLabel, recipeShareText, type TradeRecipe } from '@/lib/share/trade-link';
import { siteUrl } from '@/config/site';

const NAME_KEY = 'skew:share-name';
const enc = encodeURIComponent;

export function TradeShareModal({ open, onClose, base }: { open: boolean; onClose: () => void; base: TradeRecipe | null }) {
  // Lazy init from storage (client only) so there's no set-state-in-effect and no
  // hydration flip; the modal only mounts its input when open, so SSR sees nothing.
  const [name, setName] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    try {
      return localStorage.getItem(NAME_KEY) || '';
    } catch {
      return '';
    }
  });
  const [copied, setCopied] = useState(false);

  const onName = (v: string) => {
    setName(v);
    try {
      localStorage.setItem(NAME_KEY, v);
    } catch {
      /* ignore */
    }
  };

  // Fold the name in as attribution; normalize so the token is always clean.
  const recipe = useMemo(
    () => (base ? (normalizeRecipe({ ...base, ref: name.trim() || undefined }) ?? base) : null),
    [base, name],
  );

  const token = useMemo(() => (recipe ? encodeRecipe(recipe) : ''), [recipe]);

  // Prefer a short /s/<id> link; fall back to the long /t link until (or unless) it
  // resolves. Keyed by token so a stale short id is never shown for a new shape. The
  // fetch is debounced and only sets state in its async callback (no set-in-effect).
  const [short, setShort] = useState<{ token: string; id: string } | null>(null);
  useEffect(() => {
    if (!token || !open) return;
    let cancelled = false;
    const t = setTimeout(() => {
      fetch('/api/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled && d?.id) setShort({ token, id: d.id });
        })
        .catch(() => {});
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [token, open]);

  const shortId = short && short.token === token ? short.id : null;
  const link = shortId ? `${siteUrl}/s/${shortId}` : token ? `${siteUrl}/t/${token}` : '';
  const text = recipe ? recipeShareText(recipe) : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  const openIntent = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');
  const shareX = () => openIntent(`https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(link)}`);
  const shareTelegram = () => openIntent(`https://t.me/share/url?url=${enc(link)}&text=${enc(text)}`);
  const shareWhatsApp = () => openIntent(`https://wa.me/?text=${enc(`${text} ${link}`)}`);

  return (
    <Modal
      open={open && !!recipe}
      onClose={onClose}
      title="Share this trade"
      subtitle="Send it to a friend to trade in a tap"
      variant="glass"
      maxWidthClass="max-w-md"
      contentClassName="px-5 pb-5"
    >
      <div className="flex flex-col gap-4">
        {/* The shape the friend will receive. */}
        <div className="rounded-xl border border-line bg-bg-0 px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-text-3">They will get</p>
          <p className="mt-1 font-mono text-[14px] tabular-nums text-text-1">{recipe ? recipeLabel(recipe) : ''}</p>
        </div>

        {/* Optional attribution. */}
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[11px] text-text-3">Your name (optional)</span>
          <input
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder="so they know it is from you"
            maxLength={40}
            className="w-full rounded-lg border border-line bg-bg-0 px-3 py-2 font-sans text-[13px] text-text-1 outline-none placeholder:text-text-3 focus:border-white/20"
          />
        </label>

        {/* The link + copy. */}
        <div className="flex items-center gap-2 rounded-lg border border-line bg-bg-0 px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-2">{link}</span>
          <button
            type="button"
            onClick={copy}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[11px] font-medium text-text-1 transition-colors hover:border-white/20"
          >
            {copied ? <LuCheck size={12} /> : <LuCopy size={12} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        {/* One-tap channels. */}
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={shareX}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-line py-2.5 text-[12px] font-medium text-text-1 transition-colors hover:border-white/20"
          >
            <FaXTwitter size={13} /> X
          </button>
          <button
            type="button"
            onClick={shareTelegram}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-line py-2.5 text-[12px] font-medium text-text-1 transition-colors hover:border-white/20"
          >
            <FaTelegram size={13} /> Telegram
          </button>
          <button
            type="button"
            onClick={shareWhatsApp}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-line py-2.5 text-[12px] font-medium text-text-1 transition-colors hover:border-white/20"
          >
            <FaWhatsapp size={13} /> WhatsApp
          </button>
        </div>

        <p className="font-sans text-[11px] leading-relaxed text-text-3">
          Anyone with this link can open this setup on Skew. They see the live price and confirm it themselves. The
          link never signs or spends.
        </p>
      </div>
    </Modal>
  );
}
