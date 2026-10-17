// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Scans the example host and the module pages so the built CSS holds only the classes they use.
const path = require('node:path')
module.exports = {
  content: [path.join(__dirname, 'main.jsx'), path.join(__dirname, '..', 'pages', '**', '*.{js,jsx}'), path.join(__dirname, '..', 'lib', '**', '*.{js,jsx}')],
  theme: { extend: {} },
  plugins: [],
}
