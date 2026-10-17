<!-- Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab) -->
# Example host

A small page that opens the settings and context log pages on your own computer, so you can use the bot's settings without a dashboard of your own. It is also the smallest working example of a host (see `../HOST.md`).

```
make example-host BOT_URL=http://127.0.0.1:3000
```

Then open http://127.0.0.1:8787/ and log in with the bot's `DASHBOARD_PASSWORD`.

How it connects: `serve.mjs` serves the page and forwards only `/settings` requests to `BOT_URL`, so the browser talks to one address and the bot needs no CORS change. It listens on this computer only. The password is typed on the login page and is not stored in the build; the bot's own login cookie is the session.

Files: `main.jsx` (login and tabs, uses `manifest.setup()` and `adapters/bot-settings-api.js`), `build.mjs` (bundles with esbuild), `serve.mjs` (static files and the `/settings` forward).
