import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createJobsClient, LaxJobsError, retryAfterMs, codeForStatus } from '../src/index.js';

const BASE = 'https://lax.test/registry';
const JOB = { id: 'j1', title: 'T', track: 'seat', bounty_usdc: 1, status: 'open' };
const SUB = { builder: 'Astra', contact: 'ops@example.com', repo_or_patch_url: 'https://github.com/astra-tc/x', payout_address: '0x1A7Dc2677391D49FB3001AD5a1aa89A573c9b865', agent_did: 'did:web:example.com' };

type R = Response | Error;
function harness(...answers: R[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const sleeps: number[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const a = answers.length > 1 ? answers.shift()! : answers[0];
    if (a instanceof Error) throw a;
    return a.clone();
  };
  const client = createJobsClient({ baseUrl: BASE, fetch, sleep: async (ms) => { sleeps.push(ms); } });
  return { client, calls, sleeps };
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });

async function rejects(p: Promise<unknown>, status: number, code: string, msg?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof LaxJobsError, 'LaxJobsError');
    assert.ok(e instanceof Error);
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    if (msg) assert.match(e.message, msg);
    return true;
  });
}

test('A1 listJobs, getJob and submit send the requests and return the parsed answers', async () => {
  let h = harness(json({ jobs: [JOB], count: 1 }));
  assert.deepEqual(await h.client.listJobs(), { jobs: [JOB], count: 1 });
  assert.equal(h.calls[0].url, `${BASE}/jobs`);
  assert.equal(h.calls[0].init?.method, 'GET');

  h = harness(json({ jobs: [], count: 0 }));
  await h.client.listJobs({ track: 'seat', limit: 5, offset: 10 });
  assert.equal(h.calls[0].url, `${BASE}/jobs?track=seat&limit=5&offset=10`);
  h = harness(json({ jobs: [] }));
  assert.deepEqual(await h.client.listJobs({ limit: 100 }), { jobs: [], count: 0 });
  assert.equal(h.calls[0].url, `${BASE}/jobs?limit=100`);

  h = harness(json({ job: JOB }));
  assert.deepEqual(await h.client.getJob('a b/c'), JOB);
  assert.equal(h.calls[0].url, `${BASE}/jobs/a%20b%2Fc`);

  const answer = { id: 's1', job_id: 'j1', status: 'received', created_at: '2026-10-28T00:00:00Z' };
  h = harness(json({ submission: answer }, 201));
  assert.deepEqual(await h.client.submit('j1', { ...SUB, notes: 'n' }), answer);
  const c = h.calls[0];
  assert.equal(c.url, `${BASE}/jobs/j1/submissions`);
  assert.equal(c.init?.method, 'POST');
  assert.equal((c.init?.headers as Record<string, string>)['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(c.init?.body)), { ...SUB, notes: 'n' });

  // defaults: public registry, trailing slash trimmed
  const calls: string[] = [];
  const d = createJobsClient({ fetch: async (u) => { calls.push(u); return json({ job: JOB }); } });
  await d.getJob('x');
  assert.equal(calls[0], 'https://lax.kognai.ai/registry/jobs/x');
  const t = createJobsClient({ baseUrl: BASE + '/', fetch: async (u) => { calls.push(u); return json({ job: JOB }); } });
  await t.getJob('y');
  assert.equal(calls[1], `${BASE}/jobs/y`);
});

test('A1 a 2xx answer that is not JSON or lacks its object throws invalid_response', async () => {
  await rejects(harness(new Response('<html>', { status: 200 })).client.getJob('x'), 200, 'invalid_response');
  await rejects(harness(json({ nope: 1 })).client.getJob('x'), 200, 'invalid_response');
  await rejects(harness(json({ nope: 1 })).client.listJobs(), 200, 'invalid_response');
  await rejects(harness(json({ nope: 1 }, 201)).client.submit('j', SUB), 201, 'invalid_response');
});

test('A2 400, 404 and 409 throw LaxJobsError with status, code and message after a single request', async () => {
  for (const [status, code] of [[400, 'bad_request'], [404, 'not_found'], [409, 'conflict']] as const) {
    for (const op of ['list', 'get', 'submit'] as const) {
      const h = harness(json({ error: `registry says ${status}` }, status));
      const p = op === 'list' ? h.client.listJobs() : op === 'get' ? h.client.getJob('x') : h.client.submit('x', SUB);
      await rejects(p, status, code, new RegExp(`registry says ${status}`));
      assert.equal(h.calls.length, 1, `${op} ${status} sent once`);
      assert.equal(h.sleeps.length, 0);
    }
  }
  await rejects(harness(new Response('plain words', { status: 422 })).client.getJob('x'), 422, 'bad_request', /plain words/);
  await rejects(harness(new Response('', { status: 400 })).client.getJob('x'), 400, 'bad_request', /HTTP 400/);
  await rejects(harness(json({ error: { field: 'builder' } }, 400)).client.getJob('x'), 400, 'bad_request', /builder/);
});

test('A3 a 429 is retried after its Retry-After then succeeds; a 429 that never ends throws rate_limited', async () => {
  let h = harness(json({ error: 'slow down' }, 429, { 'retry-after': '3' }), json({ job: JOB }));
  assert.deepEqual(await h.client.getJob('x'), JOB);
  assert.deepEqual(h.sleeps, [3000]);
  assert.equal(h.calls.length, 2);

  h = harness(json({ error: 'slow' }, 429, { 'retry-after': '120' }), json({ submission: { id: 's', job_id: 'x', status: 'ok', created_at: 't' } }, 201));
  await h.client.submit('x', SUB);
  assert.deepEqual(h.sleeps, [30000], 'Retry-After capped at 30 s; submit is retried on 429');

  h = harness(json({ error: 'slow' }, 429));
  await rejects(h.client.listJobs(), 429, 'rate_limited', /slow/);
  assert.equal(h.calls.length, 3, 'first try plus 2 retries');
  assert.deepEqual(h.sleeps, [500, 1000], 'no Retry-After: 500 ms doubled');

  assert.equal(retryAfterMs(null), undefined);
  assert.equal(retryAfterMs(''), undefined);
  assert.equal(retryAfterMs('soon'), undefined);
  assert.equal(retryAfterMs('1.5'), 1500);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 5_000), 5000);
  assert.equal(retryAfterMs(new Date(0).toUTCString(), 5_000), 0);
});

