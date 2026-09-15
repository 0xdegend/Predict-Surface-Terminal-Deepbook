'use client';

/**
 * Quests — trading milestones scored from the connected trader's own on-chain record.
 *
 * This page used to be a showcase: eight hardcoded percentages that looked like progress
 * and were not. The bars are real now. Every number below is folded from the wallet's own
 * order log plus its carried-over trades from retired deployments (lib/quests), using
 * queries the app already holds, so the page costs nothing extra to visit.
 *
 * What has NOT changed is the reward. Points are still unclaimable, and the claim button
 * is still disabled behind a "soon" chip. That combination is the honest one: your
 * progress is live, the rewards open later. Showing real progress against a disabled
 * claim is a straightforwardly better promise than illustrative numbers against the same
 * disabled claim, and nothing here grants anything, so a client-side read is safe. When
 * claiming opens it has to be scored server-side, which the pure evaluator already allows.
 *
 * Points rather than collateral is a deliberate anti-farming choice while this runs on
 * testnet: there is nothing to cash out, so there is nothing to sybil for.
 */
import { useMemo, useState } from 'react';
import {
  LuTarget,
  LuRocket,
  LuTrendingUp,
  LuZap,
  LuCompass,
  LuCoins,
  LuStar,
  LuCheck,
  LuLock,
  LuSwords,
  LuWallet,
} from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { num } from '@/lib/format';
import {
  QUESTS,
  QUEST_COLLATERAL,
  TOTAL_QUEST_POINTS,
  type QuestCategory,
  type QuestDef,
} from '@/config/quests';
import { useQuestProgress } from '@/lib/hooks/use-quest-progress';
import type { QuestProgress } from '@/lib/quests/evaluate';
import { HUE } from '../ui/metric';
import { RewardsHeader, FundingNote, CrossLink } from './shared';

/** What the numbers on a card mean: nobody connected, a scan in flight, or a real read. */
type QuestPhase = 'idle' | 'loading' | 'ready';

const CAT: Record<QuestCategory, { label: string; hue: string }> = {
  onboarding: { label: 'Onboarding', hue: HUE.teal },
  volume: { label: 'Volume', hue: HUE.amber },
  skill: { label: 'Skill', hue: HUE.violet },
  markets: { label: 'Markets', hue: HUE.blue },
};

/** Catalog icon ids resolved to components here, so config/quests stays free of React. */
const ICON: Record<QuestDef['icon'], IconType> = {
  rocket: LuRocket,
  coins: LuCoins,
  trending: LuTrendingUp,
  zap: LuZap,
  target: LuTarget,
  compass: LuCompass,
};

const FILTERS: { key: 'all' | QuestCategory; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'onboarding', label: 'Onboarding' },
  { key: 'volume', label: 'Volume' },
  { key: 'skill', label: 'Skill' },
  { key: 'markets', label: 'Markets' },
];

/** `competitionsHref` keeps the cross-link inside the caller's shell — legacy
 *  routes link `/competitions` (default), the v2 route passes `/v2/competitions`. */
