import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { app } from 'electron';
import { autoUpdater, type ProgressInfo } from 'electron-updater';
import { compareVersions, parseVersion } from '../core/version.ts';
import type { AppUpdateView } from '../server/api.ts';
import type { AppUpdates } from '../server/server.ts';

const RELEASES = 'https://github.com/Mariator-pro/elrs-auto-flash/releases';

// The installer puts its uninstaller next to the app; the portable zip has none, and updating it
// with the installer would install a second copy.
const installed = () => existsSync(join(dirname(process.execPath), `Uninstall ${basename(process.execPath)}`));

const isNewer = (tag: string, than: string) => {
  const a = parseVersion(tag.replace(/^v/, ''));
  const b = parseVersion(than);
  return !!a && !!b && compareVersions(a, b) > 0;
};

// The installed Windows app and the Linux AppImage download and install a new release when asked to.
// macOS would only accept an update signed with an Apple certificate, so there, as in the portable
// Windows app, the page links to the download.
export function appUpdates(): AppUpdates & { check: () => Promise<void> } {
  const installable = process.platform === 'linux' || (process.platform === 'win32' && installed());
  let found: AppUpdateView | undefined;
  let changed = () => {};
  // first use creates the updater, so only where it installs; on macOS it would set up Squirrel
  if (installable) autoUpdater.autoDownload = false;

  const newest = async (): Promise<string | undefined> => {
    if (installable) {
      const r = await autoUpdater.checkForUpdates();
      return r?.isUpdateAvailable ? r.updateInfo.version : undefined;
    }
    // github.com forwards /latest to the newest release's page; no API request, those are limited to 60 an hour
    const res = await fetch(`${RELEASES}/latest`, { method: 'HEAD' });
    const tag = res.url.split('/tag/')[1];
    return tag && isNewer(tag, app.getVersion()) ? tag.replace(/^v/, '') : undefined;
  };

  return {
    view: () => found,
    onChange: (fn) => {
      changed = fn;
    },
    check: async () => {
      const version = await newest();
      if (!version) return;
      found = { version, url: `${RELEASES}/tag/v${version}`, installable };
      changed();
    },
    install: async () => {
      const progress = (p: ProgressInfo) => {
        found = { ...found!, percent: Math.floor(p.percent) };
        changed();
      };
      autoUpdater.on('download-progress', progress);
      try {
        found = { ...found!, percent: 0 };
        changed();
        await autoUpdater.downloadUpdate();
      } catch (e) {
        found = { ...found!, percent: undefined };
        changed();
        throw e;
      } finally {
        autoUpdater.off('download-progress', progress);
      }
      found = { ...found!, percent: undefined, restarting: true };
      changed();
      // a moment for the answer and the state to reach the page; silent install, then start the new version
      setTimeout(() => autoUpdater.quitAndInstall(true, true), 1000);
    },
  };
}