test('A4 5xx or a network error on a read is retried then throws server or network; submit is not retried on them', async () => {
  let h = harness(json({ error: 'down' }, 503), json({ jobs: [JOB], count: 1 }));
  assert.equal((await h.client.listJobs()).count, 1);
  assert.equal(h.calls.length, 2);

  h = harness(json({ error: 'down' }, 502));
  await rejects(h.client.getJob('x'), 502, 'server', /down/);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.sleeps, [500, 1000]);

  h = harness(new TypeError('fetch failed'));
  await rejects(h.client.getJob('x'), 0, 'network', /fetch failed/);
  assert.equal(h.calls.length, 3);

  h = harness(new TypeError('fetch failed'), json({ job: JOB }));
  assert.deepEqual(await h.client.getJob('x'), JOB);

  h = harness(json({ error: 'down' }, 500));
  await rejects(h.client.submit('x', SUB), 500, 'server');
  assert.equal(h.calls.length, 1);
  h = harness(new TypeError('socket hang up'));
  await rejects(h.client.submit('x', SUB), 0, 'network');
  assert.equal(h.calls.length, 1);

  // retries option and the timeout abort
  const calls: number[] = [];
  const c0 = createJobsClient({ baseUrl: BASE, retries: 0, fetch: async () => { calls.push(1); return json({ error: 'x' }, 500); } });
  await rejects(c0.getJob('x'), 500, 'server');
  assert.equal(calls.length, 1);
  const slow = createJobsClient({
    baseUrl: BASE, retries: 0, timeoutMs: 20,
    fetch: (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted by timeout')))),
  });
  await rejects(slow.getJob('x'), 0, 'network', /aborted/);
  assert.equal(codeForStatus(418), 'bad_request');
});

test('A5 submit refuses bad input before any request with invalid_input', async () => {
  const bad: [string, Record<string, unknown>][] = [
    ['j', { ...SUB, agent_did: undefined }],
    ['j', { ...SUB, agent_did: 'astra' }],
    ['j', { ...SUB, payout_address: '0x123' }],
    ['j', { ...SUB, payout_address: '1A7Dc2677391D49FB3001AD5a1aa89A573c9b865' }],
    ['j', { ...SUB, payout_address: '0x1A7Dc2677391D49FB3001AD5a1aa89A573c9b86Z' }],
    ['j', { ...SUB, repo_or_patch_url: 'http://github.com/x' }],
    ['j', { ...SUB, repo_or_patch_url: 'github.com/x' }],
    ['j', { ...SUB, builder: '' }],
    ['j', { ...SUB, contact: '' }],
    ['', SUB],
  ];
  for (const [id, input] of bad) {
    const h = harness(json({}));
    await rejects(h.client.submit(id, input as never), 0, 'invalid_input');
    assert.equal(h.calls.length, 0, JSON.stringify(input));
  }
  const h = harness(json({}));
  await rejects(h.client.submit('j', null as never), 0, 'invalid_input');
  await rejects(h.client.getJob(''), 0, 'invalid_input');
  await rejects(h.client.listJobs({ limit: 0 }), 0, 'invalid_input');
  await rejects(h.client.listJobs({ limit: 101 }), 0, 'invalid_input');
  await rejects(h.client.listJobs({ offset: -1 }), 0, 'invalid_input');
  assert.equal(h.calls.length, 0);
});

test('A6 no new runtime dependency and no console output from the client', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {});
  const src = readFileSync(new URL('../src/jobs.ts', import.meta.url), 'utf8');
  assert.ok(!/console\.|process\.std/.test(src));
  assert.ok(!/^import /m.test(src), 'jobs.ts imports nothing');
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  let printed = 0;
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) (console as any)[k] = () => { printed++; };
  try {
    await harness(json({ jobs: [], count: 0 })).client.listJobs();
    await harness(json({ error: 'x' }, 404)).client.getJob('x').catch(() => {});
    await harness(new Error('net')).client.submit('x', SUB).catch(() => {});
  } finally {
    Object.assign(console, orig);
  }
  assert.equal(printed, 0);
});

test('A7 live GET /jobs integration (only with LAX_LIVE=1)', { skip: process.env.LAX_LIVE !== '1' && 'set LAX_LIVE=1 to read the live registry' }, async () => {
  const client = createJobsClient();
  const list = await client.listJobs({ limit: 5 });
  assert.ok(Array.isArray(list.jobs));
  assert.equal(typeof list.count, 'number');
  if (list.jobs[0]) {
    const job = await client.getJob(list.jobs[0].id);
    assert.equal(job.id, list.jobs[0].id);
  }
});
