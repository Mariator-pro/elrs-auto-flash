import { Button, Card, Chip, Modal } from '@heroui/react';
import { useState } from 'react';
import type { ActivityEntry, DeviceView, WatchState } from '../../server/api.ts';
import { groupActivity, type ActivityItem } from '../activity.ts';
import { post } from '../api.ts';
import { COLORS, type Color } from '../stateColors.ts';
import { AlertIcon, ArrowIcon, CheckIcon, CrossIcon, PowerIcon, SearchIcon, TargetIcon } from '../components/icons.tsx';
import { time } from '../dates.ts';
import { dayHeading, message, resultText } from '../format.ts';
import { deviceNames } from '../names.ts';
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
    case 'launch':
      return t.actLaunch[a.by];
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
    item.kind === 'wave' ? (item.target ? TargetIcon : SearchIcon) : a?.type === 'launch' ? PowerIcon : c === 'success' ? CheckIcon : c === 'danger' ? CrossIcon : c === 'warning' ? AlertIcon : a?.type === 'start' || a?.type === 'target' ? TargetIcon : SearchIcon;
  return (
    <span className={`flex size-7 shrink-0 items-center justify-center rounded-full ${DOT[c]}`}>
      <Icon size={15} />
    </span>
  );
}

// The name of an entry's device as the cards call it now; a device no longer known keeps the name stored with the entry.
type NameOf = (a: ActivityEntry) => string | undefined;

function Line({ item, nameOf }: { item: Extract<ActivityItem, { kind: 'line' }>; nameOf: NameOf }) {
  const { t } = usePrefs();
  const a = item.entry;
  const to = a.type === 'result' && a.outcome.result !== 'stopped' ? a.to : undefined;
  const versions = !!(item.from && to);
  // with the versions shown, a done update says only that; what went wrong shows in red
  const done = a.type === 'result' && a.outcome.result === 'done';
  const text = done && versions ? (a.later ? t.resultConfirmedShort : t.resultUpdated) : line(a, t);
  const color = done && versions ? 'text-success' : tone(item) === 'danger' ? 'text-danger' : a.name ? 'text-muted' : undefined;
  return (
    <div className="flex flex-col gap-1 pt-0.5">
      {a.name && <span className="font-semibold">{nameOf(a)}</span>}
      <span className="flex flex-wrap items-center gap-2 text-sm leading-relaxed">
        {versions && (
          <span className="flex items-center gap-1.5 font-mono text-xs">
            <span className="rounded-md bg-surface-secondary px-1.5 py-0.5 text-muted">{item.from}</span>
            <ArrowIcon size={14} className="text-muted" />
            <span className="rounded-md bg-surface-secondary px-1.5 py-0.5">{to}</span>
          </span>
        )}
        <span className={color}>{text}</span>
      </span>
    </div>
  );
}

function Wave({ item, nameOf }: { item: Extract<ActivityItem, { kind: 'wave' }>; nameOf: NameOf }) {
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
              <span>{nameOf(e)}</span>
              <span className="text-muted">{line(e, t)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Asks before all lines are removed; they can't be brought back.
function ClearDialog({ onConfirm, onClose }: { onConfirm: () => void; onClose: () => void }) {
  const { t } = usePrefs();
  return (
    <Modal.Backdrop isOpen onOpenChange={(o) => !o && onClose()}>
      <Modal.Container>
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>{t.clearActivityTitle}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="text-sm leading-relaxed">
            <p className="m-0">{t.clearActivityText}</p>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="tertiary" onPress={onClose}>
              {t.cancel}
            </Button>
            <Button variant="danger" onPress={onConfirm}>
              {t.clearActivityConfirm}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

export function ActivityPage(props: { activity: ActivityEntry[]; devices: DeviceView[]; run: (fn: () => Promise<unknown>) => void }) {
  const { activity, devices, run } = props;
  const { t } = usePrefs();
  const names = deviceNames(devices);
  const nameOf: NameOf = (a) => (a.key && names.get(a.key)) || a.name;
  const [asking, setAsking] = useState(false);
  const groups = groupActivity(activity);
  const day = (iso: string) => new Date(iso).toDateString();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="m-0 text-3xl font-bold tracking-tight">{t.activity}</h1>
        {groups.length > 0 && (
          <Button variant="danger-soft" onPress={() => setAsking(true)}>
            {t.clearActivity}
          </Button>
        )}
      </div>
      {asking && (
        <ClearDialog
          onClose={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            run(() => post('/api/activity/clear'));
          }}
        />
      )}
      <Card className="overflow-hidden p-0">
        <Card.Content className="p-0">
          {groups.length === 0 ? (
            <p className="m-0 p-5 text-sm text-muted">{t.activityEmpty}</p>
          ) : (
            <ol className="m-0 list-none p-0">
              {groups.flatMap((g, i) => [
                ...(i === 0 || day(groups[i - 1]!.at) !== day(g.at)
                  ? [
                      <li key={`day-${g.at}`} className="border-b border-separator bg-surface-secondary px-5 py-2 text-xs font-semibold text-muted">
                        <h2 className="m-0 text-xs font-semibold">{dayHeading(g.at, t)}</h2>
                      </li>,
                    ]
                  : []),
                <li key={g.at} className="flex gap-5 border-b border-separator px-5 py-4 last:border-b-0">
                  <span className="w-16 shrink-0 pt-1.5 text-xs whitespace-nowrap text-muted tabular-nums">{time(g.at, t.locale)}</span>
                  <ul className="m-0 flex min-w-0 flex-1 list-none flex-col gap-4 p-0">
                    {g.items.map((item) => (
                      <li key={item.kind === 'line' ? item.entry.id : (item.target ?? item.entries[0]!).id} className="flex items-start gap-3">
                        <Dot item={item} />
                        {item.kind === 'line' ? <Line item={item} nameOf={nameOf} /> : <Wave item={item} nameOf={nameOf} />}
                      </li>
                    ))}
                  </ul>
                </li>,
              ])}
            </ol>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}
