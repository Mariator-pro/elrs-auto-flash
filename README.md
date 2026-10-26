# ELRS Auto Flash

Keep your ExpressLRS receivers and transmitter modules up to date without flashing them one by one. Devices that join your home WiFi are found automatically and updated to the current firmware over the network, keeping their binding phrase, regulatory domain and WiFi settings.

A desktop app (plus a browser interface and a command line tool) lists every device it finds with its firmware version. With auto update turned on there is nothing to click: as soon as a newer version is out, each device is updated the next time it shows up on the network. With auto update turned off (the default), every device with an update available gets its own update button. All devices stay on the major version you choose in the settings (for example 3.x), so receivers and transmitters keep their link. Until you have chosen it once, devices are only listed, not flashed. Only final releases are installed, unless you turn on release candidates in the settings. A device is never flashed back to an older version, a custom build (one that reports a branch name instead of a version) only by its own button, and firmware that a device reports as not matching its hardware is never forced onto it.

Work in progress: the desktop app, the browser interface and the command line tool find devices, tell which ones have an update, flash a device on request and, with auto update on, keep watching the network and update devices as they show up. Flashing builds the same file as the ExpressLRS tools and has been tested on a RadioMaster RP4TD (ESP32 receiver), a RadioMaster RP1 (ESP8285 receiver) and a transmitter module. There is no release yet; the desktop app can be built from the source (see Development).

## Desktop app

