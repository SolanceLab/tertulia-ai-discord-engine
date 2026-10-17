# `make test` runs every test in this room, whatever the language.
.PHONY: example-host test test-engine test-mcp test-parity test-dashboard test-agent
test: test-engine test-mcp test-parity test-dashboard test-agent

test-engine:
	cd engine && npm ci && npx tsc --noEmit && npm test

test-mcp:
	cd mcp/worker && npm ci && npm run typecheck && npm test

test-parity:
	node --test 'mcp/tests/*.test.mjs'

test-dashboard:
	npm install --legacy-peer-deps
	npx vitest run --config dashboard/vitest.config.js

test-agent:
	node --test 'agent/tests/*.test.mjs'

# Opens the settings page on this computer: make example-host BOT_URL=http://127.0.0.1:3000
export BOT_URL ?= http://127.0.0.1:3000
example-host:
	npm install --legacy-peer-deps
	node dashboard/example-host/build.mjs
	node dashboard/example-host/serve.mjs
