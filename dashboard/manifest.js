// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { setHost } from './host.js'

// No sidebar section: the Discord link stays in the Communication group and the
// settings drawer (the registry has no way to put a module item inside another
// module's section or the drawer), so `nav` is empty. The pages and their
// URLs come from here.
export default {
  id: 'discord',
  label: 'Discord',
  note: 'presence',
  description: 'How the bot shows up in Discord, and the context logs behind it.',
  nav: { items: [] },
  routes: [
    { path: 'settings/discord', load: () => import('./pages/DiscordSettings.jsx') },
    { path: 'settings/logs', load: () => import('./pages/ContextLogs.jsx') },
  ],
  defaultEnabled: true,
  // The host calls this once with { adapter, labels, theme } before rendering a page.
  setup(host) {
    return setHost(host)
  },
}
