import { Button, Link, Spinner, Switch, Tooltip } from '@heroui/react';
import { useRef, useState, type ReactNode } from 'react';
import type { StateView } from '../../server/api.ts';
import { dateTime } from '../dates.ts';
import { sidebarClass } from '../sidebarLayout.ts';
import { usePrefs } from '../usePrefs.ts';
import { useBeat } from '../beat.ts';
import { ActivityIcon, AppUpdateIcon, BoltIcon, DevicesIcon, PlugIcon, RefreshIcon, SettingsIcon, TargetIcon } from './icons.tsx';
import { NavGroup, NavItem, SidebarHeader, ThemeSwitch } from './SidebarParts.tsx';

const RELEASE_NOTES = 'https://github.com/ExpressLRS/ExpressLRS/releases/tag/';

export type Page = 'devices' | 'activity' | 'settings' | 'web-flasher';

// Pulses like the dot of the search, so it's clear that updates start without a click.
function ActiveBolt() {
  const ref = useBeat<HTMLSpanElement>();
  return (
    <span ref={ref} className="relative inline-flex size-4 text-amber-400">
      <BoltIcon size={16} className="absolute inset-0 fill-current opacity-75 motion-safe:animate-ping" />
      <BoltIcon size={16} className="relative fill-current" />
    </span>
  );
}

