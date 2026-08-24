'use client';

/**
 * DegenArena — Skew's faction competition surface (a PREVIEW; the roster is
 * illustrative, the countdown is real). Two zoom levels share one layout:
 *   · hub    → the faction leaderboard, with YOUR profile in the bento header
 *   · detail → one faction's members, with that faction's profile in the header
 *
 * Full-width bento: a header band (video hero + prize + countdown + identity +
 * faction) over a metrics strip, then the faction table at FULL width. No side
 * rail — everything tiles across the page so there are no empty columns.
 */
import { useState } from 'react';
import { LuSwords, LuTarget, LuUserPlus, LuUsers, LuCoins, LuTrophy, LuChevronLeft } from 'react-icons/lu';
import { SoonPill, FundingNote, CrossLink } from '../rewards/shared';
import { ArenaHeader } from './arena-header';
import { ArenaStatStrip } from './arena-stats';
import { FactionTable } from './faction-table';
import { FactionDetail } from './faction-detail';
import { FACTIONS, YOU, getFaction } from '@/lib/arena/data';

export function DegenArena({ questsHref = '/quests' }: { questsHref?: string } = {}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showRules, setShowRules] = useState(false);
  const selected = getFaction(selectedId);
  const mode: 'hub' | 'detail' = selected ? 'detail' : 'hub';

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-5">
      {/* Signal row — a clear back breadcrumb when drilled into a faction, else
          the page title. Preview pill stays (honest, like the other rewards pages). */}
      <div className="mb-4 flex items-center justify-between gap-3">
        {mode === 'detail' ? (
          <button
            onClick={() => setSelectedId(null)}
            className="group inline-flex items-center gap-1.5 text-[13px] font-medium text-text-2 transition-colors hover:text-text-1"
          >
            <LuChevronLeft size={16} className="transition-transform group-hover:-translate-x-0.5" />
            Back to Degen Arena
          </button>
        ) : (
          <h1 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-text-2">
            <LuSwords size={16} className="text-[var(--accent)]" /> Competitions
          </h1>
        )}
        <SoonPill label="Preview" />
      </div>

      {/* Full-width bento: header band → metrics strip → table/detail. */}
      <div className="flex flex-col gap-4">
        <ArenaHeader
          mode={mode}
          joined={mode === 'detail' && selected?.id === YOU.factionId}
          onToggleRules={() => setShowRules((v) => !v)}
          showRules={showRules}
          you={YOU}
          faction={selected ?? undefined}
          onSelectFaction={setSelectedId}
        />

        {showRules && <RulesPanel />}

        <ArenaStatStrip mode={mode} you={YOU} faction={selected ?? undefined} />

        {mode === 'detail' && selected ? (
          <FactionDetail faction={selected} />
        ) : (
          <FactionTable factions={FACTIONS} youFactionId={YOU.factionId} onSelect={setSelectedId} />
        )}
      </div>

      <FundingNote
        note={
          <>
            Prize pool is paid in DUSDC from the Skew treasury — funded by the 1% Skew fee, so it grows as
            the community trades. Factions, members and pools shown here are illustrative; the season clock is real.
          </>
        }
      />

      <CrossLink href={questsHref} icon={LuTarget} eyebrow="Also coming" title="Earn rewards from solo trading quests" />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * RulesPanel — the mechanic, in plain language: apply → join → two-level split.
 * Expanded from the hero's "Rules" toggle.
 * ------------------------------------------------------------------ */
function RulesPanel() {
  const steps = [
    {
      icon: LuUserPlus,
      hue: '#6aa6e6',
      title: 'Found or join a faction',
      body: 'Top traders apply to found a faction. Everyone else joins one, and your trading then counts toward its total.',
    },
    {
      icon: LuUsers,
      hue: '#9d92e8',
      title: 'Factions earn Points',
      body: 'Every position, range and referral earns Points. A faction’s Points are the sum of all its members’.',
    },
    {
      icon: LuTrophy,
      hue: '#e6b450',
      title: 'Rank sets the pool share',
      body: 'The Bonus pool is rank-weighted (top factions take more); the Base pool is split by Points. Together they’re the faction’s cut.',
    },
    {
      icon: LuCoins,
      hue: '#4dd6b0',
      title: 'Members split the cut',
      body: 'Inside a faction, your prize is your share of its Points × the faction’s pool. Perform on both levels to earn more.',
    },
  ];
  return (
    <div className="glass-card rise grid gap-3 rounded-2xl p-4 sm:grid-cols-2">
      {steps.map((s, i) => (
        <div key={s.title} className="flex items-start gap-3">
          <span
            className="mt-0.5 inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg font-mono text-[12px] font-semibold"
            style={{ color: s.hue, background: `color-mix(in srgb, ${s.hue} 15%, transparent)` }}
          >
            {i + 1}
          </span>
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-[13px] font-semibold text-text-1">
              <s.icon size={13} style={{ color: s.hue }} />
              {s.title}
            </span>
            <span className="text-[12px] leading-relaxed text-text-3">{s.body}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
