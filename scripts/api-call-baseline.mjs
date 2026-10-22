// Counts real GoogleDrive adapter requests against an in-memory HTTP stub.
// No user profile, credentials or network is used.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const legacy = !!process.env.WB_BENCH_CORE_DIR;
const coreDir = path.resolve(process.env.WB_BENCH_CORE_DIR || 'dist-desktop/core');
const moduleAt = (name) => import(pathToFileURL(path.join(coreDir, name + '.js')).href);
const { GoogleDrive } = await moduleAt('drive');
const { DemoDrive, DEMO_ACCOUNTS } = await moduleAt('demo');
const { TaskEngine } = await moduleAt('engine');
const { MemoryStore } = await moduleAt('store');
const { DEFAULT_SHARE } = await moduleAt('types');
import { mkdir, writeFile } from 'node:fs/promises';
const savedFetch = globalThis.fetch;
const results = [];
function setup(delayed = false) {
  const repo = new MemoryStore(),
    model = new DemoDrive(),
    calls = [],
    delayedIds = new Set(),
    rejectedIds = new Set();
  model.wait = async () => {};
  const extra = structuredClone(model.files.find((f) => f.id === 'wireframes'));
  extra.id = 'benchmark-extra';
  extra.name = 'Benchmark extra';
  extra.parents = ['design-b'];
  model.files.push(extra);
  for (const account of DEMO_ACCOUNTS) {
    repo.saveAccount(account);
    repo.saveConnection({
      id: account.id,
      accountId: account.id,
      clientId: 'benchmark',
      clientSecret: 'benchmark',
      expiresAt: 0,
    });
  }
  const auth = {
    acquire: async (account) => ({ connection: { accessToken: account }, release() {} }),
    cooldown() {},
    invalidate() {},
  };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname !== 'www.googleapis.com') throw Error('Unexpected URL in isolated benchmark');
    const parts = url.pathname.replace('/drive/v3/', '').split('/').map(decodeURIComponent);
    const account = options.headers.Authorization.slice('Bearer '.length),
      method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    const category =
      parts.length === 1
        ? 'list'
        : parts[2] === 'permissions'
          ? `${method}-permissions`
          : `${method}-file`;
    calls.push({ category, method });
    let result;
    if (method === 'GET' && parts.length === 1) {
      const q = url.searchParams.get('q') || '';
      const parent = q.match(/'([^']+)' in parents/)?.[1];
      const files = model.files.filter(
        (f) => !f.trashed && (!parent || f.parents.includes(parent)),
      );
      result = { files: await Promise.all(files.map((f) => model.get(account, f.id))) };
    } else if (parts[2] === 'permissions') {
      const id = parts[1];
      if (method === 'GET') {
        const ps = await model.permissions(account, id);
        if (delayed && account === 'demo-work' && !delayedIds.has(id)) {
          delayedIds.add(id);
          result = { permissions: [] };
        } else result = { permissions: ps };
      } else if (method === 'POST') result = await model.createPermission(account, id, body);
      else if (
        method === 'PATCH' &&
        body.role === 'owner' &&
        delayed === 'acceptance-lag' &&
        !rejectedIds.has(id)
      ) {
        rejectedIds.add(id);
        return Response.json(
          { error: { errors: [{ reason: 'insufficientFilePermissions' }] } },
          { status: 403 },
        );
      } else if (method === 'PATCH')
        result = await model.updatePermission(
          account,
          id,
          parts[3],
          body,
          url.searchParams.get('transferOwnership') === 'true',
        );
      else if (method === 'DELETE') {
        await model.deletePermission(account, id, parts[3]);
        return new Response(null, { status: 204 });
      } else throw Error('Unsupported permissions request');
    } else if (method === 'GET') {
      result = await model.get(account, parts[1]);
      if (account === 'demo-work' && parts[1] === 'root') result.id = 'target-root';
    } else if (method === 'PATCH')
      result = await model.update(account, parts[1], body, Object.fromEntries(url.searchParams));
    else throw Error('Unsupported file request');
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { repo, drive: new GoogleDrive(auth), calls };
}
const count = (calls) => ({
  total: calls.length,
  reads: calls.filter((c) => c.method === 'GET').length,
  writes: calls.filter((c) => c.method !== 'GET').length,
  categories: calls.reduce((out, c) => ((out[c.category] = (out[c.category] || 0) + 1), out), {}),
});
const request = {
  kind: 'transfer',
  accountId: 'demo-lin',
  targetAccountId: 'demo-work',
  ids: ['projects'],
  recursive: true,
  removeSource: false,
  moveToTargetRoot: false,
};
async function settled(repo, id) {
  for (let n = 0; n < 2000; n++) {
    const t = repo.tasks().find((t) => t.id === id);
    if (t && ['paused', 'completed', 'partial'].includes(t.status)) return t;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw Error('Benchmark task did not settle');
}
try {
  for (const delayed of legacy ? [false, true] : [false, true, 'acceptance-lag']) {
    const { repo, drive, calls } = setup(delayed),
      engine = new TaskEngine(repo, drive, { propagationDelays: [0, 0, 0] });
    await drive.list('demo-lin', 'projects', true);
    const scan = count(calls);
    calls.length = 0;
    await drive.get('demo-lin', 'projects');
    const open = count(calls);
    calls.length = 0;
    const plan = await engine.preview({ ...request });
    const preview = count(calls);
    calls.length = 0;
    const task = engine.submit(plan.id);
    let pauses = 0;
    let outcome = await settled(repo, task.id);
    while (outcome.status === 'paused' && pauses < 10) {
      pauses++;
      await engine.control(task.id, 'retry');
      outcome = await settled(repo, task.id);
    }
    if (outcome.status !== 'completed' || outcome.items.length !== 7)
      throw Error('Unexpected benchmark outcome');
    const metrics = repo.taskSummaries().find((t) => t.id === task.id)?.api;
    if (
      !legacy &&
      (metrics?.reads !== count(calls).reads || metrics?.writes !== count(calls).writes)
    )
      throw Error('Persisted request counters differ from transport trace');
    results.push({
      scenario:
        delayed === 'acceptance-lag'
          ? '7-items-acceptance-lag-with-auto-recheck'
          : delayed
            ? '7-items-one-invisible-pending-read-per-item'
            : '7-items-normal-transfer',
      items: 7,
      pauses,
      metrics,
      scan,
      open,
      preview,
      execution: count(calls),
      endToEnd: scan.total + open.total + preview.total + calls.length,
    });
  }
  {
    const { repo, drive, calls } = setup(),
      engine = new TaskEngine(repo, drive, { propagationDelays: [0, 0, 0] });
    const plan = await engine.preview({ ...request, ids: ['projects', 'design-a'] });
    results.push({
      scenario: 'overlapping-parent-child-preview',
      items: plan.items.length,
      preview: count(calls),
    });
  }
  for (const n of [1, 3, 10]) {
    const { drive, calls, repo } = setup(),
      engine = new TaskEngine(repo, drive, { propagationDelays: [0, 0, 0] });
    const plan = await engine.preview({
      kind: 'share',
      accountId: 'demo-lin',
      ids: ['brief'],
      recursive: false,
      share: {
        ...DEFAULT_SHARE,
        collaborators: 'add',
        people: Array.from({ length: n }, (_, i) => ({
          email: `benchmark-${i}@example.com`,
          type: 'user',
          role: 'reader',
        })),
      },
    });
    calls.length = 0;
    const task = engine.submit(plan.id),
      outcome = await settled(repo, task.id);
    if (outcome.status !== 'completed') throw Error('Share benchmark failed');
    results.push({
      scenario: 'add-collaborators-one-file',
      collaborators: n,
      execution: count(calls),
    });
  }
  const reportDir = legacy ? 'test-results/api-baseline-1.2.2' : 'test-results/api-optimized-1.3.0';
  await mkdir(reportDir, { recursive: true });
  const report = {
    benchmark: `${legacy ? '1.2.2 baseline' : '1.3.0 optimized'}; actual GoogleDrive HTTP request boundary with synthetic responses; no remote requests`,
    assumptions: [
      'Each list fits in one page',
      'No OAuth refresh, HTTP throttling or transport retries',
      '7 items include 3 folders and 4 files across 3 levels',
      'Transfer does not move to target root or remove source permissions',
      'Delayed case hides pending permission exactly once per item',
      'Additional optimized acceptance-lag case rejects first accept and hides first target permission read; verification waits use a zero-delay test clock, not a speed measurement',
    ],
    results,
  };
  await writeFile(`${reportDir}/results.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  globalThis.fetch = savedFetch;
}
