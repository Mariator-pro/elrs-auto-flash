import { Alert, Button } from '@heroui/react';
import type { DeviceView, StateView, WatchState } from '../../server/api.ts';
import { post } from '../api.ts';
import { DeviceCard } from '../components/DeviceCard.tsx';
import { message, sentence, time } from '../format.ts';
import { usePrefs } from '../usePrefs.ts';

type Run = (fn: () => Promise<unknown>) => void;

// Devices with something going on first, the ones that are up to date last.
const ORDER: WatchState[] = [
  'flashing',
  'queued',
  'update',
  'mismatch',
  'failed',
  'custom-build',
  'unconfirmed',
  'unsupported',
  'newer',
  'no-target-version',
  'current',
];
const sorted = (list: DeviceView[]) =>
  [...list].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (a.product ?? a.ip).localeCompare(b.product ?? b.ip));

export function DevicesPage({ state, run, onSettings }: { state: StateView; run: Run; onSettings: () => void }) {
  const { t } = usePrefs();
  const online = sorted(state.devices.filter((d) => d.online));
  const away = sorted(state.devices.filter((d) => !d.online));
  const noticed = state.devices.filter((d) => d.notice);
  const act = (path: string, key: string) => run(() => post(path, { key }));
  const card = (d: DeviceView) => (
    <DeviceCard
      key={d.key}
      d={d}
      target={state.target}
      autoUpdate={state.settings.autoUpdate}
      onUpdate={() => run(() => post('/api/devices/update', { key: d.key, state: d.state }))}
      onDismiss={() => act('/api/devices/dismiss', d.key)}
      onForget={() => act('/api/devices/forget', d.key)}
      onRename={(name) => run(() => post('/api/devices/rename', { key: d.key, name }))}
    />
  );
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="m-0 text-3xl font-bold tracking-tight">{t.devices}</h1>
        <span className="inline-flex items-center gap-2 text-sm text-muted">
          {/* a ring runs out of the dot while the search goes on, which it always does; none with reduced motion */}
          <span className="relative flex size-2" aria-hidden="true">
            <span className="absolute inline-flex size-full rounded-full bg-success opacity-75 motion-safe:animate-ping" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
          {t.looking}
          {state.lastScan && ` · ${t.scannedAt(time(state.lastScan, t.locale))}`}
        </span>
      </div>

      {state.settings.targetMajor === undefined && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.noTargetTitle}</Alert.Title>
            <Alert.Description>{t.noTargetText}</Alert.Description>
          </Alert.Content>
          <Button variant="outline" onPress={onSettings}>
            {t.chooseTarget}
          </Button>
        </Alert>
      )}
      {state.newerMajor !== undefined && (
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.newerMajorTitle(state.newerMajor)}</Alert.Title>
            <Alert.Description>{t.newerMajorText(state.newerMajor)}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {state.problems.blocked && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.blockedTitle}</Alert.Title>
            <Alert.Description>{!navigator.platform.startsWith('Mac') ? t.blockedOther : state.desktop ? t.blockedApp : t.blockedMac}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {state.problems.releases && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.releasesProblem}</Alert.Title>
            <Alert.Description>{message(state.problems.releases, t)}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {state.problems.download && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.downloadProblem}</Alert.Title>
            <Alert.Description>{message(state.problems.download, t)}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {noticed.map((d) => (
        <Alert key={d.key} status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{d.notice!.kind === 'mismatch' ? t.noticeMismatch(d.label) : t.noticeFailed(d.label)}</Alert.Title>
            <Alert.Description>{d.notice!.kind === 'mismatch' ? t.noticeMismatchText : t.noticeFailedText(sentence(message(d.notice!, t)))}</Alert.Description>
          </Alert.Content>
          <Button variant="outline" onPress={() => act('/api/devices/dismiss', d.key)}>
            {t.dismiss}
          </Button>
        </Alert>
      ))}

      {state.devices.length === 0 && (
        <div className="flex flex-col gap-2 rounded-2xl bg-surface p-6">
          <h2 className="m-0 text-lg font-semibold">{t.nothingFound}</h2>
          <p className="m-0 max-w-[70ch] text-sm leading-relaxed text-muted">{t.nothingFoundText}</p>
        </div>
      )}

      {online.length > 0 && (
        <section aria-labelledby="online" className="flex flex-col gap-3">
          <h2 id="online" className="m-0 text-xs font-semibold tracking-wider text-muted uppercase">
            {t.onNetwork(online.length)}
          </h2>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">{online.map(card)}</div>
        </section>
      )}
      {away.length > 0 && (
        <section aria-labelledby="away" className="flex flex-col gap-3">
          <h2 id="away" className="m-0 text-xs font-semibold tracking-wider text-muted uppercase">
            {t.offNetwork(away.length)}
          </h2>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">{away.map(card)}</div>
        </section>
      )}
    </div>
  );
}
