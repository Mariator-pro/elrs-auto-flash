# Development

[Back to the README](../README.md)

## Running from source

Needs [Node.js](https://nodejs.org) 22.18 or newer.

```sh
git clone https://github.com/Mariator-pro/elrs-auto-flash.git
cd elrs-auto-flash
npm install
npm run build
```

This is also what the [browser interface](browser-interface.md) and the [command line](command-line.md) need.

## Commands

- `npm run dev`: the interface with live reload (Vite, with the server in the same process)
- `npm test`: tests (Vitest)
- `npm run typecheck`: type check
- `npm run lint`: Oxlint
- `npm run desktop`: build and start the desktop app from the source
- `npm run dist`: build the desktop app for this computer into `release/`

## Making a release

A pushed version tag (for example `git tag v<version> && git push origin v<version>`, after raising the version in `package.json`) builds the app for macOS, Windows and Linux on GitHub Actions (`.github/workflows/release.yml`) and attaches it to the release.
