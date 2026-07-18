# Solar System Browser

Local static browser app for a 3D spacecraft-aware solar scene built with Three.js.

## Run

Start a local server from the repo root:

```bash
python3 -m http.server 5177 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:5177/solar-system-browser/index.html
```

## Features

- Three.js scene rendering with starfield, planets, spacecraft, orbits, labels, and trails.
- Focus target buttons for all major planets and listed spacecraft.
- Timeline scrubber, simulation speed control, zoom slider, play/pause, and camera reset.
- Scene controls for orbit lines, trails, labels, and spacecraft visibility.
- `prefers-reduced-motion` support: no continuous animation while preserving a static, nonblank scene.

## Verification

Standalone app verification:

```bash
node --check solar-system-browser/solar-system.js
node --check solar-system-browser/scripts/verify.mjs
node --check solar-system-browser/scripts/capture-browser-evidence.mjs
npm run build
node dist/cli.js browser verify --issue-file solar-system-browser/issues/3d-spacecraft-upgrade.json --repo . --report reports/solar-3d-browser-evidence.json
node solar-system-browser/scripts/verify.mjs
```

When this issue runs through `brain-hands implement`, the issue
`browser_checks` are captured automatically before local verification and PR
creation. The explicit `browser verify` command above is for standalone
refresh/debug workflows.

The verify script writes:

- `reports/solar-3d-browser-report.json`

The generic `brain-hands browser verify` command launches the local server
declared by `browser_checks`, drives local Chrome through DevTools Protocol,
and writes:

- `reports/solar-3d-browser-evidence.json`
- `reports/solar-3d-desktop.png`
- `reports/solar-3d-mobile.png`

It captures required metadata for browser checks from
`solar-system-browser/issues/3d-spacecraft-upgrade.json`.

The app-specific `solar-system-browser/scripts/capture-browser-evidence.mjs`
remains available for the richer spacecraft-focus capture and writes
`reports/solar-3d-spacecraft-focus.png`.
