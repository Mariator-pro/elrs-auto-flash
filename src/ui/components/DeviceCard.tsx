import { Button, Card, Chip, Input, ProgressBar, TextField } from '@heroui/react';
import { useState } from 'react';
import { MAX_NAME, type DeviceView, type WatchState } from '../../server/api.ts';
import { message, resultText, when } from '../format.ts';
import { usePrefs } from '../usePrefs.ts';
import { ArrowIcon, PencilIcon } from './icons.tsx';

export type Color = 'default' | 'accent' | 'success' | 'warning' | 'danger';

export const COLORS: Record<WatchState, Color> = {
  current: 'success',
  update: 'warning',
  newer: 'default',
  'custom-build': 'default',
  'no-target-version': 'default',
  unsupported: 'default',
  unconfirmed: 'accent',
  mismatch: 'danger',
  failed: 'danger',
  queued: 'default',
  flashing: 'accent',
};

// One device: what it is, its version against the target, its state and what can be done about it.
export function DeviceCard(props: {
  d: DeviceView;
  target?: string;
  autoUpdate: boolean;
  onUpdate: () => void;
  onDismiss: () => void;
  onForget: () => void;
  onRename: (name: string) => void;
}) {
  const { d, target, autoUpdate, onUpdate, onDismiss, onForget, onRename } = props;
  const { t } = usePrefs();
  const [editing, setEditing] = useState<string>();
  const kind = d.type === 'tx' ? t.module : d.type === 'rx' ? t.receiver : t.unknownType;
  const newer = target && (d.state === 'update' || d.state === 'queued' || d.state === 'flashing' || d.state === 'unconfirmed');
  const address = [d.ip, d.mac].filter(Boolean).join(' · ');
  return (
    <Card className={d.online ? undefined : 'opacity-70'}>
      <Card.Content className="flex h-full flex-col gap-3.5">
        <div className="flex items-start justify-between gap-2.5">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="flex items-start gap-1">
              <span className="font-semibold">{d.name ?? d.product ?? d.ip}</span>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label={t.rename}
                className="-mt-1 shrink-0 text-muted"
                onPress={() => setEditing(d.name ?? '')}
              >
                <PencilIcon size={14} />
              </Button>
            </span>
            {d.name && d.product && <span className="text-sm">{d.product}</span>}
            <span className="text-sm text-muted">{[kind, d.device].filter(Boolean).join(' · ')}</span>
          </div>
          {d.online && (
            <Chip size="sm" variant="soft" color={COLORS[d.state]} className="shrink-0">
              {t.states[d.state]}
            </Chip>
          )}
        </div>

        {editing !== undefined && (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onRename(editing);
              setEditing(undefined);
            }}
          >
            <TextField
              aria-label={t.rename}
              className="min-w-40 flex-1"
              value={editing}
              onChange={setEditing}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(undefined);
              }}
            >
              <Input placeholder={t.namePlaceholder} maxLength={MAX_NAME} autoFocus />
            </TextField>
            <Button size="sm" type="submit">
              {t.save}
            </Button>
            <Button size="sm" variant="ghost" onPress={() => setEditing(undefined)}>
              {t.cancel}
            </Button>
          </form>
        )}

        <div className="flex flex-wrap items-center gap-2 font-mono text-sm">
          <span className="rounded-md bg-surface-secondary px-2 py-0.5 text-muted">{d.version ?? '?'}</span>
          {newer && (
            <>
              <ArrowIcon size={16} className="text-warning" />
              <span className="rounded-md bg-warning-soft px-2 py-0.5 text-warning-soft-foreground">{d.unconfirmedTo ?? target}</span>
            </>
          )}
        </div>

        <span className="font-mono text-xs text-muted">
          {d.online ? [address, d.domain].filter(Boolean).join(' · ') : `${address} · ${t.lastSeen(when(d.lastSeen, t.locale))}`}
        </span>

        {d.online && d.state === 'custom-build' && target && <span className="text-sm leading-relaxed">{t.ownBuildText(target)}</span>}
        {d.online && d.state === 'newer' && <span className="text-sm text-muted">{t.newerText}</span>}
        {d.state === 'unconfirmed' && d.unconfirmedTo && <span className="text-sm leading-relaxed">{d.type === 'tx' ? t.unconfirmedTextTx(d.unconfirmedTo) : t.unconfirmedText(d.unconfirmedTo)}</span>}
        {d.online && d.state === 'unsupported' && <span className="text-sm text-muted">{d.unsupportedReason ? message(d.unsupportedReason, t) : t.unsupportedText}</span>}
        {d.online && d.state === 'queued' && <span className="text-sm text-muted">{t.queuedText}</span>}
        {d.lastAttempt && (d.state === 'update' || d.state === 'custom-build') && (
          <span className="flex flex-col text-sm leading-relaxed text-danger">
            <span className="font-semibold">{t.lastAttempt}</span>
            <span>{resultText(d.lastAttempt.outcome, d.lastAttempt.to, t)}</span>
            {d.online && d.state === 'update' && autoUpdate && <span className="text-muted">{t.retryAuto}</span>}
          </span>
        )}
        {(d.state === 'mismatch' || d.state === 'failed') && d.notice && <span className="text-sm leading-relaxed text-danger">{message(d.notice, t)}</span>}

        {d.state === 'flashing' && (
          <ProgressBar
            aria-label={t.steps[d.step?.step ?? 'prepare']}
            value={d.step?.percent ?? 0}
            isIndeterminate={d.step?.percent === undefined}
            className="mt-auto"
          >
            <span className="text-sm">{t.steps[d.step?.step ?? 'prepare']}</span>
            {d.step?.percent !== undefined && <ProgressBar.Output />}
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
        )}

        <div className="mt-auto flex flex-col">
          {d.online && d.state === 'update' && !autoUpdate && target && (
            <Button variant="primary" onPress={onUpdate}>
              {t.updateTo(target)}
            </Button>
          )}
          {d.online && d.state === 'custom-build' && target && (
            <Button variant="outline" onPress={onUpdate}>
              {t.flashAnyway(target)}
            </Button>
          )}
          {(d.state === 'mismatch' || d.state === 'failed') && (
            <Button variant="outline" onPress={onDismiss}>
              {t.dismiss}
            </Button>
          )}
          {!d.online && d.state !== 'flashing' && (
            <Button variant="ghost" className="self-start" onPress={onForget}>
              {t.remove}
            </Button>
          )}
        </div>
      </Card.Content>
    </Card>
  );
}
