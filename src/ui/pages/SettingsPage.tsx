import { Button, Card, ListBox, Select, Switch } from '@heroui/react';
import type { StateView } from '../../server/api.ts';
import { post } from '../api.ts';
import { AboutCard } from '../components/About.tsx';
import { FolderIcon } from '../components/icons.tsx';
import { usePrefs } from '../usePrefs.ts';

type Run = (fn: () => Promise<unknown>) => void;

// One of several switches in a card, with its own label and text.
function SwitchRow(props: { group: string; label: string; text: string; isSelected: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-start gap-3">
      <Switch aria-label={`${props.group}: ${props.label}`} isSelected={props.isSelected} onChange={props.onChange}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
      <div className="flex min-w-0 flex-col text-sm leading-relaxed">
        <span className="font-medium">{props.label}</span>
        <span className="text-muted">{props.text}</span>
      </div>
    </div>
  );
}

export function SettingsPage({ state, run, onAlwaysAutoUpdate }: { state: StateView; run: Run; onAlwaysAutoUpdate: (on: boolean) => void }) {
  const { t } = usePrefs();
  const s = state.settings;
  const save = (change: { targetMajor?: number | null; hideAutoUpdateWarning?: boolean; releaseCandidates?: boolean; rememberWebFlasher?: boolean }) =>
    run(() => post('/api/settings', change));
  return (
    <div className="flex flex-col gap-6">
      <h1 className="m-0 text-3xl font-bold tracking-tight">{t.settings}</h1>

      <Card>
        <Card.Header>
          <Card.Title>{t.targetMajor}</Card.Title>
          <Card.Description>{t.targetMajorText}</Card.Description>
        </Card.Header>
        <Card.Footer>
          {state.majors.length === 0 ? (
            <p className="m-0 text-sm">{t.noReleases}</p>
          ) : (
            <Select
              aria-label={t.targetMajor}
              className="w-80 max-w-full"
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
        </Card.Footer>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>{t.releaseCandidates}</Card.Title>
          <Card.Description>{t.rcText}</Card.Description>
        </Card.Header>
        {s.releaseCandidates && (
          <Card.Content>
            <p className="m-0 text-sm leading-relaxed text-warning">{t.rcWarning}</p>
          </Card.Content>
        )}
        <Card.Footer>
          <Switch aria-label={t.releaseCandidates} isSelected={s.releaseCandidates} onChange={(on) => save({ releaseCandidates: on })}>
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        </Card.Footer>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>{t.autoUpdate}</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          <SwitchRow group={t.autoUpdate} label={t.autoAlways} text={t.autoAlwaysText} isSelected={s.alwaysAutoUpdate} onChange={onAlwaysAutoUpdate} />
          <SwitchRow
            group={t.autoUpdate}
            label={t.autoWarning}
            text={t.autoWarningText}
            isSelected={!s.hideAutoUpdateWarning}
            onChange={(on) => save({ hideAutoUpdateWarning: !on })}
          />
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>{t.firmwareFolder}</Card.Title>
          <Card.Description>{t.firmwareFolderText}</Card.Description>
        </Card.Header>
        <Card.Footer>
          <Button variant="outline" onPress={() => run(() => post('/api/open-firmware-folder'))}>
            <FolderIcon size={16} />
            {t.openFolder}
          </Button>
        </Card.Footer>
      </Card>

      {/* only the desktop app can delete them; in a browser they belong to its storage */}
      {state.desktop && (
        <Card>
          <Card.Header>
            <Card.Title>{t.rememberWebFlasher}</Card.Title>
          </Card.Header>
          <Card.Content>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-sm leading-relaxed text-muted">
              <dt className="font-semibold text-foreground">{t.on}</dt>
              <dd className="m-0">{t.rememberWebFlasherOn}</dd>
              <dt className="font-semibold text-foreground">{t.off}</dt>
              <dd className="m-0">{t.rememberWebFlasherOff}</dd>
            </dl>
          </Card.Content>
          <Card.Footer>
            <Switch aria-label={t.rememberWebFlasher} isSelected={s.rememberWebFlasher} onChange={(on) => save({ rememberWebFlasher: on })}>
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </Card.Footer>
        </Card>
      )}

      <AboutCard />
    </div>
  );
}
