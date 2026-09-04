'use client';

/**
 * Autopilot SETUP controls: the Auto/Manual fork, the preset picker, the money and
 * duration fields, the plan read-out, and the Customize drawer.
 *
 * Split out of autopilot-panel.tsx, which had grown past 2,400 lines. No behaviour
 * change: these are the same components, moved.
 */
import type { IconType } from 'react-icons';
import { LuArrowLeftRight, LuChevronDown, LuCircleCheck, LuFlame, LuMessageSquare, LuScale, LuShieldCheck, LuSlidersHorizontal, LuTrendingDown, LuTrendingUp } from 'react-icons/lu';
import { num } from '@/lib/format';
import type { Tenor, TradeSide } from '@/lib/autopilot/policy';
import { PRESETS, type PresetId } from '@/lib/autopilot/presets';
import { type Limits, ModeTab, type Rules, type SetupMode } from './shared';

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const TENOR_LABEL: Record<Tenor, string> = { soonest: 'Minutes', hour: '~1 hour', today: 'Longer' };

const PROB_CHOICES = [0.55, 0.6, 0.65, 0.7, 0.75];

const LEV_CHOICES = [1, 2, 3];

const COOLDOWN_CHOICES = [30_000, 60_000, 90_000, 120_000];

/** "45s" under a minute, "3 min" on the minute, "2.5 min" between. */
function cooldownLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = s / 60;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
}

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
  mono,
  children,
}: {
  active: boolean;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  /** The chip holds a VALUE ($25, 65%, 90s) rather than a word. Those get the mono face
   *  with tabular figures, the same as every other number in the terminal, so a row of
   *  amounts lines up and so a chip does not disagree with the input sitting beside it
   *  (the custom-amount field next to the money chips was mono all along). Word chips
   *  keep the UI face: "Minutes" and "UP" are labels, not readings. */
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-all duration-150 ${
        mono ? 'font-mono tabular-nums' : ''
      } ${
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
      {/* A chat bubble, not sparkles. The pair has to read as two ways of doing the same
          job, and sparkles says "AI magic" where the sibling says "controls". A bubble
          and a set of sliders are both plain descriptions of an interface. */}
      <ModeTab
        active={mode === 'auto'}
        icon={LuMessageSquare}
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

/**
 * PresetPicker — one control with three stops, not three sibling cards.
 *
 * WHY IT CHANGED. Careful, Balanced and Bold are an ORDERED ramp, and three equal boxes
 * flattened that into a menu: nothing on screen said Bold sat further along the same axis
 * than Careful. The blurb also rendered on the ACTIVE card only, which left the other two
 * as half-empty boxes beside a full one, and the ragged bottoms were most of what made
 * this step look unfinished. Each option now carries a three-segment rail that fills to
 * its own level, so scanning the row reads the ramp straight off, and the blurb is one
 * line under all three that always renders.
 *
 * NO RULES. The three used to be one frame carved up by hairlines: a border under the
 * heading, two verticals between the options, one more above the blurb. Four hard lines
 * on a step with three choices on it, and they were the only stark rules anywhere in the
 * manual column, which is why this card read as a table while everything around it read
 * as glass. The options are `glass-inset` tiles now, the same material the meters and the
 * stat band are made of, so the separation comes from the surfaces themselves. Chosen is
 * `glass-accent`, the house's accent-washed glass.
 *
 * The two glass classes are deliberately either/or rather than stacked. Both set the
 * `background` and `border` shorthands at the same specificity, so which one won would
 * come down to their order in globals.css: fine today, wrong the first time anyone moves
 * a block. One class per state means there is nothing to resolve.
 *
 * Hover is `.interactive`, not a `hover:border-*` utility. Everything in globals.css is
 * unlayered and Tailwind's utilities are in `@layer utilities`, so `.glass-inset`'s
 * `border` shorthand beats any hover utility outright and the edge never moved. See the
 * `.glass-inset.interactive` rule beside the base class.
 */
export function PresetPicker({ active, onApply }: { active: PresetId | null; onApply: (id: PresetId) => void }) {
  const chosen = active ? (PRESETS.find((p) => p.id === active) ?? null) : null;
  return (
    <div className="glass-card p-3.5">
      <p className="eyebrow mb-3 flex items-center gap-1.5">
        <StepBadge n={1} /> How should Kelly bet?
        {active === null && (
          <span className="rounded-full bg-white/6 px-1.5 py-px text-[9.5px] font-medium text-text-2">Custom</span>
        )}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {PRESETS.map((p) => {
          const on = active === p.id;
          const Icon = PRESET_ICON[p.id];
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              onClick={() => onApply(p.id)}
              className={`flex items-center gap-3 p-3 text-left transition-all duration-200 sm:flex-col sm:items-stretch sm:gap-2.5 ${
                on ? 'glass-accent rounded-xl' : 'glass-inset interactive'
              }`}
            >
              {/* A chip that stays raised on both surfaces: accent-soft would sink into
                  the accent wash of a chosen tile, so that one lifts with plain white. */}
              <span
                className={`flex h-8 w-8 flex-none items-center justify-center rounded-lg ${
                  on ? 'bg-white/10' : 'bg-white/6'
                }`}
              >
                <Icon size={16} className={on ? 'text-accent' : 'text-text-2'} />
              </span>
              <span className="min-w-0 flex-1 sm:flex-none">
                <span className="flex items-center gap-1.5">
                  <span className={`text-[13.5px] font-semibold ${on ? 'text-text-1' : 'text-text-2'}`}>{p.name}</span>
                  {on && <LuCircleCheck size={13} className="flex-none text-accent" />}
                </span>
                <span className="block text-[10.5px] text-text-3">{p.tagline}</span>
              </span>
              <RiskRail level={p.risk} active={on} />
            </button>
          );
        })}
      </div>
      {/* One line, always rendered. Fixed height whatever is selected, and it covers the
          Custom case too, which the per-card version could not: with nothing selected
          there was no card to hang an explanation on. Spacing separates it from the tiles
          now, not a rule: it is a caption for the row above it, and the row is already
          three distinct surfaces with air around them. */}
      <p className="mt-3 px-0.5 text-[11px] leading-relaxed text-text-2">
        {chosen ? chosen.blurb : 'Your own mix. Everything below is set by hand, and the plan updates as you change it.'}
      </p>
    </div>
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
  const sideNames = (['up', 'down', 'range'] as TradeSide[])
    .filter((side) => rules.sides.includes(side))
    .map((side) => (side === 'range' ? 'range' : side.toUpperCase()));
  const sides =
    sideNames.length === 0
      ? 'none picked'
      : sideNames.length === 1
        ? sideNames[0]
        : `${sideNames.slice(0, -1).join(', ')} and ${sideNames[sideNames.length - 1]}`;
  const rows: { label: string; value: string }[] = [
    { label: 'Total budget', value: `$${num(limits.budgetUsd, 0)}` },
    { label: 'Only bets at least', value: `${Math.round(rules.minProb * 100)}% likely` },
    { label: 'Windows', value: windows },
    { label: 'Direction', value: sides },
    { label: 'At most open at once', value: `${limits.maxConcurrent}` },
    { label: 'Waits between bets', value: cooldownLabel(limits.cooldownMs) },
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

/**
 * Risk as a level meter, not three loose dots.
 *
 * Same information, read differently: a rail that fills further along the row makes the
 * ordering visible at a glance, where three dots read as a rating on each card on its own.
 * On a phone it is a fixed 12 units wide at the end of the row; from `sm` it spans the
 * full width of its column, under the name, which is where the ramp reads best.
 */
function RiskRail({ level, active }: { level: 1 | 2 | 3; active: boolean }) {
  return (
    <span className="flex w-12 flex-none items-center gap-0.5 sm:w-full" aria-label={`Risk level ${level} of 3`}>
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={`h-1 flex-1 rounded-full transition-colors ${
            i <= level ? (active ? 'bg-accent' : 'bg-text-3') : 'bg-white/8'
          }`}
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
                mono
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
          <Chip key={c} mono active={value === c} onClick={() => onChange(clamp(c, min, max))}>
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
                  <Chip key={p} mono active={Math.abs(rules.minProb - p) < 1e-9} onClick={() => setRules({ minProb: p })}>
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
                <Chip active={rules.sides.includes('range')} onClick={() => toggleSide('range')}>
                  <LuArrowLeftRight size={12} className="mr-1 inline text-accent" /> Range
                </Chip>
              </Field>
              <Field label="Max leverage">
                {LEV_CHOICES.map((l) => (
                  <Chip key={l} mono active={rules.maxLeverage === l} onClick={() => setRules({ maxLeverage: l })}>
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
                {/* A paced gap (say 3 minutes for a 15-minute careful run) is not one of the
                    fixed choices, so it joins them as a chip rather than leaving none lit. */}
                {[...new Set([...COOLDOWN_CHOICES, limits.cooldownMs])]
                  .sort((a, b) => a - b)
                  .map((c) => (
                    <Chip key={c} mono active={limits.cooldownMs === c} onClick={() => setLimits({ cooldownMs: c })}>
                      {cooldownLabel(c)}
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
