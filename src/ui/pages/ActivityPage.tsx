import { Button, Card, Chip } from '@heroui/react';
import { useState } from 'react';
import type { ActivityEntry, WatchState } from '../../server/api.ts';
import { groupActivity, type ActivityItem } from '../activity.ts';
import { COLORS, type Color } from '../components/DeviceCard.tsx';
import { AlertIcon, ArrowIcon, CheckIcon, CrossIcon, SearchIcon, TargetIcon } from '../components/icons.tsx';
import { message, resultText, time } from '../format.ts';
import type { Texts } from '../texts.ts';
import { usePrefs } from '../usePrefs.ts';

// A state, with the target version where it is about one.
function stateText(state: WatchState, to: string | undefined, t: Texts): string {
  if (state === 'update' && to) return t.actUpdate(to);
  if (state === 'queued' && to) return t.actQueued(to);
  return t.actStates[state];
}

// What one line says, after the device's name.
function line(a: ActivityEntry, t: Texts): string {
  switch (a.type) {
    case 'found':
      return t.actFound(a.version, stateText(a.state, a.to, t));
    case 'back':
      return t.actBack(a.version, stateText(a.state, a.to, t));
    case 'left':
      return t.actLeft;
    case 'state':
      return t.actNow(stateText(a.state, a.to, t));
    case 'start':
      return t.actStart(a.to);
    case 'target':
      return t.actTarget(a.to);
    case 'problem':
      return a.problem === 'blocked' ? t.blockedTitle : a.problem === 'releases' ? `${t.releasesProblem}: ${message(a, t)}` : message(a, t);
    case 'result':
      return resultText(a.outcome, a.to, t, a.later);
  }
}

function tone(item: ActivityItem): Color {
  if (item.kind === 'wave') return item.target ? 'accent' : 'default';
  const a = item.entry;
  if (a.type === 'result') return a.outcome.result === 'done' ? 'success' : a.outcome.result === 'unconfirmed' ? 'warning' : 'danger';
  if (a.type === 'start' || a.type === 'target') return 'accent';
  if (a.type === 'problem') return 'danger';
  return 'default';
}

const DOT: Record<Color, string> = {
  success: 'bg-success-soft text-success-soft-foreground',
  warning: 'bg-warning-soft text-warning-soft-foreground',
  danger: 'bg-danger-soft text-danger-soft-foreground',
  accent: 'bg-accent-soft text-accent-soft-foreground',
  default: 'bg-default text-muted',
};

function Dot({ item }: { item: ActivityItem }) {
  const c = tone(item);
  const a = item.kind === 'line' ? item.entry : undefined;
  const Icon =
    item.kind === 'wave' ? (item.target ? TargetIcon : SearchIcon) : c === 'success' ? CheckIcon : c === 'danger' ? CrossIcon : c === 'warning' ? AlertIcon : a?.type === 'start' || a?.type === 'target' ? TargetIcon : SearchIcon;
  return (
    <span className={`flex size-7 shrink-0 items-center justify-center rounded-full ${DOT[c]}`}>
      <Icon size={15} />
    </span>
  );
}

function Line({ item }: { item: Extract<ActivityItem, { kind: 'line' }> }) {
  const { t } = usePrefs();
  const a = item.entry;
  const to = a.type === 'result' && a.outcome.result !== 'stopped' ? a.to : undefined;
  return (
    <div className="flex flex-col gap-1 pt-0.5">
      {a.name && <span className="font-semibold">{a.name}</span>}
      <span className="flex flex-wrap items-center gap-2 text-sm leading-relaxed">
        {item.from && to && (
          <span className="flex items-center gap-1.5 font-mono text-xs">
            <span className="rounded-md bg-surface-secondary px-1.5 py-0.5 text-muted">{item.from}</span>
            <ArrowIcon size={14} className="text-muted" />
            <span className="rounded-md bg-surface-secondary px-1.5 py-0.5">{to}</span>
          </span>
        )}
        <span className={a.name ? 'text-muted' : undefined}>{line(a, t)}</span>
      </span>
    </div>
  );
}

function Wave({ item }: { item: Extract<ActivityItem, { kind: 'wave' }> }) {
  const { t } = usePrefs();
  const [open, setOpen] = useState(false);
  const n = item.entries.length;
  const title = item.target
    ? t.actTarget(item.target.to)
    : { found: t.waveFound, back: t.waveBack, left: t.waveLeft, state: t.waveState }[item.type](n);
  const counts = new Map<WatchState, number>();
  for (const e of item.entries) if (e.type !== 'left') counts.set(e.state, (counts.get(e.state) ?? 0) + 1);
  return (
    <div className="flex flex-1 flex-col gap-2 pt-0.5">
      <span className="font-semibold">{title}</span>
      {n > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {[...counts].map(([state, count]) => (
            <Chip key={state} size="sm" variant="soft" color={COLORS[state]}>
              {t.states[state]} · {count}
            </Chip>
          ))}
          <Button size="sm" variant="ghost" aria-expanded={open} onPress={() => setOpen(!open)}>
            {open ? t.showLess : t.showAll(n)}
          </Button>
        </div>
      )}
      {open && (
        <ul className="m-0 flex list-none flex-col gap-2 rounded-xl bg-surface-secondary p-3 text-sm">
          {item.entries.map((e) => (
            <li key={e.id} className="flex flex-wrap justify-between gap-x-3">
              <span>{e.name}</span>
              <span className="text-muted">{line(e, t)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ActivityPage({ activity }: { activity: ActivityEntry[] }) {
  const { t } = usePrefs();
  const groups = groupActivity(activity);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="m-0 text-3xl font-bold tracking-tight">{t.activity}</h1>
      <Card className="p-0">
        <Card.Content className="p-0">
          {groups.length === 0 ? (
            <p className="m-0 p-5 text-sm text-muted">{t.activityEmpty}</p>
          ) : (
            <ol className="m-0 list-none p-0">
              {groups.map((g) => (
                <li key={g.at} className="flex gap-5 border-b border-separator px-5 py-4 last:border-b-0">
                  <span className="w-12 shrink-0 pt-1.5 font-mono text-xs text-muted">{time(g.at, t.locale)}</span>
                  <ul className="m-0 flex min-w-0 flex-1 list-none flex-col gap-4 p-0">
                    {g.items.map((item) => (
                      <li key={item.kind === 'line' ? item.entry.id : (item.target ?? item.entries[0]!).id} className="flex items-start gap-3">
                        <Dot item={item} />
                        {item.kind === 'line' ? <Line item={item} /> : <Wave item={item} />}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}
