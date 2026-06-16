'use client';

/**
 * Quests — a PREVIEW of Skew's gamified trading milestones. Trade to complete
 * challenges (first trade, volume tiers, winning streaks, market coverage) and
 * earn DUSDC from the treasury. Not live yet: progress + rewards shown here are
 * illustrative, the claim action is disabled behind a "soon" state. 100% client,
 * no data, no wallet required — a roadmap surface dressed in the real design
 * language so it reads as a product, not a slide.
 */
import { useMemo, useState } from 'react';
import {
  LuTarget,
  LuRocket,
  LuTrendingUp,
  LuZap,
  LuCompass,
  LuCoins,
  LuCheck,
  LuLock,
  LuSwords,
} from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { num } from '@/lib/format';
import { HUE } from '../ui/metric';
import { RewardsHeader, FundingNote, CrossLink } from './shared';

type Category = 'onboarding' | 'volume' | 'skill' | 'markets';

interface Quest {
  id: string;
  category: Category;
  icon: IconType;
  title: string;
  desc: string;
  /** DUSDC reward on completion. */
  reward: number;
  /** 0..1 — illustrative progress for the preview. */
  progress: number;
  /** Human progress label, e.g. "32 / 50 DUSDC" or "1 / 3". */
  label: string;
}

const CAT: Record<Category, { label: string; hue: string }> = {
  onboarding: { label: 'Onboarding', hue: HUE.teal },
  volume: { label: 'Volume', hue: HUE.amber },
  skill: { label: 'Skill', hue: HUE.violet },
  markets: { label: 'Markets', hue: HUE.blue },
};

// Illustrative catalog — the kinds of quests the live system will evaluate from
// each trader's own position history (volume, wins, holding, market coverage).
const QUESTS: Quest[] = [
  {
    id: 'first-trade',
    category: 'onboarding',
    icon: LuRocket,
    title: 'First Prediction',
    desc: 'Mint your first binary or range position on any market.',
    reward: 1,
    progress: 1,
    label: 'Complete',
  },
  {
    id: 'fund-manager',
    category: 'onboarding',
    icon: LuCoins,
    title: 'Fund Your Manager',
    desc: 'Deposit DUSDC into your Predict manager to start trading.',
    reward: 0.5,
    progress: 1,
    label: 'Complete',
  },
  {
    id: 'volume-climber',
    category: 'volume',
    icon: LuTrendingUp,
    title: 'Volume Climber',
    desc: 'Trade 50 DUSDC of notional volume this week.',
    reward: 3,
    progress: 0.64,
    label: '32 / 50 DUSDC',
  },
  {
    id: 'market-maker',
    category: 'volume',
    icon: LuTrendingUp,
    title: 'Market Mover',
    desc: 'Reach 250 DUSDC of cumulative trading volume.',
    reward: 10,
    progress: 0.22,
    label: '55 / 250 DUSDC',
  },
  {
    id: 'sharp-shooter',
    category: 'skill',
    icon: LuZap,
    title: 'Sharp Shooter',
    desc: 'Close three winning positions (decided, payout above cost).',
    reward: 5,
    progress: 0.33,
    label: '1 / 3 wins',
  },
  {
    id: 'diamond-hands',
    category: 'skill',
    icon: LuTarget,
    title: 'Hold to Settlement',
    desc: 'Carry a position all the way to oracle settlement.',
    reward: 2,
    progress: 0,
    label: '0 / 1',
  },
  {
    id: 'explorer',
    category: 'markets',
    icon: LuCompass,
    title: 'Market Explorer',
    desc: 'Open positions across three different underlying markets.',
    reward: 4,
    progress: 0.66,
    label: '2 / 3 markets',
  },
  {
    id: 'range-rider',
    category: 'markets',
    icon: LuTarget,
    title: 'Range Rider',
    desc: 'Open your first vertical range position on the surface.',
    reward: 2,
    progress: 0,
    label: '0 / 1',
  },
];

const FILTERS: { key: 'all' | Category; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'onboarding', label: 'Onboarding' },
  { key: 'volume', label: 'Volume' },
  { key: 'skill', label: 'Skill' },
  { key: 'markets', label: 'Markets' },
];