From the first release on, download the app from the [Releases](https://github.com/Mariator-pro/elrs-auto-flash/releases) page:

- **macOS**: `elrs-auto-flash-macos-arm64-v<version>.zip` for Apple Silicon (M1 and newer) or `elrs-auto-flash-macos-x64-v<version>.zip` for Intel Macs. Unzip it, open the `.dmg` inside and drag the app into Applications.
- **Windows**: `elrs-auto-flash-win64-v<version>.zip`. Unzip it and run the installer inside.
- **Windows, portable**: `elrs-auto-flash-win64-portable-v<version>.zip`, no installation. Unzip it into a folder of its own (the files are at the top of the zip) and start `ELRS Auto Flash.exe`. Settings and known devices go to the same folder as with the installed app.
- **Linux** (x64): `elrs-auto-flash-linux-v<version>.zip`. Unzip it and start the `.AppImage` inside, for example with a double click or `./elrs-auto-flash-linux-v<version>.AppImage`. If it does not start, the system may lack FUSE 2: on Ubuntu 24.04 and newer install it with `sudo apt install libfuse2t64`, on older Ubuntu and Debian with `sudo apt install libfuse2`.

The app is not signed with an Apple or Microsoft certificate, so the system warns on first start:

- **macOS**: the first start shows "Apple could not verify ... is free of malware". Click "Done" (not "Move to Trash"), open System Settings, Privacy & Security, scroll down and click "Open Anyway" next to the blocked app, confirm with your password or Touch ID, then start the app again and choose "Open". Later starts need nothing.
- **Windows**: if a SmartScreen window appears, click "More info" and then "Run anyway".
- **Linux**: no warning. If the file manager does not start the AppImage, mark it as executable (`chmod +x`).

The app needs the local network to find devices:

- **macOS** asks on first start whether ELRS Auto Flash may find devices on the local network. Allow it; if you said no, turn it on in System Settings, Privacy & Security, Local Network, and start the app again.
- **Windows** may ask whether ELRS Auto Flash may use the network (Windows Defender Firewall). Allow it for private networks.

The window shows the same interface as the browser (below). Closing it quits the app; while a device is being flashed it asks first (a device cut off keeps its old firmware and gets the update next time). Auto update only runs while the app is open.

In the app, the Web Flasher page flashes over a cable without Chrome or Edge: when the Web Flasher connects, the app asks which port the device is on. Files the Web Flasher saves (firmware file, Lua script) go to the Downloads folder, which then opens with the file selected. Links to guides open in your browser. Flashing STM32 devices with an ST-Link does not work in the app (use the browser interface in Chrome or Edge for that). The Web Flasher keeps the binding phrase and WiFi details you type in; the app deletes them when it quits, unless you turn on "Remember Web Flasher entries" in the settings (then they stay on the computer unencrypted, as in a browser).

### Updating the app

On start the app looks for a newer release and shows it at the top left:

- **Windows (installed) and Linux**: "Update and restart" downloads the new version, installs it in place and starts it again. Your data and settings stay.
- **Windows (portable)**: "Download" opens the release page; unzip the new version and delete the old folder.
- **macOS**: "Download" opens the release page. Install the new version like the first one; the app replaces the old one in Applications. macOS accepts an in-place update only for apps signed with an Apple certificate, which this one is not.

## Browser interface

Requires [Node.js](https://nodejs.org) 22.18 or newer.

```sh
npm install
npm run build
npm start
```

`npm start` opens the interface in the browser. It keeps looking for devices and lists each one as a card with its version, the target version and its state. The sidebar holds the auto update switch and the target version; choose the target version once under Settings. With auto update off, each device with an update gets its own update button; a custom build gets a button too, with a note on what flashing it can reset. Devices of the same kind share one name (the one the ELRS Lua script shows, e.g. RM RP4TD 2400), so each card has a pencil button to give the device its own name as well; without one, the last 4 digits of its MAC tell them apart. Devices whose firmware did not match their target, or that failed 3 times, show a notice with an Allow again button (with auto update on they are flashed again right away); a single attempt that stopped or failed shows on the card until the next one. Activity lists what happened since the start, grouped by minute; a flash takes one line with the old and new version, and devices that did the same at once (all found at the start, or after a new target version) share one line that opens up. Stop it with Ctrl+C in the terminal; a running flash is finished first.

The Web Flasher page shows the [ExpressLRS Web Flasher](https://expresslrs.github.io/web-flasher/) inside the interface, for everything this app leaves out on purpose: any version including older ones, with your own binding phrase and WiFi details, flashed over a cable or saved as a file to upload over WiFi (for example a new receiver that does not know your home network yet). Its safety rules do not apply there. It needs internet; flashing over a cable works in Chrome and Edge only (Safari and Firefox lack Web Serial). Once a device knows your home network, it shows up under Devices and is kept up to date over WiFi.

Starting it a second time opens the running interface instead of starting another one, and `watch` (below) refuses to start while it runs, so two processes never flash the same device. The desktop app does not start while the browser interface runs (it asks you to quit that first), and `npm start` while the app runs opens the app's interface in the browser.

## Find devices

The same from the command line:

```sh
npm run cli -- settings --target-major 4
npm run cli -- list
```

`settings --target-major` sets the major version all devices are kept on (`none` clears it). Choose the one your transmitters run: transmitters and receivers need the same major version. `settings` alone shows the settings; `--release-candidates on` also counts release candidates, `--auto-update on|off` decides whether `watch` flashes devices by itself (see below).

`releases` asks GitHub for the ExpressLRS releases and shows the newest of each major version. `list` does that by itself when the last check is older than 6 hours, and keeps using the last list when GitHub cannot be reached.

`list` listens for 10 seconds (change it with `--time <seconds>`) and shows every ELRS device on the network with its product, firmware version, state (up to date, update available, newer than the target version, custom build, not supported below 3.0), target, regulatory domain and address. It finds devices in two ways: their mDNS announcement, and by asking every address in the computer's networks (only the 254 addresses around its own in larger networks), so devices also show up where mDNS is blocked.

A device is only on the network while its WiFi is on. Power it without its transmitter and wait about a minute (the "WiFi on interval", 60 seconds by default), or turn on WiFi in the ELRS Lua script on the radio. To join your home network instead of opening its own "ExpressLRS RX" network, the home network must be set up once in the device's web page.

`list` remembers every device it finds. Devices found before that are not on the network right now are listed below the others with the time they were last seen.

On macOS the app you run the command in needs permission for the local network: System Settings, Privacy & Security, Local Network, for example Terminal, iTerm or Visual Studio Code (its built-in terminal counts as Visual Studio Code). Quit and reopen the app after allowing it. Without the permission every address answers "no route to host", and `list` says so instead of "No ELRS devices found".

## Update a device

```sh
npm run cli -- update 192.168.1.50 --dry-run
npm run cli -- update 192.168.1.50
```

`update` flashes one device to the target version. Name it by its IP address, its MAC (as `list` shows it), its Lua name or its product name (in quotes); anything but an IP address is looked up on the network first (`--time <seconds>`, default 10). The firmware archive of the target version (about 30 MB, from the server the ExpressLRS Configurator uses) is downloaded once and kept; archives of versions that are no longer needed are removed.

Before anything is sent, `update` shows what it is going to do: the device, its version and the new one, which firmware file (FCC or LBT), the product and Lua name, where the hardware layout comes from, and the names of the options it carries over unchanged (binding, WiFi, regulatory domain and so on; their values are never shown). It also checks that the file is for the device's target. Start with `--dry-run`: it stops after this and sends nothing. Without it, `update` asks before flashing (`--yes` skips the question).

After the upload the device restarts. For a receiver, `update` waits up to 3 minutes for it to come back and checks its version. Keep the transmitter off meanwhile: the receiver's WiFi only comes back while it has no link. A transmitter module restarts with its WiFi off, so it is not waited for: turn its WiFi on again in the radio's ExpressLRS menu, and the update is confirmed once it shows up. A device that refuses the file because it is not for its target is never forced.

## Keep devices up to date

```sh
npm run cli -- settings --auto-update on
npm run cli -- watch
```

`watch` keeps looking for devices until you stop it with Ctrl+C: it listens for mDNS all the time and scans the network every minute. With auto update on, every device with an update is flashed as soon as it shows up, one at a time in the order they got their update; with auto update off (the default), `watch` only shows what it finds. The switch can be changed with `settings` in a second terminal while `watch` runs. Pressing Ctrl+C while a device is being flashed waits for it to finish; press it again to quit right away.

Custom builds, devices newer than the target version and devices without a target version are never flashed by `watch`. If an upload fails, `watch` tries again after a minute, at most 3 times per version. After the third failure, or when the firmware does not match the device's target, it leaves that device alone and shows a notice. Check the device, then let it be flashed again with:

```sh
npm run cli -- dismiss A1B2C3D4E5F6
```

`forget` removes a device from the list of known devices (for example one you no longer own); it is added again when it is found. `rename <device> "5 inch freestyle"` gives a device its own name (`""` removes it), which `list`, `watch` and the interface show next to its Lua name and the other commands accept. These take the device the same way as `update`, but only look in the list of known devices, not on the network.

`watch` and the interface do not wait for a device to come back: once the device has taken the upload, the next one is flashed. A device flashed this way, one that did not come back within 3 minutes after `update` (usually because its transmitter was switched on), and a transmitter module until its WiFi is turned on again, count as done once they show up again with the new version. Within the first 30 seconds after the upload, a sighting with the old version is ignored, since it may still stem from before the restart.

Settings, the last list of releases, the known devices and the firmware archives are kept in `~/Library/Application Support/ELRS Auto Flash/` on macOS, `%LOCALAPPDATA%\ELRS Auto Flash\` on Windows and `~/.local/share/elrs-auto-flash/` on Linux.

## Development

- `npm run dev`: the interface with live reload (Vite, with the server in the same process)
- `npm test`: tests (Vitest)
- `npm run typecheck`: type check
- `npm run lint`: Oxlint
- `npm run desktop`: build and start the desktop app from the source
- `npm run dist`: build the desktop app for this computer into `release/`

A pushed version tag (for example `git tag v0.1.0 && git push origin v0.1.0`, after raising the version in `package.json`) builds the app for macOS, Windows and Linux on GitHub Actions and attaches it to the release.

## License

MIT, see [LICENSE](LICENSE).
