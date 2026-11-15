# Updates

Back to the [README](../README.md).

Moving from an earlier version? [migrating.md](migrating.md) lists every renamed setting and every changed default.

Third-party marketplaces do not auto-update by default. To turn it on once: `/plugin` > Marketplaces > `tertulia` > Enable auto-update. To update by hand: `claude plugin update tertulia-ai-discord-engine@tertulia`, then restart. The bot itself (`engine/`) updates with `git pull`, then `npm ci && npm run build` and a restart.

On each new session the plugin makes one request for its public version file (`plugin/.claude-plugin/plugin.json` on GitHub), at most once a day (once an hour while the request fails), and shows one line when a newer version is out. It sends nothing about you. To switch the check off, set `PLUGIN_UPDATE_CHECK=0`.