export function QuestsPanel() {
  const [filter, setFilter] = useState<'all' | Category>('all');

  const visible = useMemo(
    () => (filter === 'all' ? QUESTS : QUESTS.filter((q) => q.category === filter)),
    [filter],
  );

  const completed = QUESTS.filter((q) => q.progress >= 1).length;
  const totalReward = QUESTS.reduce((s, q) => s + q.reward, 0);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5">
      <RewardsHeader
        icon={LuTarget}
        title="Quests"
        blurb="Complete trading milestones to earn DUSDC rewards — from your very first prediction to volume tiers, winning streaks and market coverage. Progress tracks automatically from your on-chain activity."
      />

      {/* How it works — the three-beat loop, compact */}
      <div className="mb-6 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <HowStep n={1} title="Trade" body="Mint positions on the live surface as you normally would." />
        <HowStep n={2} title="Progress" body="Each trade advances every quest it qualifies for, automatically." />
        <HowStep n={3} title="Claim" body="Hit the target and claim the DUSDC reward to your wallet." />
      </div>

      {/* Summary strip */}
      <div className="glass-card mb-5 grid grid-cols-3 gap-2.5 p-2.5 font-mono tabular-nums">
        <Stat label="Quests" value={String(QUESTS.length)} />
        <Stat label="Completed" value={`${completed} / ${QUESTS.length}`} />
        <Stat label="Reward pool" value={num(totalReward, 1)} unit="DUSDC" />
      </div>

      {/* Filters */}
      <div className="scroll-quiet mb-4 flex items-center gap-1 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`flex-none rounded-md px-3 py-1.5 text-[12px] font-medium tracking-tight transition-colors ${
              filter === f.key
                ? 'bg-[var(--accent-soft)] text-text-1'
                : 'text-text-2 hover:bg-white/[0.04] hover:text-text-1'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Quest grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {visible.map((q, i) => (
          <QuestCard key={q.id} quest={q} index={i} />
        ))}
      </div>

      <FundingNote />

      <CrossLink
        href="/competitions"
        icon={LuSwords}
        eyebrow="Also coming"
        title="Compete in seasonal trading competitions"
      />
    </div>
  );
}

function QuestCard({ quest, index }: { quest: Quest; index: number }) {
  const cat = CAT[quest.category];
  const done = quest.progress >= 1;
  const started = quest.progress > 0 && !done;
  const Icon = quest.icon;

  return (
    <div
      className="glass-card rise relative flex flex-col gap-3.5 p-4"
      style={{ animationDelay: `${Math.min(index, 6) * 45}ms` }}
    >
      <div className="flex items-start gap-3">
        <span
          className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-xl"
          style={{ color: cat.hue, background: `color-mix(in srgb, ${cat.hue} 14%, transparent)` }}
        >
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[14px] font-semibold tracking-tight text-text-1">
              {quest.title}
            </h3>
          </div>
          <span className="eyebrow mt-1 block" style={{ color: cat.hue, opacity: 0.85 }}>
            {cat.label}
          </span>
        </div>
        {/* reward chip */}
        <span className="chip flex-none gap-1 px-2 py-1 text-[11px] font-semibold text-[var(--accent)]">
          <LuCoins size={12} />+{num(quest.reward, quest.reward < 1 ? 1 : 0)}
        </span>
      </div>

      <p className="text-[12px] leading-relaxed text-text-2">{quest.desc}</p>

      {/* progress */}
      <div className="mt-auto flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[10px]">
          <span className="font-mono tabular-nums text-text-3">{quest.label}</span>
          <span className="font-mono tabular-nums text-text-3">
            {Math.round(quest.progress * 100)}%
          </span>
        </div>
        <div className="meter">
          <i
            style={{
              width: `${Math.round(quest.progress * 100)}%`,
              background: done ? 'var(--accent)' : cat.hue,
              opacity: done ? 1 : 0.75,
            }}
          />
        </div>
      </div>

      {/* action — disabled preview state */}
      <button
        disabled
        className="glass-inset flex items-center justify-center gap-1.5 rounded-lg py-2 text-[12px] font-medium text-text-3"
      >
        {done ? (
          <>
            <LuCheck size={13} className="text-[var(--accent)]" />
            Ready to claim
          </>
        ) : started ? (
          <>
            <LuLock size={12} />
            Keep trading
          </>
        ) : (
          <>
            <LuLock size={12} />
            Not started
          </>
        )}
        <SoonChip />
      </button>
    </div>
  );
}

function SoonChip() {
  return (
    <span
      className="ml-1 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]"
      style={{ color: 'var(--warn)', background: 'var(--warn-soft)' }}
    >
      Soon
    </span>
  );
}

function HowStep({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="glass-inset flex items-start gap-3 p-3.5">
      <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full font-mono text-[11px] font-semibold text-[var(--accent)]" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}>
        {n}
      </span>
      <div>
        <h4 className="text-[12px] font-semibold tracking-tight text-text-1">{title}</h4>
        <p className="mt-0.5 text-[11px] leading-relaxed text-text-3">{body}</p>
      </div>
    </div>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="glass-inset flex flex-col gap-1 px-3 py-2.5">
      <span className="eyebrow">{label}</span>
      <span className="text-[15px] leading-none text-text-1">
        {value}
        {unit && <span className="ml-1 text-[10px] text-text-3">{unit}</span>}
      </span>
    </div>
  );
}
