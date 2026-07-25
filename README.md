# IMDb Shows Tracker

A local-first Manifest V3 TV episode tracker for Chrome and Edge. It imports IMDb TV lists and TV Time history, resolves metadata through TVMaze, and keeps viewing progress in browser storage.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm run build:edge
```

Load `.output/chrome-mv3` as an unpacked extension from `chrome://extensions` with Developer mode enabled. The toolbar icon opens the dashboard. The extension adds isolated controls to IMDb desktop pages.

All user progress stays in `chrome.storage.local`; replaceable TVMaze metadata is stored in IndexedDB. The project has no backend or telemetry.

TV data is provided by [TVMaze](https://www.tvmaze.com/api) under CC BY-SA. This unofficial extension is not affiliated with IMDb, TV Time, or TVMaze.
