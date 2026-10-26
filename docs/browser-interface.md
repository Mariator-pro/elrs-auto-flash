# Browser interface

[Back to the README](../README.md)

Besides the desktop app, ELRS Auto Flash can run in your web browser, with the same pages as the app. It needs [Node.js](https://nodejs.org) 22.18 or newer and the source (see [Development](development.md#running-from-source)):

```sh
npm install
npm run build
npm start
```

`npm start` opens the interface in the browser. The pages work as described in the [README](../README.md#using-it). Stop it with Ctrl+C in the terminal; a running flash is finished first.

Starting it a second time opens the running interface instead of starting another one, and [`watch`](command-line.md#keep-devices-up-to-date) refuses to start while it runs, so two processes never flash the same device. The desktop app does not start while the browser interface runs (it asks you to quit that first), and `npm start` while the app runs opens the app's interface in the browser.

## Web Flasher in the browser

The Web Flasher page works as in the app, with these differences:

- Flashing over a cable works in Chrome and Edge only (Safari and Firefox lack Web Serial). Downloading a file and flashing over WiFi work in every browser.
- Flashing STM32 devices with an ST-Link works here, in Chrome or Edge, but not in the desktop app.
- The binding phrase and WiFi details you type in are kept by the browser like on any other website; the setting "Remember Web Flasher entries" exists only in the desktop app.

## macOS: local network

On macOS the program you start `npm start` from needs permission for the local network: System Settings, Privacy & Security, Local Network, for example Terminal, iTerm or Visual Studio Code (its built-in terminal counts as Visual Studio Code). Quit and reopen that program after allowing it. Without the permission the Devices page shows "No access to the local network".
