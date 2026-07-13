'use client';

/**
 * DegenArena — Skew's faction competition surface (a PREVIEW; the roster is
 * illustrative, the countdown is real). Two zoom levels share one layout:
 *   · hub    → the faction leaderboard + your profile in the rail
 *   · detail → one faction's members + that faction's profile in the rail
 *
 * Layout mirrors the reference's three-band top row: on lg the left column
 * carries [banner | economics] over the table, and the right rail (profile)
 * spans alongside — so banner · economics · profile read as one band.
 */
import { useState } from 'react';
import { LuSwords, LuTarget, LuUserPlus, LuUsers, LuCoins, LuTrophy } from 'react-icons/lu';
import { SoonPill, FundingNote, CrossLink } from '../rewards/shared';
import { ArenaHero } from './arena-hero';
import { ProfileRail } from './profile-rail';
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
      {/* Signal row — this is a preview, kept honest like the other rewards pages */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-text-2">
          <LuSwords size={16} className="text-[var(--accent)]" /> Competitions
        </h1>
        <SoonPill label="Preview" />
      </div>

      {/* Two columns: left (hero + rules + table/detail) · right rail (profile) */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <ArenaHero
            mode={mode}
            joined={mode === 'detail' && selected?.id === YOU.factionId}
            onBack={() => setSelectedId(null)}
            onToggleRules={() => setShowRules((v) => !v)}
            showRules={showRules}
          />

          {showRules && <RulesPanel />}

          {mode === 'detail' && selected ? (
            <FactionDetail faction={selected} />
          ) : (
            <FactionTable factions={FACTIONS} youFactionId={YOU.factionId} onSelect={setSelectedId} />
          )}
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start">
          <ProfileRail mode={mode} you={YOU} faction={selected} onSelectFaction={setSelectedId} />
        </div>
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
      body: 'Top traders apply to found a faction. Everyone else joins one — your trading then counts toward its total.',
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
