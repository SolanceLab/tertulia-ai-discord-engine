// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/away-status.test.ts */
import './test-env.js';
import { fetchAwayStatus } from './away-status.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

type MockFetchFn = (url: string, init?: any) => Promise<{ ok: boolean; status?: number; json: () => Promise<any> }>;
let mockFetch: MockFetchFn = async () => ({ ok: true, json: async () => ({}) });
(globalThis as any).fetch = (url: string, init?: any) => mockFetch(url, init);

async function run() {
  // ok → parsed
  mockFetch = async () => ({
    ok: true,
    json: async () => ({ away: true, source: 'manual', status: 'busy', reason: 'therapy', announce: true }),
  });
  let result = await fetchAwayStatus('http://api', 'tok');
  ok(
    'ok response → parsed AwayStatus',
    result !== null &&
      result.away === true &&
      result.source === 'manual' &&
      result.status === 'busy' &&
      result.reason === 'therapy' &&
      result.announce === true,
  );

  // non-ok → null
  mockFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  result = await fetchAwayStatus('http://api', 'tok');
  ok('non-ok status → null', result === null);

  // throw → null, never throws
  mockFetch = async () => { throw new Error('network down'); };
  let threw = false;
  try {
    result = await fetchAwayStatus('http://api', 'tok');
  } catch {
    threw = true;
  }
  ok('fetch throw → null, does not throw', !threw && result === null);

  // timeout-style rejection (what the real 8s AbortController timeout produces
  // when it fires) → null, never throws — same catch path as any other error.
  mockFetch = async () => {
    const err: any = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  };
  threw = false;
  try {
    result = await fetchAwayStatus('http://api', 'tok');
  } catch {
    threw = true;
  }
  ok('AbortError (timeout) → null, does not throw', !threw && result === null);

  // missing/malformed fields on an ok response still degrade to safe defaults, never throw
  mockFetch = async () => ({ ok: true, json: async () => ({ away: 'yes' }) });
  result = await fetchAwayStatus('http://api', 'tok');
  ok(
    'malformed ok payload → safe defaults, away coerced to boolean',
    result !== null && result.away === true && result.source === '' && result.status === '' && result.reason === '',
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
run();
