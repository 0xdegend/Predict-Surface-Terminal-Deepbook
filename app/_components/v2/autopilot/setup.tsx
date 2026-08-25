'use client';

/**
 * Autopilot SETUP controls: the Auto/Manual fork, the preset picker, the money and
 * duration fields, the plan read-out, and the Customize drawer.
 *
 * Split out of autopilot-panel.tsx, which had grown past 2,400 lines. No behaviour
 * change: these are the same components, moved.
 */
import Image from 'next/image';
import type { IconType } from 'react-icons';
import { LuChevronDown, LuCircleCheck, LuFlame, LuScale, LuShieldCheck, LuSlidersHorizontal, LuSparkles, LuTrendingDown, LuTrendingUp } from 'react-icons/lu';
import { MASCOT_SRC } from '@/lib/mascot';
import { num } from '@/lib/format';
import type { Tenor, TradeSide } from '@/lib/autopilot/policy';
import { type AutopilotPreset, PRESETS, type PresetId, planSentence } from '@/lib/autopilot/presets';
import { type Limits, ModeTab, type Rules, type SetupMode } from './shared';

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const TENOR_LABEL: Record<Tenor, string> = { soonest: 'Minutes', hour: '~1 hour', today: 'Longer' };

const PROB_CHOICES = [0.55, 0.6, 0.65, 0.7, 0.75];

const LEV_CHOICES = [1, 2, 3];

const COOLDOWN_CHOICES = [30_000, 60_000, 90_000, 120_000];

const DURATION_CHOICES = [15, 30, 60, 120]; // minutes

function durationLabel(mins: number): string {
  return mins < 60 ? `${mins}m` : mins % 60 === 0 ? `${mins / 60}h` : `${(mins / 60).toFixed(1)}h`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="eyebrow">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  disabled,
  title,
  children,
}: {
  active: boolean;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-all duration-150 ${
        active
          ? 'border border-(--accent-line) bg-(--accent-soft) text-text-1'
          : 'glass-inset text-text-2 hover:text-text-1'
      } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
    >
      {children}
    </button>
  );
}

function NumField({
  label,
  value,
  onChange,
  min,
  max,
  prefix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  prefix?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="eyebrow">{label}</span>
      <div className="glass-inset flex items-center gap-1 px-2.5">
        {prefix && <span className="text-[13px] text-text-3">{prefix}</span>}
        <input
          type="number"
          inputMode="numeric"
          value={value}
          min={min}
          max={max}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isNaN(v)) onChange(clamp(Math.round(v), min, max));
          }}
          className="w-full min-w-0 bg-transparent py-2 text-[16px] font-mono tabular-nums text-text-1 outline-none"
        />
      </div>
    </label>
  );
}

/* ----------------------- setup: set it up for me ------------------------- */

/** The collapsed entry: a friendly nudge that opens Kelly's plain-words setup. */
/**
 * The fork at the top of setup: say it in words, or work the controls.
 *
 * Replaces the old "Set it up for me" teaser card. That card had to sell the assistant
 * from inside the manual layout, three items down the narrow column; as a tab it is
 * simply one of the two ways to do this, chosen before anything else is on screen.
 */
export function SetupModeTabs({ mode, onMode }: { mode: SetupMode; onMode: (m: SetupMode) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-white/4 p-1">
      <ModeTab
        active={mode === 'auto'}
        icon={LuSparkles}
        label="Auto"
        sub="Tell Kelly what you want"
        onClick={() => onMode('auto')}
      />
      <ModeTab
        active={mode === 'manual'}
        icon={LuSlidersHorizontal}
        label="Manual"
        sub="Set the controls yourself"
        onClick={() => onMode('manual')}
      />
    </div>
  );
}

/* --------------------- setup: Kelly's conversation ----------------------- */

const PRESET_ICON: Record<PresetId, IconType> = { cautious: LuShieldCheck, balanced: LuScale, bold: LuFlame };

const BUDGET_CHOICES = [10, 25, 50, 100];

const PERTRADE_CHOICES = [2, 5, 10, 25];

