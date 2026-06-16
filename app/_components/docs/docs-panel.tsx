'use client';

/**
 * Docs — the Skew manual, written for a first-time trader. A single scroll-spy
 * page: a sticky section nav (a vertical rail on desktop, a horizontal pill bar
 * on mobile) tracks the section in view via IntersectionObserver and jumps on
 * click. Language is deliberately plain — every finance/crypto term is explained
 * in everyday words, and only the words a user actually sees in the app (UP/DOWN,
 * range, DUSDC, SUI, wallet) are kept. Instrument-styled per §10.1 (no
 * editorial/serif look): hairline-delimited sections, glass cards, mono values.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { IconType } from 'react-icons';
import {
  LuRocket,
  LuBoxes,
  LuTarget,
  LuCoins,
  LuReceipt,
  LuVault,
  LuTrophy,
  LuCircleHelp,
  LuBookOpen,
  LuInfo,
  LuTriangleAlert,
  LuArrowUp,
  LuArrowDown,
  LuChartArea,
  LuShieldAlert,
  LuSparkles,
  LuSwords,
  LuClock,
  LuGauge,
  LuMousePointerClick,
  LuHistory,
} from 'react-icons/lu';
import { HUE, IconChip } from '../ui/metric';

interface SectionMeta {
  id: string;
  label: string;
  icon: IconType;
}

const SECTIONS: SectionMeta[] = [
  { id: 'start', label: 'Getting started', icon: LuRocket },
  { id: 'surface', label: 'Reading the map', icon: LuBoxes },
  { id: 'instruments', label: 'Types of bets', icon: LuTarget },
  { id: 'minting', label: 'Placing & cashing out', icon: LuCoins },
  { id: 'fees', label: 'What it costs', icon: LuReceipt },
  { id: 'vault', label: 'Be the house', icon: LuVault },
  { id: 'ranks', label: 'Ranks & rewards', icon: LuTrophy },
  { id: 'faq', label: 'FAQ & help', icon: LuCircleHelp },
];

export function DocsPanel() {
  const [active, setActive] = useState<string>(SECTIONS[0].id);

  // Scroll-spy — observe each section; the one crossing the upper third of the
  // viewport becomes active. The observer is an external subscription (cleaned
  // up on unmount), so setState in its callback is the intended pattern.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-18% 0px -72% 0px', threshold: 0 },
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  function jump(id: string) {
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-5">
      {/* Header */}
      <div className="rise mb-6">
        <h1 className="flex items-center gap-2.5 text-[22px] font-semibold tracking-tight text-text-1">
          <LuBookOpen size={20} className="text-[var(--accent)]" />
          Docs
        </h1>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-text-2">
          New to Skew? You&apos;re in the right place. This guide explains, in plain English, how to
          make your first trade, how to read the live price map, and how everything works. Skew runs on
          a practice network, so you trade with free coins that have no real value — nothing here costs
          real money.
        </p>
      </div>

      {/* Mobile section pills — sticky under the header */}
      <div className="glass scroll-quiet sticky top-16 z-30 -mx-4 mb-5 flex gap-1 overflow-x-auto rounded-none border-x-0 px-4 py-2 lg:hidden">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => jump(s.id)}
            className={`flex-none rounded-md px-2.5 py-1.5 text-[11px] font-medium tracking-tight transition-colors ${
              active === s.id ? 'bg-[var(--accent-soft)] text-text-1' : 'text-text-2'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-10">
        {/* Desktop sticky rail */}
        <nav className="hidden lg:block">
          <div className="sticky top-24 flex flex-col gap-0.5">
            <span className="eyebrow mb-2 px-2.5">On this page</span>
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const on = active === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => jump(s.id)}
                  className={`group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12px] font-medium tracking-tight transition-colors ${
                    on ? 'bg-[var(--accent-soft)] text-text-1' : 'text-text-2 hover:bg-white/[0.04] hover:text-text-1'
                  }`}
                >
                  <Icon size={14} className={`flex-none ${on ? 'text-accent' : 'text-text-3'}`} />
                  {s.label}
                </button>
              );
            })}
          </div>
        </nav>

        {/* Content */}
        <div className="flex min-w-0 flex-col gap-12">
          <GettingStarted />
          <ReadingSurface />
          <Instruments />
          <Minting />
          <Fees />
          <VaultRisk />
          <Ranks />
          <Faq />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Section content
 * ------------------------------------------------------------------ */

function GettingStarted() {
  return (
    <Section id="start" icon={LuRocket} title="Getting started" hue={HUE.teal}>
      <Lead>
        Skew lets you make quick <b className="text-text-1">yes / no bets</b> on which way a price (like
        Bitcoin) will move over the next few minutes. Here&apos;s how to make your first one:
      </Lead>
      <Flow>
        <FlowStep n={1} title="Connect a wallet">
          A <b className="text-text-1">wallet</b> is your login and your account rolled into one. Tap the
          button at the top-right. The easiest option is to sign in with Google — it&apos;s free and you
          won&apos;t pay any network fees. You can also connect a Sui wallet like Slush.
        </FlowStep>
        <FlowStep n={2} title="Get some practice coins">
          You bet using a coin called <b className="text-text-1">DUSDC</b>. New accounts get a small
          amount automatically the first time, so you can start right away.
        </FlowStep>
        <FlowStep n={3} title="Pick something to bet on">
          Click any point on the live map (explained next), or choose a market from the list. Your bet
          slip fills in with the details.
        </FlowStep>
        <FlowStep n={4} title="Choose your amount and place it">
          Type how much you want to stake, check the cost, and confirm. Your bet then shows up on your{' '}
          <Anchor href="/portfolio">Portfolio</Anchor> page, where you can watch how it&apos;s doing.
        </FlowStep>
      </Flow>
      <Callout tone="info" title="It's all practice money">
        Skew runs on a test network. The DUSDC you trade with has{' '}
        <b className="text-text-1">no real-world value</b> — it&apos;s there so you can learn the ropes
        without any risk.
      </Callout>
    </Section>
  );
}

function ReadingSurface() {
  return (
    <Section id="surface" icon={LuBoxes} title="Reading the map" hue={HUE.blue}>
      <Lead>
        The big 3-D shape in the middle is a <b className="text-text-1">live map of every bet you can
        make</b>. Instead of a long, boring list, Skew lays them out as a landscape you can explore.
        The three directions each mean something:
      </Lead>
      <Cards>
        <Card icon={LuTarget} hue={HUE.blue} title="Left ↔ right: the price">
          This is the price level your bet is about — for example, &ldquo;will Bitcoin be above
          $65,000?&rdquo;
        </Card>
        <Card icon={LuClock} hue={HUE.violet} title="Front ↔ back: the deadline">
          How soon the bet is decided. Skew&apos;s markets are fast — many finish in about 15 minutes.
        </Card>
        <Card icon={LuSparkles} hue={HUE.amber} title="Up & color: how jumpy">
          The height (and color, cool to warm) shows how big a price swing the market expects. Taller
          and warmer means the market thinks the price could move a lot.
        </Card>
      </Cards>
      <SubHead icon={LuMousePointerClick} title="Hover and click" />
      <P>
        Move your pointer over any point to see its details — the price level, the odds for each side,
        and the deadline. Click a point to load that exact bet into your slip. The map is the controls:
        what you see is what you trade.
      </P>
      <SubHead icon={LuHistory} title="Rewind time" />
      <P>
        Drag the time slider to replay how the map looked a little while ago — it morphs smoothly so you
        can watch how the odds shifted. Press <Mono>LIVE</Mono> to jump back to right now.
      </P>
      <SubHead icon={LuTriangleAlert} title="The built-in sanity check" />
      <P>
        Turn on the checker and Skew highlights any prices that don&apos;t quite add up — for example, a
        bet that looks cheaper than a safer one sitting right next to it. On a healthy market this stays
        quiet; there&apos;s a &ldquo;stress&rdquo; switch that nudges the numbers so you can see the
        warning light up.
      </P>
      <SubHead icon={LuChartArea} title="Map or plain chart" />
      <P>
        Prefer a normal price chart? Use the switch at the top-left of the map to flip between the 3-D{' '}
        <Mono>Surface</Mono> map and a regular <Mono>Chart</Mono>.
      </P>
      <Callout tone="warn" title="Why do the “jumpiness” numbers look so big?">
        Because these bets are decided so quickly (often ~15 minutes), even a small price move counts as
        a big swing in percentage terms. So those readings naturally look high — that&apos;s normal, not
        a glitch.
      </Callout>
    </Section>
  );
}

function Instruments() {
  return (
    <Section id="instruments" icon={LuTarget} title="Types of bets" hue={HUE.violet}>
      <Lead>
        There are two kinds of bets. Both pay you a fixed <Mono>$1 for each unit</Mono> you hold when
        you win — and you decide how many units to buy (that&apos;s your stake).
      </Lead>
      <Cards>
        <Card icon={LuArrowUp} hue={HUE.teal} title="Up or Down">
          A simple direction bet on one price level. Pick <b className="text-text-1">UP</b> if you think
          the price will finish above it, or <b className="text-text-1">DOWN</b> if you think it&apos;ll
          finish at or below. Win and each unit pays $1; lose and it pays nothing.
        </Card>
        <Card icon={LuArrowDown} hue={HUE.coral} title="In a range">
          A bet that the price finishes <b className="text-text-1">between</b> two levels you choose. If
          it lands inside your range, each unit pays $1. It doesn&apos;t matter which way the price moves
          — only where it ends up.
        </Card>
      </Cards>
      <KeyTable
        rows={[
          ['Most you can win', 'your units × $1'],
          ['What you pay', 'set by the live market, shown before you confirm'],
          ['Break-even', 'shown in your slip as you change the amount'],
        ]}
      />
    </Section>
  );
}

function Minting() {
  return (
    <Section id="minting" icon={LuCoins} title="Placing & cashing out" hue={HUE.amber}>
      <Lead>
        Placing a bet is one quick step, even though a few things happen behind the scenes. When you tap
        the button:
      </Lead>
      <Flow>
        <FlowStep n={1} title="Your account is set up">
          The very first time, Skew creates your trading account automatically. You don&apos;t have to
          do anything.
        </FlowStep>
        <FlowStep n={2} title="Your bet is placed">
          Your coins and your bet are handled together in a single confirmation — you only sign once.
        </FlowStep>
        <FlowStep n={3} title="Watch it live">
          Your open bets appear on your <Anchor href="/portfolio">Portfolio</Anchor> and update in real
          time as the price moves, so you can see whether you&apos;re ahead or behind.
        </FlowStep>
        <FlowStep n={4} title="Cash out">
          Close a bet whenever you like. Once a market reaches its deadline, winning bets can be paid out
          automatically — Skew can even collect them for you.
        </FlowStep>
      </Flow>
      <Callout tone="accent" title="No surprises on price">
        The price you&apos;re shown comes straight from the live market the instant before you confirm —
        so the amount you see is exactly what you pay. It&apos;s never a rough guess.
      </Callout>
    </Section>
  );
}

function Fees() {
  return (
    <Section id="fees" icon={LuReceipt} title="What it costs" hue={HUE.teal}>
      <Lead>
        Your bet slip always splits the total into two clear lines, so you know exactly where your money
        goes:
      </Lead>
      <Cards>
        <Card icon={LuCoins} hue={HUE.amber} title="Your bet">
          The cost of the bet itself, set by the live market. This goes into the shared pool that pays
          out the winners.
        </Card>
        <Card icon={LuReceipt} hue={HUE.teal} title="Skew fee — 1%">
          A small fee of 1% on top of your bet, charged only when you place a bet (never when you cash
          out). It supports building Skew.
        </Card>
      </Cards>
      <KeyTable
        rows={[
          ['Charged', 'only when you place a bet'],
          ['How much', '1% of the bet'],
          ['Your bet goes to', 'the shared payout pool'],
          ['The fee goes to', 'Skew'],
        ]}
      />
    </Section>
  );
}

function VaultRisk() {
  return (
    <Section id="vault" icon={LuVault} title="Be the house" hue={HUE.blue}>
      <Lead>
        Every bet is paid out from a shared pool of money. Instead of betting, you can put money{' '}
        <b className="text-text-1">into</b> that pool — basically becoming &ldquo;the house&rdquo; — and
        earn a share of the fees as people trade.
      </Lead>
      <Cards>
        <Card icon={LuVault} hue={HUE.teal} title="Join the pool">
          Add DUSDC to the pool and earn a cut whenever people trade. You can take your money back out,
          depending on how much is available at the time. See <Anchor href="/vault">Vault</Anchor>.
        </Card>
        <Card icon={LuShieldAlert} hue={HUE.amber} title="Join with a safety net">
          A one-click option that adds you to the pool and also buys a bit of protection in case the
          market moves sharply against it — all in a single step.
        </Card>
        <Card icon={LuGauge} hue={HUE.violet} title="Check the health">
          A dashboard showing how busy the pool is, how much can be withdrawn, and a &ldquo;what if the
          price suddenly jumped?&rdquo; simulator so you can see how the pool would hold up. See{' '}
          <Anchor href="/risk">Vault Risk</Anchor>.
        </Card>
      </Cards>
    </Section>
  );
}

function Ranks() {
  return (
    <Section id="ranks" icon={LuTrophy} title="Ranks & rewards" hue={HUE.amber}>
      <Lead>The more you trade, the higher you climb — and rewards are on the way.</Lead>
      <Cards>
        <Card icon={LuTrophy} hue={HUE.amber} title="Leaderboard">
          Every trader is ranked by points, updated live. See where you stand on the{' '}
          <Anchor href="/leaderboard">Leaderboard</Anchor>.
        </Card>
        <Card icon={LuSparkles} hue={HUE.teal} title="Points">
          You earn points for three things: how much you trade, how well your bets do (you&apos;re never
          penalized for losses), and how long you hold. It&apos;s all worked out from your real activity.
        </Card>
        <Card icon={LuSwords} hue={HUE.violet} title="Quests & Competitions">
          <SoonTag /> <Anchor href="/quests">Quests</Anchor> (rewards for hitting trading milestones) and
          seasonal <Anchor href="/competitions">Competitions</Anchor> (contests with prize pools) are on
          the way.
        </Card>
      </Cards>
    </Section>
  );
}

function Faq() {
  return (
    <Section id="faq" icon={LuCircleHelp} title="FAQ & help" hue={HUE.coral}>
      <div className="flex flex-col gap-2.5">
        <QA q="Which wallet should I use?">
          Signing in with Google is the simplest — it&apos;s free and skips network fees. You can also
          connect a Sui wallet like Slush. Either way, make sure it&apos;s set to the{' '}
          <b className="text-text-1">Test network</b>.
        </QA>
        <QA q="How do I get coins to trade with?">
          New accounts get a small amount of practice DUSDC automatically the first time. If that&apos;s
          ever unavailable, Skew points you to a free faucet — a page that hands out test coins.
        </QA>
        <QA q="What are network fees, and do I pay them?">
          Sui (the network Skew runs on) charges a tiny fee for each action, paid in a coin called SUI.
          If you sign in with Google, these are covered for you. If you use your own wallet you pay them
          — and brand-new wallets get a little SUI to start.
        </QA>
        <QA q="I saw “market just expired” or a fee error.">
          The market you picked just reached its deadline or refreshed. Click a point on the map again to
          load a current one. If it keeps happening, check that your wallet is on the Test network — some
          default to the main one.
        </QA>
        <QA q="Can I use Skew on my phone?">
          Yes. Tap a market to open the bet slip. The 3-D map is easiest to explore on a bigger screen,
          but placing bets, cashing out, and your portfolio all work on a phone.
        </QA>
        <QA q="Is any of this real money?">
          No. Skew runs on a test network with practice coins that have no value. It&apos;s a safe place
          to learn.
        </QA>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

function Section({
  id,
  icon,
  title,
  hue,
  children,
}: {
  id: string;
  icon: IconType;
  title: string;
  hue: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-32 lg:scroll-mt-24">
      <div className="mb-4 flex items-center gap-2.5">
        <IconChip icon={icon} color={hue} size={28} />
        <h2 className="text-[17px] font-semibold tracking-tight text-text-1">{title}</h2>
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

function Lead({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] leading-relaxed text-text-2">{children}</p>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-[12.5px] leading-relaxed text-text-2">{children}</p>;
}

function SubHead({ icon: Icon, title }: { icon: IconType; title: string }) {
  return (
    <h3 className="mt-1 flex items-center gap-2 text-[13px] font-semibold tracking-tight text-text-1">
      <Icon size={14} className="text-text-3" />
      {title}
    </h3>
  );
}

function Cards({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{children}</div>;
}

function Card({
  icon: Icon,
  hue,
  title,
  children,
}: {
  icon: IconType;
  hue: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="glass-card flex flex-col gap-2.5 rounded-2xl p-4">
      <div className="flex items-center gap-2.5">
        <span
          className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-xl"
          style={{ color: hue, background: `color-mix(in srgb, ${hue} 14%, transparent)` }}
        >
          <Icon size={16} />
        </span>
        <h4 className="text-[13px] font-semibold tracking-tight text-text-1">{title}</h4>
      </div>
      <p className="text-[12px] leading-relaxed text-text-2">{children}</p>
    </div>
  );
}

function Flow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-2">{children}</div>;
}

function FlowStep({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="glass-inset flex items-start gap-3 rounded-xl p-3.5">
      <span
        className="flex h-6 w-6 flex-none items-center justify-center rounded-full font-mono text-[11px] font-semibold text-[var(--accent)]"
        style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}
      >
        {n}
      </span>
      <div className="min-w-0">
        <h4 className="text-[12.5px] font-semibold tracking-tight text-text-1">{title}</h4>
        <p className="mt-1 text-[12px] leading-relaxed text-text-2">{children}</p>
      </div>
    </div>
  );
}

function KeyTable({ rows }: { rows: [string, string][] }) {
  return (
    <div className="glass-card overflow-hidden rounded-2xl">
      <div className="rows-divided">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 px-4 py-2.5">
            <span className="text-[12px] text-text-3">{k}</span>
            <span className="text-right font-mono text-[12px] tabular-nums text-text-1">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function QA({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="glass-card rounded-2xl p-4">
      <h4 className="flex items-start gap-2 text-[13px] font-semibold tracking-tight text-text-1">
        <LuInfo size={14} className="mt-0.5 flex-none text-text-3" />
        {q}
      </h4>
      <p className="mt-1.5 pl-6 text-[12px] leading-relaxed text-text-2">{children}</p>
    </div>
  );
}

function Callout({
  tone,
  title,
  children,
}: {
  tone: 'info' | 'warn' | 'accent';
  title: string;
  children: React.ReactNode;
}) {
  const Icon = tone === 'warn' ? LuTriangleAlert : tone === 'accent' ? LuSparkles : LuInfo;
  const color = tone === 'warn' ? 'var(--warn)' : tone === 'accent' ? 'var(--accent)' : HUE.blue;
  return (
    <div
      className="glass-inset flex items-start gap-3 rounded-xl p-3.5"
      style={{ borderColor: `color-mix(in srgb, ${color} 28%, transparent)` }}
    >
      <Icon size={16} className="mt-px flex-none" style={{ color }} />
      <div className="min-w-0">
        <h4 className="text-[12.5px] font-semibold tracking-tight text-text-1">{title}</h4>
        <p className="mt-1 text-[12px] leading-relaxed text-text-2">{children}</p>
      </div>
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[0.92em] text-text-1">{children}</span>;
}

function Anchor({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-[var(--accent)] underline-offset-2 hover:underline">
      {children}
    </Link>
  );
}

function SoonTag() {
  return (
    <span
      className="mr-1.5 inline-block rounded px-1.5 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-widest"
      style={{ color: 'var(--warn)', background: 'var(--warn-soft)' }}
    >
      Soon
    </span>
  );
}
