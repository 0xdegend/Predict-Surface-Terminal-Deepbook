'use client';

/**
 * Shared primitives for the Rewards showcase pages (Quests + Competitions).
 *
 * These two routes are a PREVIEW of where Skew is heading — gamified trading
 * funded by the 1% Skew fee treasury — not a live system yet. So the building
 * blocks here lean on the existing glass/eyebrow/accent language but add the two
 * things a roadmap surface needs: an unmistakable "coming soon" signal and a
 * live, ticking clock so the page feels alive rather than a static mock.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LuArrowRight, LuClock } from 'react-icons/lu';
import type { IconType } from 'react-icons';

/* ------------------------------------------------------------------ *
 * "Coming soon" pill — the warm signal token (never the accent mint, so it
 * never competes with the live surface). Reads as a status tag, not a CTA.
 * ------------------------------------------------------------------ */
export function SoonPill({ label = 'Coming soon' }: { label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]"
      style={{
        color: 'var(--warn)',
        background: 'var(--warn-soft)',
        border: '1px solid color-mix(in srgb, var(--warn) 28%, transparent)',
      }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: 'var(--warn)', boxShadow: '0 0 8px -1px var(--warn)' }}
      />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Page header shared by both routes — icon + title + soon pill, with a
 * one-line framing of the feature beneath.
 * ------------------------------------------------------------------ */
export function RewardsHeader({
  icon: Icon,
  title,
  blurb,
}: {
  icon: IconType;
  title: string;
  blurb: string;
}) {
  return (
    <div className="rise mb-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2.5 text-[22px] font-semibold tracking-tight text-text-1">
          <Icon size={20} className="text-[var(--accent)]" />
          {title}
        </h1>
        <SoonPill />
      </div>
      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-text-2">{blurb}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The "how it gets funded" footer note — the narrative that makes the
 * rewards loop credible: the 1% Skew fee feeds the treasury, the treasury
 * pays out. Shared so both pages tell the same story.
 * ------------------------------------------------------------------ */
export function FundingNote() {
  return (
    <p className="mt-6 flex items-start gap-2 text-[11px] leading-relaxed text-text-3">
      <LuClock size={13} className="mt-px flex-none" />
      <span>
        Rewards will be paid in DUSDC from the Skew treasury — funded by the 1% Skew fee, so
        the prize pool grows as the community trades. Live on testnet first; values shown here are
        illustrative.
      </span>
    </p>
  );
}

/* ------------------------------------------------------------------ *
 * Cross-link card — moves a visitor between the two preview pages on any
 * device (the desktop nav dropdown isn't there on mobile).
 * ------------------------------------------------------------------ */
export function CrossLink({
  href,
  icon: Icon,
  eyebrow,
  title,
}: {
  href: string;
  icon: IconType;
  eyebrow: string;
  title: string;
}) {
  return (
    <Link
      href={href}
      className="glass-card interactive group mt-3 flex items-center gap-3 rounded-2xl px-4 py-3.5"
    >
      <span className="icon-chip" style={{ width: 34, height: 34 }}>
        <Icon size={17} className="text-text-2 transition-colors group-hover:text-accent" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="eyebrow">{eyebrow}</span>
        <span className="text-[14px] font-medium tracking-tight text-text-1">{title}</span>
      </span>
      <LuArrowRight
        size={16}
        className="ml-auto flex-none text-text-3 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-accent"
      />
    </Link>
  );
}

/* ------------------------------------------------------------------ *
 * useNow — a once-per-second client clock for the countdown. Gate any
 * rendered time on `useMounted` so SSR (which has a different Date.now)
 * never mismatches hydration.
 * ------------------------------------------------------------------ */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** 00:00 UTC of the next Monday — the recurring "season start" anchor. */
export function nextMondayUTC(fromMs: number): number {
  const d = new Date(fromMs);
  const day = d.getUTCDay(); // 0 = Sun … 1 = Mon
  const daysAhead = ((8 - day) % 7) || 7; // always strictly in the future
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysAhead, 0, 0, 0, 0),
  );
  return target.getTime();
}

/** Break a remaining-ms span into padded D/H/M/S strings for the clock blocks. */
export function countdownParts(ms: number): { d: string; h: string; m: string; s: string } {
  const clamped = Math.max(0, ms);
  const totalSec = Math.floor(clamped / 1000);
  const d = Math.floor(totalSec / 86_400);
  const h = Math.floor((totalSec % 86_400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { d: pad(d), h: pad(h), m: pad(m), s: pad(s) };
}
