import { Button, ListBox, Select, Spinner, Switch, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import type { StateView } from '../../server/api.ts';
import { dateTime } from '../format.ts';
import { LANGUAGES, type Lang } from '../texts.ts';
import { usePrefs, type Theme } from '../usePrefs.ts';
import { ActivityIcon, AntennaIcon, DevicesIcon, MoonIcon, PlugIcon, RefreshIcon, SettingsIcon, SunIcon } from './icons.tsx';

export type Page = 'devices' | 'activity' | 'settings' | 'web-flasher';

export function Sidebar(props: {
  state?: StateView;
  page: Page;
  onNavigate: (page: Page) => void;
  onAutoUpdate: (on: boolean) => void;
  onCheck: () => void;
  onAppUpdate: () => void;
}) {
  const { state, page, onNavigate, onAutoUpdate, onCheck, onAppUpdate } = props;
  const appUpdate = state?.appUpdate;
  const updatingApp = appUpdate?.percent !== undefined || !!appUpdate?.restarting;
  const flashing = !!state?.devices.some((d) => d.state === 'flashing');
  const { t, lang, setLang, theme, setTheme } = usePrefs();
  const s = state?.settings;
  const updates = state?.devices.filter((d) => d.online && (d.state === 'update' || d.state === 'queued' || d.state === 'flashing')).length ?? 0;
  const pages = [
    { page: 'devices' as const, label: t.devices, Icon: DevicesIcon },
    { page: 'activity' as const, label: t.activity, Icon: ActivityIcon },
    { page: 'settings' as const, label: t.settings, Icon: SettingsIcon },
    { page: 'web-flasher' as const, label: 'Web Flasher', Icon: PlugIcon },
  ];
  // Always dark: the "dark" class gives its HeroUI controls dark colours in the light theme too.
  // The language list opens outside the sidebar, so it carries the class and its text colour itself.
  // On wide screens it stays in place while long pages scroll, so its bottom row stays visible.
  const item = 'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left no-underline transition-colors';
  return (
    <nav
      aria-label={t.nav}
      className="dark flex flex-[1_1_240px] flex-col gap-6 bg-zinc-900 px-3.5 py-5 text-zinc-200 md:sticky md:top-0 md:h-screen md:flex-[0_0_240px] md:self-start md:overflow-y-auto"
    >
      <div className="flex items-center gap-2.5 px-2">
        <span className="flex size-[30px] items-center justify-center rounded-lg bg-accent text-white">
          <AntennaIcon size={16} />
        </span>
        <span className="flex flex-col">
          <span className="font-semibold whitespace-nowrap text-white">ELRS Auto Flash</span>
          <span className="text-xs text-zinc-400">v{__APP_VERSION__}</span>
        </span>
      </div>

      {appUpdate && (
        <div className="flex flex-col gap-2 rounded-xl bg-zinc-800 p-3">
          <span className="text-xs text-zinc-300">
            {appUpdate.restarting
              ? t.appRestarting
              : appUpdate.percent !== undefined
                ? t.appDownloading(appUpdate.percent)
                : t.appUpdateAvailable(appUpdate.version)}
          </span>
          {appUpdate.installable ? (
            // the restart would cut off a running flash
            <Button variant="primary" isDisabled={updatingApp || flashing} onPress={onAppUpdate}>
              {updatingApp && <Spinner size="sm" color="current" />}
              {t.appUpdateInstall}
            </Button>
          ) : (
            <a href={appUpdate.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-accent no-underline hover:underline">
              {t.appUpdateDownload}
            </a>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2.5 rounded-xl bg-zinc-800 p-3.5">
        {/* the default track colour is nearly white here, which hides the white thumb */}
        <Switch
          size="lg"
          isSelected={!!s?.autoUpdate}
          isDisabled={!s}
          onChange={onAutoUpdate}
          className="[--switch-control-bg:var(--color-zinc-600)]"
        >
          <Switch.Content className="w-full justify-between">
            <span className="font-semibold text-white">{t.autoUpdate}</span>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
        <span className="text-xs leading-relaxed text-zinc-300">{s?.autoUpdate ? t.autoOn : t.autoOff}</span>
      </div>

      <div className="flex flex-col gap-1.5 px-2">
        <span className="text-[11px] font-medium tracking-wider text-zinc-400 uppercase">{t.targetVersion}</span>
        {s?.targetMajor !== undefined && state?.target ? (
          <>
            <span className="font-mono text-xl text-white">
              {s.targetMajor}.x → {state.target}
            </span>
            <span className="text-xs text-zinc-400">{t.targetNote(s.targetMajor, s.releaseCandidates)}</span>
          </>
        ) : (
          <span className="text-sm text-zinc-300">{t.targetNone}</span>
        )}
      </div>

      <div className="flex flex-col gap-0.5">
        <span className="px-2 pb-1.5 text-[11px] font-medium tracking-wider text-zinc-400 uppercase">{t.overview}</span>
        {pages.map(({ page: target, label, Icon }) => (
          <button
            key={target}
            type="button"
            onClick={() => onNavigate(target)}
            aria-current={page === target ? 'page' : undefined}
            className={`${item} ${page === target ? 'bg-zinc-800 text-white' : 'hover:bg-zinc-800/60'}`}
          >
            <Icon />
            <span className="flex-1">{label}</span>
            {target === 'devices' && updates > 0 && (
              <>
                <span className="rounded-full bg-amber-400 px-1.5 text-[11px] font-semibold text-zinc-900" aria-hidden="true">
                  {updates}
                </span>
                <span className="sr-only">{t.updatesReady(updates)}</span>
              </>
            )}
          </button>
        ))}
      </div>

      <div className="mt-auto flex flex-col gap-3">
        <div className="flex items-center gap-2 px-1">
          <ToggleButtonGroup
            aria-label={t.theme}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={new Set([theme])}
            onSelectionChange={(keys) => {
              const v = [...keys][0];
              if (v) setTheme(String(v) as Theme);
            }}
          >
            <ToggleButton id="light" isIconOnly aria-label={t.light}>
              <SunIcon size={16} />
            </ToggleButton>
            <ToggleButton id="dark" isIconOnly aria-label={t.dark}>
              <MoonIcon size={16} />
            </ToggleButton>
          </ToggleButtonGroup>
          <Select
            aria-label={t.language}
            className="min-w-0 flex-1"
            selectedKey={lang}
            onSelectionChange={(k) => k !== null && setLang(String(k) as Lang)}
          >
            <Select.Trigger className="rounded-3xl border-0 bg-default shadow-none hover:bg-default-hover data-[hovered=true]:bg-default-hover">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover className="dark text-foreground">
              <ListBox>
                {LANGUAGES.map((l) => (
                  <ListBox.Item key={l.id} id={l.id} textValue={l.name}>
                    {l.name}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>

        <div className="flex flex-col gap-2 rounded-xl bg-zinc-800 p-3">
          <span className="text-xs text-zinc-400">
            {state?.checking ? t.checking : state?.releasesChecked ? t.releasesChecked(dateTime(state.releasesChecked, t.locale)) : t.notChecked}
          </span>
          <Button variant="outline" className="text-white" isDisabled={!state || state.checking} onPress={onCheck}>
            {state?.checking ? <Spinner size="sm" color="current" /> : <RefreshIcon size={16} />}
            {t.checkUpdates}
          </Button>
        </div>
      </div>
    </nav>
  );
}