export function PresetPicker({ active, onApply }: { active: PresetId | null; onApply: (id: PresetId) => void }) {
  return (
    <div>
      <p className="eyebrow mb-2 flex items-center gap-1.5">
        <StepBadge n={1} /> How should Kelly bet?
        {active === null && (
          <span className="rounded-full bg-white/6 px-1.5 py-px text-[9.5px] font-medium text-text-2">Custom</span>
        )}
      </p>
      <div className="grid gap-2.5 sm:grid-cols-3">
        {PRESETS.map((p) => (
          <PresetCard key={p.id} preset={p} active={active === p.id} onClick={() => onApply(p.id)} />
        ))}
      </div>
    </div>
  );
}

function PresetCard({ preset, active, onClick }: { preset: AutopilotPreset; active: boolean; onClick: () => void }) {
  const Icon = PRESET_ICON[preset.id];
  // Defined once, rendered into whichever slot the breakpoint shows.
  const title = (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="text-[13.5px] font-semibold text-text-1">{preset.name}</span>
        {active && <LuCircleCheck size={13} className="flex-none text-accent" />}
      </div>
      <span className="text-[10.5px] text-text-3">{preset.tagline}</span>
    </div>
  );
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-col gap-2 rounded-xl border p-3 text-left transition-all duration-150 sm:p-3.5 ${
        active ? 'border-(--accent-line) bg-(--accent-soft)' : 'glass-inset border-transparent hover:border-white/10'
      }`}
    >
      {/* Phone: icon, name and dots on ONE row, so three choices cost ~170px instead of
          ~330px of a 390px-tall screen. From sm up the three cards sit side by side and
          the taller stacked card is the better read. */}
      <div className="flex items-center gap-3 sm:justify-between sm:gap-0">
        <span className={`flex h-8 w-8 flex-none items-center justify-center rounded-lg ${active ? 'bg-(--accent-soft)' : 'bg-white/6'}`}>
          <Icon size={16} className={active ? 'text-accent' : 'text-text-2'} />
        </span>
        <div className="min-w-0 flex-1 sm:hidden">{title}</div>
        <RiskDots level={preset.risk} active={active} />
      </div>
      <div className="hidden sm:block">{title}</div>
      {/* The blurb only on the ACTIVE card, and never on a phone: it is the tallest part
          of the card and the tagline already carries the choice. */}
      {active && <p className="hidden text-[11px] leading-relaxed text-text-2 sm:block">{preset.blurb}</p>}
    </button>
  );
}

/** A numbered step marker, so the manual controls read as a sequence. */
function StepBadge({ n }: { n: number }) {
  return (
    <span className="inline-grid h-4 w-4 flex-none place-items-center rounded-full bg-(--accent-soft) text-[9.5px] font-semibold text-accent ring-1 ring-inset ring-(--accent-line)">
      {n}
    </span>
  );
}

/**
 * PlanDetails — the settings the plan SENTENCE does not mention.
 *
 * Manual mode's second column held one short plan card and a lot of nothing, and the
 * page's real answer to "what exactly will it do" was buried inside a collapsed
 * Customize drawer. Both problems have the same fix: show the effective values here, in
 * plain words, and leave Customize as the place you go to CHANGE them. That is
 * progressive disclosure done properly, you can read your setup without opening
 * anything, and it fills the column with something true rather than filler.
 *
 * Deliberately complementary, never duplicative: the trade count, per-bet size, run
 * length, leverage cap and loss limit already live in the plan sentence directly above,
 * so they are not repeated here.
 */
export function PlanDetails({ rules, limits }: { rules: Rules; limits: Limits }) {
  const windows = rules.tenors.length
    ? (['soonest', 'hour', 'today'] as Tenor[]).filter((t) => rules.tenors.includes(t)).map((t) => TENOR_LABEL[t]).join(', ')
    : 'none picked';
  const sides =
    rules.sides.length === 2 ? 'UP and DOWN' : rules.sides.length === 1 ? rules.sides[0].toUpperCase() : 'none picked';
  const rows: { label: string; value: string }[] = [
    { label: 'Total budget', value: `$${num(limits.budgetUsd, 0)}` },
    { label: 'Only bets at least', value: `${Math.round(rules.minProb * 100)}% likely` },
    { label: 'Windows', value: windows },
    { label: 'Direction', value: sides },
    { label: 'At most open at once', value: `${limits.maxConcurrent}` },
    { label: 'Waits between bets', value: `${Math.round(limits.cooldownMs / 1000)}s` },
  ];
  return (
    <div className="glass-card p-4">
      <p className="eyebrow mb-3 flex items-center gap-1.5">
        <LuSlidersHorizontal size={12} className="text-accent" /> The rest of the settings
      </p>
      <dl className="flex flex-col gap-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-[11.5px] leading-snug text-text-3">{r.label}</dt>
            <dd className="text-right font-mono text-[12px] tabular-nums text-text-1">{r.value}</dd>
          </div>
        ))}
      </dl>
      <p className="glass-divider-top mt-3 pt-2.5 text-[10.5px] leading-relaxed text-text-3">
        Change any of these under Customize.
      </p>
    </div>
  );
}

function RiskDots({ level, active }: { level: 1 | 2 | 3; active: boolean }) {
  return (
    <span className="flex items-center gap-1" aria-label={`Risk level ${level} of 3`}>
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={`h-1.5 w-1.5 rounded-full ${i <= level ? (active ? 'bg-accent' : 'bg-text-2') : 'bg-white/12'}`}
        />
      ))}
    </span>
  );
}

/* ----------------------------- setup: money ------------------------------ */

export function MoneyCard({ limits, setLimits }: { limits: Limits; setLimits: (p: Partial<Limits>) => void }) {
  return (
    <div className="glass-card p-4">
      <p className="eyebrow mb-3 flex items-center gap-1.5">
        <StepBadge n={2} /> How much, and how long
      </p>
      <div className="flex flex-col gap-4">
        <MoneyField
          label="Total budget"
          hint="the most it can spend"
          value={limits.budgetUsd}
          choices={BUDGET_CHOICES}
          min={1}
          max={100_000}
          // Keep per-trade within the budget so a smaller budget can't imply a bigger bet.
          onChange={(v) => setLimits({ budgetUsd: v, perTradeUsd: Math.min(limits.perTradeUsd, v) })}
        />
        <MoneyField
          label="Each bet"
          hint="size per trade"
          value={limits.perTradeUsd}
          choices={PERTRADE_CHOICES}
          min={1}
          max={Math.max(1, limits.budgetUsd)}
          onChange={(v) => setLimits({ perTradeUsd: v })}
        />
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">For how long</span>
          <div className="flex flex-wrap gap-1.5">
            {DURATION_CHOICES.map((m) => (
              <Chip
                key={m}
                active={limits.armDurationMs === m * 60_000}
                onClick={() => setLimits({ armDurationMs: m * 60_000 })}
              >
                {durationLabel(m)}
              </Chip>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MoneyField({
  label,
  hint,
  value,
  choices,
  min,
  max,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  choices: number[];
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">{label}</span>
        {hint && <span className="text-[10px] text-text-3">{hint}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {choices.map((c) => (
          <Chip key={c} active={value === c} onClick={() => onChange(clamp(c, min, max))}>
            ${c}
          </Chip>
        ))}
        <div className="glass-inset flex items-center gap-0.5 px-2.5">
          <span className="text-[13px] text-text-3">$</span>
          <input
            type="number"
            inputMode="numeric"
            value={value}
            min={min}
            max={max}
            aria-label={`${label} (custom amount)`}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isNaN(v)) onChange(clamp(Math.round(v), min, max));
            }}
            className="w-14 min-w-0 bg-transparent py-1.5 font-mono text-[16px] tabular-nums text-text-1 outline-none"
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ setup: plan ------------------------------ */

export function PlanLine({
  rules,
  limits,
  live,
  presetId,
  avatar = true,
}: {
  rules: Rules;
  limits: Limits;
  /** null = the mode has not been chosen yet, so the plan stays quiet about it. */
  live: boolean | null;
  presetId: PresetId | null;
  /** Drop the inline fox where the surrounding shell already has one (the arm
   *  confirm peeks Kelly into its corner, so a second one inside would double her). */
  avatar?: boolean;
}) {
  const preset = presetId ? PRESETS.find((p) => p.id === presetId) : null;
  return (
    <div className="glass-inset flex items-start gap-3 border-l-2 border-(--accent-line) p-3.5">
      {avatar && (
        <Image
          src={MASCOT_SRC.thinking}
          alt=""
          width={32}
          height={32}
          aria-hidden
          className="mt-0.5 h-8 w-8 flex-none rounded-full object-contain"
        />
      )}
      <div className="min-w-0">
        <p className="eyebrow mb-1 flex items-center gap-1.5">
          The plan
          <span className="rounded-full bg-white/6 px-1.5 py-px text-[9.5px] font-medium text-text-2">
            {preset ? preset.name : 'Custom'}
          </span>
        </p>
        <p className="text-[13px] leading-relaxed text-text-1">{planSentence(rules, limits)}</p>
        {live != null && (
          <p className="mt-1 text-[11px] leading-relaxed text-text-3">
            {live ? 'Real DUSDC from your trading account.' : 'Watch mode: a live rehearsal, nothing is spent.'}
          </p>
        )}
      </div>
    </div>
  );
}

/* --------------------------- setup: customize ---------------------------- */

export function CustomizeSection({
  open,
  onToggle,
  custom,
  rules,
  limits,
  setRules,
  setLimits,
  toggleTenor,
  toggleSide,
}: {
  open: boolean;
  onToggle: () => void;
  custom: boolean;
  rules: Rules;
  limits: Limits;
  setRules: (p: Partial<Rules>) => void;
  setLimits: (p: Partial<Limits>) => void;
  toggleTenor: (t: Tenor) => void;
  toggleSide: (s: TradeSide) => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="glass-inset flex w-full items-center gap-2 rounded-lg px-4 py-2.5 text-left transition-colors hover:border-white/10"
      >
        <LuSlidersHorizontal size={13} className="flex-none text-accent" />
        <span className="text-[12.5px] font-medium text-text-1">Customize</span>
        <span className="text-[10.5px] text-text-3">optional</span>
        <span className="hidden text-[10.5px] text-text-3 sm:inline">· odds, leverage, windows, cooldown</span>
        {custom && (
          <span className="rounded-full bg-(--accent-soft) px-1.5 py-px text-[9.5px] font-medium text-accent">on</span>
        )}
        <LuChevronDown
          size={14}
          className={`ml-auto flex-none text-text-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <div className="glass-card p-4">
            <p className="eyebrow mb-3">How she picks</p>
            <div className="flex flex-col gap-3.5">
              <Field label="Only bet at least this likely">
                {PROB_CHOICES.map((p) => (
                  <Chip key={p} active={Math.abs(rules.minProb - p) < 1e-9} onClick={() => setRules({ minProb: p })}>
                    {Math.round(p * 100)}%
                  </Chip>
                ))}
              </Field>
              <Field label="Windows to trade">
                {(['soonest', 'hour', 'today'] as Tenor[]).map((t) => (
                  <Chip key={t} active={rules.tenors.includes(t)} onClick={() => toggleTenor(t)}>
                    {TENOR_LABEL[t]}
                  </Chip>
                ))}
              </Field>
              <Field label="Direction">
                <Chip active={rules.sides.includes('up')} onClick={() => toggleSide('up')}>
                  <LuTrendingUp size={12} className="mr-1 inline text-up" /> UP
                </Chip>
                <Chip active={rules.sides.includes('down')} onClick={() => toggleSide('down')}>
                  <LuTrendingDown size={12} className="mr-1 inline text-down" /> DOWN
                </Chip>
                <Chip active={false} disabled title="Range bets come next">
                  Range · soon
                </Chip>
              </Field>
              <Field label="Max leverage">
                {LEV_CHOICES.map((l) => (
                  <Chip key={l} active={rules.maxLeverage === l} onClick={() => setRules({ maxLeverage: l })}>
                    {l}x
                  </Chip>
                ))}
              </Field>
            </div>
          </div>

          <div className="glass-card p-4">
            <p className="eyebrow mb-3">Pacing and stops</p>
            <div className="flex flex-col gap-3.5">
              <div className="grid grid-cols-2 gap-3">
                <NumField
                  label="Max trades"
                  value={limits.maxTrades}
                  min={1}
                  max={100}
                  onChange={(v) => setLimits({ maxTrades: v })}
                />
                <NumField
                  label="Stop after losses"
                  value={limits.maxConsecutiveLosses}
                  min={1}
                  max={20}
                  onChange={(v) => setLimits({ maxConsecutiveLosses: v })}
                />
              </div>
              <Field label="Cooldown between trades">
                {COOLDOWN_CHOICES.map((c) => (
                  <Chip key={c} active={limits.cooldownMs === c} onClick={() => setLimits({ cooldownMs: c })}>
                    {c / 1000}s
                  </Chip>
                ))}
              </Field>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------- dashboard stats ---------------------------- */
