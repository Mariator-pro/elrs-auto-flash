# Command line

[Back to the README](../README.md)

The command line finds, updates and watches devices from the terminal, e.g. for scripts or when you prefer it to the app. It needs [Node.js](https://nodejs.org) 22.18 or newer, the source and `npm install` (see [Development](development.md#running-from-source)).

```sh
npm run cli -- <command> [options]
```

On macOS the program you run the commands in needs permission for the local network: System Settings, Privacy & Security, Local Network, for example Terminal, iTerm or Visual Studio Code (its built-in terminal counts as Visual Studio Code). Quit and reopen that program after allowing it. Without the permission every address answers "no route to host", and `list` says so instead of "No ELRS devices found".

## Find devices

```sh
npm run cli -- settings --target-major 4
npm run cli -- list
```

`settings --target-major` sets the major version all devices are kept on (`none` clears it). Choose the one your transmitters run: transmitters and receivers need the same major version. `settings` alone shows the settings; `--release-candidates on` also counts release candidates, `--auto-update on|off` decides whether `watch` flashes devices by itself (see below).

`releases` asks GitHub for the ExpressLRS releases and shows the newest of each major version. `list` does that by itself when the last check is older than 6 hours, and keeps using the last list when GitHub cannot be reached.

`list` listens for 10 seconds (change it with `--time <seconds>`) and shows every ELRS device on the network with its product, firmware version, state (up to date, update available, newer than the target version, custom build, not supported below 3.0), target, regulatory domain and address. It finds devices in two ways: their mDNS announcement, and by asking every address in the computer's networks (only the 254 addresses around its own in larger networks), so devices also show up where mDNS is blocked.

A device is only on the network while its WiFi is on. Power it without its transmitter and wait about a minute (the "WiFi on interval", 60 seconds by default), or turn on WiFi in the ELRS Lua script on the radio. To join your home network instead of opening its own "ExpressLRS RX" network, the home network must be set up once in the device's web page.

`list` remembers every device it finds. Devices found before that are not on the network right now are listed below the others with the time they were last seen.

## Update a device

```sh
npm run cli -- update 192.168.1.50 --dry-run
npm run cli -- update 192.168.1.50
```

`update` flashes one device to the target version. Name it by its IP address, its MAC (as `list` shows it), its Lua name or its product name (in quotes); anything but an IP address is looked up on the network first (`--time <seconds>`, default 10). The firmware archive of the target version (about 30 MB, from the server the ExpressLRS Configurator uses) is downloaded once and kept; archives of versions that are no longer needed are removed.

Before anything is sent, `update` shows what it is going to do: the device, its version and the new one, which firmware file (FCC or LBT), the product and Lua name, where the hardware layout comes from, and the names of the options it carries over unchanged (binding, WiFi, regulatory domain and so on; their values are never shown). It also checks that the file is for the device's target. Start with `--dry-run`: it stops after this and sends nothing. Without it, `update` asks before flashing (`--yes` skips the question). While the app, the [browser interface](browser-interface.md) or `watch` runs, or another `update`, `update` does not start (a dry run does), since that may be flashing the same device.

After the upload the device restarts. For a receiver, `update` waits up to 3 minutes for it to come back and checks its version. Keep the transmitter off meanwhile: the receiver's WiFi only comes back while it has no link. A transmitter module restarts with its WiFi off, so it is not waited for: turn its WiFi on again in the radio's ExpressLRS menu, and the update is confirmed once it shows up. A device that refuses the file because it is not for its target is never forced.

## Keep devices up to date

```sh
npm run cli -- settings --auto-update on
npm run cli -- watch
```

`watch` keeps looking for devices until you stop it with Ctrl+C: it listens for mDNS all the time and scans the network every minute. With auto update on, every device with an update is flashed as soon as it shows up, one at a time in the order they got their update; with auto update off (the default), `watch` only shows what it finds. The switch can be changed with `settings` in a second terminal while `watch` runs. Pressing Ctrl+C while a device is being flashed waits for it to finish; press it again to quit right away. `watch` does not start while the [browser interface](browser-interface.md), another `watch` or an `update` runs.

Custom builds, devices newer than the target version and devices without a target version are never flashed by `watch`. If an upload fails, `watch` tries again after a minute, at most 3 times per version. After the third failure, or when the firmware does not match the device's target, it leaves that device alone and shows a notice. Check the device, then let it be flashed again with:

```sh
npm run cli -- dismiss A1B2C3D4E5F6
```

`watch` and the interface do not wait for a device to come back: once the device has taken the upload, the next one is flashed. A device flashed this way, one that did not come back within 3 minutes after `update` (usually because its transmitter was switched on), and a transmitter module until its WiFi is turned on again, count as done once they show up again with the new version. Within the first 30 seconds after the upload, a sighting with the old version is ignored, since it may still stem from before the restart.

## Known devices

`forget` removes a device from the list of known devices (for example one you no longer own); it is added again when it is found. `rename <device> "5 inch freestyle"` gives a device its own name (`""` removes it), which `list`, `watch` and the interface show next to its Lua name and the other commands accept. These take the device the same way as `update`, but only look in the list of known devices, not on the network.

The command line uses the same [data folder](../README.md#your-data-on-the-computer) as the app: settings, known devices and firmware archives are shared.