export function QuestsPanel({ competitionsHref = '/competitions' }: { competitionsHref?: string } = {}) {
  const [filter, setFilter] = useState<'all' | QuestCategory>('all');
  const { tracking, isLoading, rows, earned, completed } = useQuestProgress();
  // One word for what the numbers mean right now, so no card has to re-derive it. A card
  // must not read "Not started" while the scan that would complete it is still running.
  const phase: QuestPhase = !tracking ? 'idle' : isLoading ? 'loading' : 'ready';

  // Catalog joined to progress by id rather than by index, so a reordered catalog or a
  // partial evaluation can never line a quest up against another quest's bar.
  const items = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    return QUESTS.map((def) => ({ def, progress: byId.get(def.id) })).filter(
      (x): x is { def: QuestDef; progress: QuestProgress } => !!x.progress,
    );
  }, [rows]);

  const visible = useMemo(
    () => (filter === 'all' ? items : items.filter((x) => x.def.category === filter)),
    [filter, items],
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5">
      <RewardsHeader
        icon={LuTarget}
        title="Quests"
        soonLabel="Rewards soon"
        blurb="Complete trading milestones to earn Skew Points, from your very first prediction to volume tiers, winning streaks and market coverage. Progress tracks automatically from your on-chain activity."
      />

      {/* How it works — the three-beat loop, compact */}
      <div className="mb-6 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <HowStep n={1} title="Trade" body="Mint positions on the live surface as you normally would." />
        <HowStep n={2} title="Progress" body="Each trade advances every quest it qualifies for, automatically." />
        <HowStep n={3} title="Claim" body="Hit the target and the Skew Points are credited to your profile." />
      </div>

      {/* Whose record this is. The page is worth reading before connecting, so this is a
          line rather than a gate: the quests stay visible, only the numbers wait. */}
      <div className="glass-inset mb-4 flex items-center gap-2.5 px-3.5 py-2.5">
        <LuWallet size={14} className={`flex-none ${tracking ? 'text-[var(--accent)]' : 'text-text-3'}`} />
        <p className="text-[12px] leading-relaxed text-text-2">
          {tracking
            ? isLoading
              ? 'Reading your trading record from chain.'
              : 'Tracking your live progress from your own on-chain trading record.'
            : 'Connect your wallet from the top bar to track your progress. Nothing is shared until you do.'}
        </p>
      </div>

      {/* Summary strip */}
      <div className="glass-card mb-5 grid grid-cols-3 gap-2.5 p-2.5 font-mono tabular-nums">
        <Stat
          label="Completed"
          value={phase === 'ready' ? `${completed} / ${QUESTS.length}` : `— / ${QUESTS.length}`}
        />
        <Stat label="Points earned" value={phase === 'ready' ? num(earned, 0) : '—'} unit="Points" />
        <Stat label="Reward pool" value={num(TOTAL_QUEST_POINTS, 0)} unit="Points" />
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
        {visible.map(({ def, progress }, i) => (
          <QuestCard key={def.id} def={def} progress={progress} phase={phase} index={i} />
        ))}
      </div>

      <FundingNote
        note={
          <>
            Quests reward Skew Points, not {QUEST_COLLATERAL}, points can&rsquo;t be cashed out
            directly, which keeps farmers and sybils off the loop while the system matures. Points
            feed your leaderboard standing today and unlock future rewards. Progress is read live
            from chain; claiming opens once the rewards rail ships.
          </>
        }
      />

      <CrossLink
        href={competitionsHref}
        icon={LuSwords}
        eyebrow="Also coming"
        title="Compete in seasonal trading competitions"
      />
    </div>
  );
}

function QuestCard({
  def,
  progress,
  phase,
  index,
}: {
  def: QuestDef;
  progress: QuestProgress;
  phase: QuestPhase;
  index: number;
}) {
  const cat = CAT[def.category];
  const Icon = ICON[def.icon];
  const ready = phase === 'ready';
  const done = ready && progress.state === 'complete';
  // Nothing is measuring this metric yet, so the card makes no claim about it. Distinct
  // from a measured zero, which is a real 0% the trader can move.
  const blocked = ready && progress.state === 'unavailable';
  const started = ready && progress.state === 'active' && progress.progress > 0;
  const pct = ready && !blocked ? Math.round(progress.progress * 100) : 0;

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
            <h3 className="truncate text-[14px] font-semibold tracking-tight text-text-1">{def.title}</h3>
          </div>
          <span className="eyebrow mt-1 block" style={{ color: cat.hue, opacity: 0.85 }}>
            {cat.label}
          </span>
        </div>
        {/* reward chip — Skew Points (not collateral) */}
        <span className="chip flex-none gap-1 px-2 py-1 text-[11px] font-semibold text-[var(--accent)]">
          <LuStar size={12} />+{num(def.points, 0)} pts
        </span>
      </div>

      <p className="text-[13px] leading-relaxed text-text-2">{def.desc}</p>

      {/* progress */}
      <div className="mt-auto flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[10px]">
          <span className="font-mono tabular-nums text-text-3">
            {ready ? progress.label : `0 / ${def.target}`}
          </span>
          <span className="font-mono tabular-nums text-text-3">{ready && !blocked ? `${pct}%` : '—'}</span>
        </div>
        <div className="meter">
          <i
            style={{
              width: `${pct}%`,
              background: done ? 'var(--accent)' : cat.hue,
              opacity: done ? 1 : 0.75,
            }}
          />
        </div>
      </div>

      {/* action — claiming stays closed while rewards are Points-only */}
      <button
        disabled
        className="glass-inset flex items-center justify-center gap-1.5 rounded-lg py-2 text-[12px] font-medium text-text-3"
      >
        {phase === 'idle' ? (
          <>
            <LuWallet size={12} />
            Connect to track
          </>
        ) : phase === 'loading' ? (
          <>
            <LuWallet size={12} className="animate-pulse" />
            Checking your record
          </>
        ) : blocked ? (
          <>
            <LuLock size={12} />
            Coming soon
          </>
        ) : done ? (
          <>
            <LuCheck size={13} className="text-[var(--accent)]" />
            Ready to claim
            <SoonChip />
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
      <span
        className="flex h-6 w-6 flex-none items-center justify-center rounded-full font-mono text-[11px] font-semibold text-[var(--accent)]"
        style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}
      >
        {n}
      </span>
      <div>
        <h4 className="text-[13px] font-semibold tracking-tight text-text-1">{title}</h4>
        <p className="mt-0.5 text-[12px] leading-relaxed text-text-3">{body}</p>
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