// Tooltip to the right of a control in the collapsed sidebar: its name and a second line.
const tip = (label: ReactNode, note?: ReactNode) => (
  <Tooltip.Content placement="right" offset={14}>
    <span className="flex max-w-60 flex-col">
      <span>{label}</span>
      {note && <span className="text-xs text-muted [overflow-wrap:anywhere]">{note}</span>}
    </span>
  </Tooltip.Content>
);

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
  const { t, theme, setTheme, sidebarCollapsed: collapsed, toggleSidebar } = usePrefs();
  const autoBox = useRef<HTMLDivElement>(null);
  const [autoTip, setAutoTip] = useState(false);
  const autoTipTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // after the same delay as the other tooltips; a click closes it, as it does theirs
  const showAutoTip = (on: boolean) => {
    clearTimeout(autoTipTimer.current);
    if (on) autoTipTimer.current = setTimeout(() => setAutoTip(true), 300);
    else setAutoTip(false);
  };
  const s = state?.settings;
  const target = s?.targetMajor !== undefined ? state?.target : undefined;
  const updates = state?.devices.filter((d) => d.online && (d.state === 'update' || d.state === 'queued' || d.state === 'flashing')).length ?? 0;
  const pages = [
    { page: 'devices' as const, label: t.devices, Icon: DevicesIcon },
    { page: 'activity' as const, label: t.activity, Icon: ActivityIcon },
    { page: 'web-flasher' as const, label: 'Web Flasher', Icon: PlugIcon },
  ];
  const appUpdateText = appUpdate
    ? appUpdate.restarting
      ? t.appRestarting
      : appUpdate.percent !== undefined
        ? t.appDownloading(appUpdate.percent)
        : t.appUpdateAvailable(appUpdate.version)
    : '';
  const checkText = state?.checking ? t.checking : state?.releasesChecked ? `${t.releasesChecked} ${dateTime(state.releasesChecked, t.locale)}` : t.notChecked;
  // the number of devices with an update: next to the label, collapsed beside the icon
  const updatesMark = (className: string) =>
    updates > 0 && (
      <>
        <span
          aria-hidden="true"
          className={
            className
              ? 'absolute -top-2 -right-3 grid h-4 min-w-4 place-items-center rounded-full bg-amber-400 px-1 text-[10.5px] font-bold text-zinc-900 ring-2 ring-zinc-900'
              : 'rounded-full bg-amber-400 px-1.5 text-[11px] font-semibold text-zinc-900'
          }
        >
          {updates}
        </span>
        <span className="sr-only">{t.updatesReady(updates)}</span>
      </>
    );

  return (
    <nav aria-label={t.nav} className={sidebarClass(collapsed)}>
      <SidebarHeader
        collapsed={collapsed}
        onToggle={toggleSidebar}
        name="ELRS Auto Flash"
        version={__APP_VERSION__}
        texts={{ collapse: t.collapseSidebar, expand: t.expandSidebar, ctrl: t.ctrlKey }}
      />

      {appUpdate &&
        (collapsed ? (
          <div className="flex justify-center">
            <Tooltip delay={300} closeDelay={0}>
              {appUpdate.installable ? (
                // the restart would cut off a running flash
                <Button variant="primary" isIconOnly aria-label={appUpdateText} isDisabled={updatingApp || flashing} onPress={onAppUpdate}>
                  {updatingApp ? <Spinner size="sm" color="current" /> : <AppUpdateIcon />}
                </Button>
              ) : (
                // a button, as the tooltip needs a trigger that handles presses
                <Button variant="ghost" isIconOnly aria-label={`${appUpdateText}: ${t.appUpdateDownload}`} className="text-accent" onPress={() => window.open(appUpdate.url, '_blank', 'noreferrer')}>
                  <AppUpdateIcon />
                </Button>
              )}
              {tip(appUpdateText, !updatingApp && (appUpdate.installable ? t.appUpdateClick : t.appUpdateLink))}
            </Tooltip>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-xl bg-zinc-800 p-3">
            <span className="text-xs text-zinc-300">{appUpdateText}</span>
            {appUpdate.installable ? (
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
        ))}

      {collapsed ? (
        // the bolt above the switch, or only the bolt while auto update is on for good. A switch can't trigger a
        // tooltip, so the box opens it on hover and focus; only Switch.Content takes the click.
        <div
          ref={autoBox}
          onPointerEnter={() => showAutoTip(true)}
          onPointerLeave={() => showAutoTip(false)}
          onPointerDown={() => showAutoTip(false)}
          onFocus={(e) => e.target.matches(':focus-visible') && setAutoTip(true)}
          onBlur={() => showAutoTip(false)}
        >
          {s?.alwaysAutoUpdate ? (
            <div className="flex justify-center rounded-xl py-2.5">
              <ActiveBolt />
              <span className="sr-only">{t.autoActive}</span>
            </div>
          ) : (
            <Switch
              size="md"
              aria-label={t.autoUpdate}
              isSelected={!!s?.autoUpdate}
              isDisabled={!s}
              onChange={onAutoUpdate}
              className="[--switch-control-bg:var(--color-zinc-600)]"
            >
              <Switch.Content className="flex w-full flex-col items-center gap-2 rounded-xl py-2.5 transition-colors hover:bg-zinc-800/60">
                {s?.autoUpdate ? <ActiveBolt /> : <BoltIcon size={16} className="text-zinc-400" />}
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          )}
          <Tooltip isOpen={autoTip} onOpenChange={setAutoTip}>
            <Tooltip.Content triggerRef={autoBox} placement="right" offset={14}>
              <span className="flex max-w-60 flex-col">
                <span>{s?.alwaysAutoUpdate ? t.autoActive : t.autoUpdate}</span>
                <span className="text-xs text-muted">{s?.autoUpdate ? t.autoOn : t.autoOff}</span>
              </span>
            </Tooltip.Content>
          </Tooltip>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5 rounded-xl bg-zinc-800 p-3.5">
          {s?.alwaysAutoUpdate ? (
            <span className="flex items-center gap-2">
              <ActiveBolt />
              <span className="text-sm font-semibold text-white">{t.autoActive}</span>
            </span>
          ) : (
            // the default track colour is nearly white here, which hides the white thumb
            <Switch
              size="lg"
              isSelected={!!s?.autoUpdate}
              isDisabled={!s}
              onChange={onAutoUpdate}
              className="[--switch-control-bg:var(--color-zinc-600)]"
            >
              <Switch.Content className="w-full justify-between">
                <span className="flex items-center gap-2">
                  {s?.autoUpdate && <ActiveBolt />}
                  <span className="text-sm font-semibold text-white">{t.autoUpdate}</span>
                </span>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          )}
          <span className="text-xs leading-relaxed text-zinc-300">{s?.autoUpdate ? t.autoOn : t.autoOff}</span>
        </div>
      )}

      {/* a click on the version opens its setting; "What's new" goes to the release notes */}
      {collapsed ? (
        <NavItem
          collapsed
          active={false}
          icon={<TargetIcon />}
          label={t.targetVersion}
          name={target ? `${t.targetVersion}: ${s!.targetMajor}.x → ${target}` : t.targetVersion}
          short={target ?? t.sidebarShort.target}
          note={target ? t.targetNote(s!.targetMajor!, s!.releaseCandidates) : t.targetNone}
          mark={(className) => !target && state && <span aria-hidden="true" className={`${className} size-2 rounded-full bg-amber-400`} />}
          onPress={() => onNavigate('settings')}
        />
      ) : (
        <div className="flex flex-col gap-1">
          <span className="px-2 text-[11px] font-medium tracking-wider text-zinc-400 uppercase">{t.targetVersion}</span>
          <button
            type="button"
            title={t.changeTarget}
            onClick={() => onNavigate('settings')}
            className="flex flex-col gap-1.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/60"
          >
            {target ? (
              <>
                <span className="font-mono text-xl text-white">
                  {s!.targetMajor}.x → {target}
                </span>
                <span className="text-xs text-zinc-400">{t.targetNote(s!.targetMajor!, s!.releaseCandidates)}</span>
              </>
            ) : (
              <span className="text-sm text-zinc-300">{t.targetNone}</span>
            )}
          </button>
          {target && (
            <Link href={RELEASE_NOTES + encodeURIComponent(target)} target="_blank" rel="noreferrer" className="self-start px-2 text-xs">
              {t.whatsNew}
              <Link.Icon />
            </Link>
          )}
        </div>
      )}

      <NavGroup collapsed={collapsed} label={t.overview}>
        {pages.map(({ page: target, label, Icon }) => (
          <NavItem
            key={target}
            collapsed={collapsed}
            active={page === target}
            icon={<Icon />}
            label={label}
            short={t.sidebarShort[target]}
            note={target === 'devices' && updates > 0 ? t.updatesReady(updates) : undefined}
            mark={target === 'devices' ? updatesMark : undefined}
            onPress={() => onNavigate(target)}
          />
        ))}
      </NavGroup>

      <div className="mt-auto flex flex-col gap-3">
        <NavItem collapsed={collapsed} active={page === 'settings'} icon={<SettingsIcon />} label={t.settings} short={t.sidebarShort.settings} onPress={() => onNavigate('settings')} />
        <ThemeSwitch
          collapsed={collapsed}
          theme={theme}
          onChange={setTheme}
          texts={{ theme: t.theme, light: t.light, dark: t.dark, system: t.systemTheme, switchTo: t.switchTheme }}
        />

        {collapsed ? (
          <div className="flex justify-center">
            <Tooltip delay={300} closeDelay={0}>
              <Button variant="outline" isIconOnly className="text-white" aria-label={t.checkUpdates} isDisabled={!state || state.checking} onPress={onCheck}>
                <RefreshIcon size={16} className={state?.checking ? 'animate-spin' : ''} />
              </Button>
              {tip(t.checkUpdates, checkText)}
            </Tooltip>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-xl bg-zinc-800 p-3">
            {/* always two lines high, so the box keeps its size while it switches to "Checking" and back */}
            <span className="line-clamp-2 h-8 text-xs text-zinc-400 [overflow-wrap:anywhere]">
              {state?.checking ? t.checking : state?.releasesChecked ? <>{t.releasesChecked}<br />{dateTime(state.releasesChecked, t.locale)}</> : t.notChecked}
            </span>
            <Button variant="outline" className="text-white" isDisabled={!state || state.checking} onPress={onCheck}>
              {state?.checking ? <Spinner size="sm" color="current" /> : <RefreshIcon size={16} />}
              {t.checkUpdates}
            </Button>
          </div>
        )}
      </div>
    </nav>
  );
}
