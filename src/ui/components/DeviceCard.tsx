import { Button, Card, Chip, Input, Modal, ProgressBar, TextField } from '@heroui/react';
import { useEffect, useState } from 'react';
import { MAX_NAME, type DeviceView } from '../../server/api.ts';
import { useBeat } from '../beat.ts';
import { ago, dateTime, useNow } from '../dates.ts';
import { message, resultText } from '../format.ts';
import { macText, shortProduct, title } from '../names.ts';
import { COLORS } from '../stateColors.ts';
import { usePrefs } from '../usePrefs.ts';
import { ArrowIcon, PencilIcon } from './icons.tsx';

// After the expected return, how long it may still take before the card asks you to check the receiver.
const LATE_MS = 100_000;

// A receiver after its upload: counts down to when it should be back on the network, then waits a little.
function BackBy({ from, until }: { from: string; until: string }) {
  const { t } = usePrefs();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const start = Date.parse(from);
  const end = Date.parse(until);
  if (now >= end + LATE_MS) return <span className="text-sm leading-relaxed">{t.notBack}</span>;
  const left = Math.max(0, Math.ceil((end - now) / 1000));
  const counting = left > 0;
  return (
    <ProgressBar
      aria-label={counting ? t.backIn : t.backLate}
      value={counting ? ((end - now) / (end - start)) * 100 : 0}
      isIndeterminate={!counting}
      className="mt-auto"
    >
      <span className="text-sm">{counting ? t.backIn : t.backLate}</span>
      {counting && (
        <span className="font-mono text-sm font-semibold text-accent tabular-nums">
          {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
        </span>
      )}
      <ProgressBar.Track>
        <ProgressBar.Fill />
      </ProgressBar.Track>
    </ProgressBar>
  );
}

// Asks before a custom build is flashed, with what it can cost.
function OwnBuildDialog({ name, target, onConfirm, onClose }: { name: string; target: string; onConfirm: () => void; onClose: () => void }) {
  const { t } = usePrefs();
  return (
    <Modal.Backdrop isOpen onOpenChange={(o) => !o && onClose()}>
      <Modal.Container>
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>{t.ownBuildTitle(target, name)}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="text-sm leading-relaxed">
            <p className="m-0">{t.ownBuildText(target)}</p>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="tertiary" onPress={onClose}>
              {t.cancel}
            </Button>
            <Button variant="primary" onPress={onConfirm}>
              {t.ownBuildConfirm(target)}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

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
  const [asking, setAsking] = useState(false);
  const now = useNow();
  const ring = useBeat<HTMLSpanElement>(d.state === 'flashing');
  const kind = d.type === 'tx' ? t.module : d.type === 'rx' ? t.receiver : t.unknownType;
  const newer = target && (d.state === 'update' || d.state === 'queued' || d.state === 'flashing' || d.state === 'unconfirmed');
  // the technical line: Lua name, address, MAC, regulatory domain in words (the raw value in its tooltip)
  const address = [d.device, d.ip, d.mac && macText(d.mac)].filter(Boolean).join(' · ');
  const domains = d.domain?.split(', ');
  return (
    <Card className={d.online ? 'group' : 'group opacity-70'}>
      {d.state === 'flashing' && <span ref={ring} className="flash-ring" aria-hidden="true" />}
      {d.state === 'unconfirmed' && (
        <svg className="wait-edge" aria-hidden="true">
          <rect />
        </svg>
      )}
      <Card.Content className="flex h-full flex-col gap-3.5">
        <div className="flex items-start justify-between gap-2.5">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="flex items-start gap-1">
              <span className="font-semibold">{title(d)}</span>
              {/* shown while the pointer is on the card or the keyboard reaches it; always on touch screens */}
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label={t.rename}
                className="-mt-1 shrink-0 text-muted opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                onPress={() => setEditing(d.name ?? '')}
              >
                <PencilIcon size={14} />
              </Button>
            </span>
          </div>
          <Chip size="sm" variant="soft" color={COLORS[d.state]} className="shrink-0">
            {t.states[d.state]}
          </Chip>
        </div>
        {/* below the state, so it uses the card's full width */}
        <span className="-mt-2.5 text-sm text-muted">{[kind, d.name && shortProduct(d.product)].filter(Boolean).join(' · ')}</span>

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
              <Input variant="secondary" placeholder={t.namePlaceholder} maxLength={MAX_NAME} autoFocus />
            </TextField>
            <Button size="sm" type="submit">
              {t.save}
            </Button>
            <Button size="sm" variant="tertiary" onPress={() => setEditing(undefined)}>
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

        <span className="text-xs text-muted">
          <span className="font-mono">{address}</span>
          {d.online && domains && (
            <span className="whitespace-nowrap" title={d.domain}>
              {' · '}
              {domains.map((x) => t.domains[x] ?? x).join(', ')}
            </span>
          )}
          {/* times in the normal font, like everywhere else */}
          {!d.online && (
            <span className="whitespace-nowrap tabular-nums" title={dateTime(d.lastSeen, t.locale)}>
              {' · '}
              {t.lastSeen(ago(d.lastSeen, t.locale, now))}
            </span>
          )}
        </span>

        {d.online && d.state === 'custom-build' && <span className="text-sm text-muted">{t.ownBuildNote}</span>}
        {d.online && d.state === 'newer' && <span className="text-sm text-muted">{t.newerText}</span>}
        {d.state === 'unconfirmed' && d.backBy && <BackBy from={d.backBy.from} until={d.backBy.until} />}
        {d.state === 'unconfirmed' && !d.backBy && d.unconfirmedTo && (
          <span className="text-sm leading-relaxed">{d.type === 'tx' ? t.unconfirmedTextTx(d.unconfirmedTo) : t.unconfirmedText(d.unconfirmedTo)}</span>
        )}
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
            <Button variant="outline" onPress={() => setAsking(true)}>
              {t.flashAnyway(target)}
            </Button>
          )}
          {asking && target && (
            <OwnBuildDialog
              name={title(d)}
              target={target}
              onClose={() => setAsking(false)}
              onConfirm={() => {
                setAsking(false);
                onUpdate();
              }}
            />
          )}
          {(d.state === 'mismatch' || d.state === 'failed') && (
            <Button variant="outline" onPress={onDismiss}>
              {t.dismiss}
            </Button>
          )}
          {!d.online && d.state !== 'flashing' && (
            <Button variant="danger-soft" className="self-start" onPress={onForget}>
              {t.remove}
            </Button>
          )}
        </div>
      </Card.Content>
    </Card>
  );
}
