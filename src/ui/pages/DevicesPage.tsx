import { Alert, Button, ListBox, SearchField, Select } from '@heroui/react';
import { useState } from 'react';
import type { DeviceView, StateView, WatchState } from '../../server/api.ts';
import { post } from '../api.ts';
import { DeviceCard } from '../components/DeviceCard.tsx';
import { SearchIcon } from '../components/icons.tsx';
import { SearchBackground } from '../components/SearchBackground.tsx';
import { time } from '../dates.ts';
import { message, sentence } from '../format.ts';
import { deviceNames, macText } from '../names.ts';
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
type Filter = 'all' | 'update' | 'current';
const UPDATING: WatchState[] = ['update', 'queued', 'flashing'];
const sorted = (list: DeviceView[]) =>
  [...list].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (a.product ?? a.ip).localeCompare(b.product ?? b.ip));

export function DevicesPage({ state, run, onSettings }: { state: StateView; run: Run; onSettings: () => void }) {
  const { t, search } = usePrefs();
  // no search while macOS blocks the local network, so nothing moves then
  const searching = !state.problems.blocked && search !== 'off';
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const q = query.trim().toLowerCase();
  const found = state.devices.filter((d) => !q || [d.name, d.label, d.product, d.device, d.target, d.ip, d.mac, d.mac && macText(d.mac)].some((v) => v?.toLowerCase().includes(q)));
  const fits = (d: DeviceView, f: Filter) => f === 'all' || (f === 'update' ? UPDATING.includes(d.state) : d.state === 'current');
  const shown = found.filter((d) => fits(d, filter));
  // choices without a device for the current search stay in the list, greyed out
  const empty = (['update', 'current'] as const).filter((f) => f !== filter && !found.some((d) => fits(d, f)));
  const online = sorted(shown.filter((d) => d.online));
  const away = sorted(shown.filter((d) => !d.online));
  const awayUpdates = away.filter((d) => d.state === 'update').length;
  const noticed = state.devices.filter((d) => d.notice);
  const names = deviceNames(state.devices);
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
    <div className="flex flex-col gap-6" data-search={searching ? '' : undefined}>
      {searching && <SearchBackground look={search} />}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="m-0 text-3xl font-bold tracking-tight">{t.devices}</h1>
        <span className="inline-flex items-center gap-2 text-sm text-muted">
          {/* a ring runs out of the dot while the search goes on, which it always does; none with reduced motion */}
          <span className="relative flex size-2" aria-hidden="true" data-search-origin>
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
            <Alert.Title>{d.notice!.kind === 'mismatch' ? t.noticeMismatch(names.get(d.key)!) : t.noticeFailed(names.get(d.key)!)}</Alert.Title>
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

      {state.devices.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <SearchField aria-label={t.searchDevices} variant="secondary" className="min-w-48 flex-1 sm:max-w-80" value={query} onChange={setQuery}>
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder={t.searchDevices} />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          <Select
            variant="secondary"
            aria-label={t.filterLabel}
            className="w-52"
            selectedKey={filter}
            disabledKeys={empty}
            onSelectionChange={(k) => k !== null && setFilter(k as Filter)}
          >
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover className="field-list">
              <ListBox>
                {(['all', 'update', 'current'] as const).map((f) => {
                  const label = f === 'all' ? t.filterAll : t.states[f];
                  return (
                    <ListBox.Item key={f} id={f} textValue={label}>
                      {label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  );
                })}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
      )}
      {state.devices.length > 0 && shown.length === 0 && (
        <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-surface-secondary text-muted">
            <SearchIcon size={22} />
          </span>
          <h2 className="m-0 text-base font-semibold">{t.noMatch}</h2>
          <Button
            variant="outline"
            size="sm"
            onPress={() => {
              setQuery('');
              setFilter('all');
            }}
          >
            {t.resetFilter}
          </Button>
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
            {awayUpdates > 0 && <span className="text-warning"> · {t.needUpdate(awayUpdates)}</span>}
          </h2>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">{away.map(card)}</div>
        </section>
      )}
    </div>
  );
}
