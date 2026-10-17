// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WATCH = fileURLToPath(new URL('../watch.mjs', import.meta.url));
const QUESTION = 'what is the plan for tomorrow';
const SECRET = 'test-secret-value-123';

async function fakeBot() {
  const calls = [];
  let queued = true;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/aside/study/pending') {
        res.end(JSON.stringify({ pending: queued ? [{ id: 'a1', channel_name: 'general', question: QUESTION, transcript: '', history: [], created_at: new Date().toISOString() }] : [] }));
      } else if (req.url === '/api/aside/study/claim') { queued = false; res.end('{"claimed":"a1"}'); }
      else res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, calls, url: `http://127.0.0.1:${server.address().port}` };
}

async function runWatcher(command, until) {
  const bot = await fakeBot();
  const child = spawn(process.execPath, [WATCH], {
    env: { ...process.env, BOT_URL: bot.url, BOT_API_SECRET: SECRET, AGENT_COMMAND: command, POLL_SECONDS: '1', AGENT_TIMEOUT_SECONDS: '10' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const start = Date.now();
  while (!bot.calls.some(until) && Date.now() - start < 8000) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 1200)); // a further poll would show a second claim
  child.kill();
  bot.server.close();
  return { calls: bot.calls, output };
}

test('claims once, runs the command and posts the answer', async () => {
  const { calls, output } = await runWatcher('cat', (c) => c.url === '/api/aside/study/answer');
  assert.equal(calls.filter((c) => c.url === '/api/aside/study/claim').length, 1);
  const answer = calls.find((c) => c.url === '/api/aside/study/answer');
  assert.ok(answer, 'answer posted');
  assert.equal(answer.body.id, 'a1');
  assert.ok(answer.body.note.includes(QUESTION), 'the command received the question on stdin');
  assert.ok(calls.every((c) => c.auth === `Bearer ${SECRET}`));
  assert.ok(!calls.some((c) => c.url === '/api/aside/study/release'));
  assert.ok(output.includes('answered id=a1'));
});

test('releases the question when the command fails', async () => {
  const { calls } = await runWatcher('exit 3', (c) => c.url === '/api/aside/study/release');
  assert.ok(calls.find((c) => c.url === '/api/aside/study/release' && c.body.id === 'a1'));
  assert.ok(!calls.some((c) => c.url === '/api/aside/study/answer'));
});

test('never logs the secret or the question', async () => {
  const ok = await runWatcher('cat', (c) => c.url === '/api/aside/study/answer');
  const bad = await runWatcher('exit 3', (c) => c.url === '/api/aside/study/release');
  for (const { output } of [ok, bad]) {
    assert.ok(output.length > 0);
    assert.ok(!output.includes(SECRET));
    assert.ok(!output.includes(QUESTION));
  }
});
