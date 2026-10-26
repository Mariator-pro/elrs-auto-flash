import { Button, Card, ListBox, Select, Switch } from '@heroui/react';
import type { StateView } from '../../server/api.ts';
import { post } from '../api.ts';
import { FolderIcon } from '../components/icons.tsx';
import { usePrefs } from '../usePrefs.ts';

type Run = (fn: () => Promise<unknown>) => void;

export function SettingsPage({ state, run }: { state: StateView; run: Run }) {
  const { t } = usePrefs();
  const s = state.settings;
  const save = (change: { targetMajor?: number | null; releaseCandidates?: boolean; rememberWebFlasher?: boolean }) => run(() => post('/api/settings', change));
  return (
    <div className="flex flex-col gap-6">
      <h1 className="m-0 text-3xl font-bold tracking-tight">{t.settings}</h1>

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
        <Card>
          <Card.Content className="flex flex-col gap-3">
            <h2 className="m-0 text-base font-semibold">{t.targetMajor}</h2>
            <p className="m-0 text-sm leading-relaxed text-muted">{t.targetMajorText}</p>
            {state.majors.length === 0 ? (
              <p className="m-0 text-sm">{t.noReleases}</p>
            ) : (
              <Select
                aria-label={t.targetMajor}
                selectedKey={s.targetMajor === undefined ? 'none' : String(s.targetMajor)}
                onSelectionChange={(k) => k !== null && save({ targetMajor: k === 'none' ? null : Number(k) })}
              >
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="none" textValue={t.none}>
                      {t.none}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    {state.majors.map((m) => (
                      <ListBox.Item key={m.major} id={String(m.major)} textValue={t.majorOption(m.major, m.tag)}>
                        {t.majorOption(m.major, m.tag)}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            )}
          </Card.Content>
        </Card>

        <Card>
          <Card.Content className="flex flex-col gap-3">
            <Switch isSelected={s.releaseCandidates} onChange={(on) => save({ releaseCandidates: on })}>
              <Switch.Content className="w-full justify-between">
                <span className="text-base font-semibold">{t.releaseCandidates}</span>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
            <p className="m-0 text-sm leading-relaxed text-muted">{t.rcText}</p>
            {s.releaseCandidates && <p className="m-0 text-sm leading-relaxed text-warning">{t.rcWarning}</p>}
          </Card.Content>
        </Card>

        <Card>
          <Card.Content className="flex flex-col gap-3">
            <h2 className="m-0 text-base font-semibold">{t.firmwareFolder}</h2>
            <p className="m-0 text-sm leading-relaxed text-muted">{t.firmwareFolderText}</p>
            <Button variant="outline" className="mt-auto self-start" onPress={() => run(() => post('/api/open-firmware-folder'))}>
              <FolderIcon size={16} />
              {t.openFolder}
            </Button>
          </Card.Content>
        </Card>

        {/* only the desktop app can delete them; in a browser they belong to its storage */}
        {state.desktop && (
          <Card>
            <Card.Content className="flex flex-col gap-3">
              <Switch isSelected={s.rememberWebFlasher} onChange={(on) => save({ rememberWebFlasher: on })}>
                <Switch.Content className="w-full justify-between">
                  <span className="text-base font-semibold">{t.rememberWebFlasher}</span>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-sm leading-relaxed text-muted">
                <dt className="font-semibold text-foreground">{t.on}</dt>
                <dd className="m-0">{t.rememberWebFlasherOn}</dd>
                <dt className="font-semibold text-foreground">{t.off}</dt>
                <dd className="m-0">{t.rememberWebFlasherOff}</dd>
              </dl>
            </Card.Content>
          </Card>
        )}
      </div>
    </div>
  );
}
