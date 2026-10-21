import { test, expect } from 'vitest';
import { buildSide } from '../src/runtime.js';
import { codexRequestContext } from '../src/codex/self.js';
import type { CodexEnv } from '../src/codex/discover.js';

const a = '00000000-0000-0000-0000-000000000aaa';
const b = '00000000-0000-0000-0000-000000000bbb';
const threads = [
  { id: a, name: 'Project alpha', cwd: '/src/alpha' },
  { id: b, name: 'Project beta', cwd: '/src/beta' },
];
const codex: CodexEnv = {
  probe: async () => ({ ok: true }),
  listThreads: async () => threads,
  liveThreads: async () => new Map([[a, { pid: process.pid }], [b, { pid: process.pid }]]),
  readThread: async () => ({ ok: true }),
  queue: async () => ({ ok: true }),
};
function side() {
  return buildSide('codex', { pid: process.pid, cwd: '/daemon', registryDirs: () => [], env: {} }, { codex });
}

test('concurrent MCP requests keep their own thread id, title and cwd', async () => {
  const host = side();
  const results = await Promise.all([a,b].map(threadId => codexRequestContext.run({ threadId }, async () => {
    const self = await host.resolveSelf();
    await new Promise(resolve => setImmediate(resolve));
    return { id: await host.selfDurableId!(self), name: await host.selfName(self), cwd: self.cwd };
  })));
  expect(results).toEqual([
    { id: { thread_id: a }, name: 'project-alpha', cwd: '/src/alpha' },
    { id: { thread_id: b }, name: 'project-beta', cwd: '/src/beta' },
  ]);
});

test('a resolved identity stays consistent after a call from another thread', async () => {
  const host = side();
  const first = await codexRequestContext.run({threadId: a}, () => host.resolveSelf());
  await codexRequestContext.run({threadId: b}, () => host.resolveSelf());
  expect(await host.selfDurableId!(first)).toEqual({thread_id: a});
  expect(await host.selfName(first)).toBe('project-alpha');
});

test('missing request metadata never selects an arbitrary shared-daemon thread', async () => {
  expect((await side().resolveSelf()).sessionId).toBeUndefined();
});

test('invalid supplied metadata is refused instead of guessing from ancestry', async () => {
  for (const threadId of ['', 42, 'not-a-thread']) {
    await expect(codexRequestContext.run({threadId}, () => side().resolveSelf())).rejects.toThrow(/threadId/);
  }
});

import { createTools } from '../src/tools.js';
import { MessageLog } from '../src/log.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function isolatedHost() {
  return buildSide('codex', { pid: process.pid, cwd: '/daemon', registryDirs: () => [], env: { OPENCODE_CONFIG_DIR: '/nonexistent' } }, {
    codex,
    sweep: { socketDirs: [] },
  });
}

test('peers and send use the same request identity and refuse a renamed self address', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tincan-identity-'));
  try {
    const tools = createTools(isolatedHost(), new MessageLog(join(dir, 'log')));
    await codexRequestContext.run({threadId: a}, async () => {
      const listed = await tools.peers();
      expect(listed.self).toMatchObject({thread_id: a, name: 'project-alpha.aaa', cwd: '/src/alpha'});
      expect(listed.peers.map(p => p.thread_id)).toEqual([b]);
      expect(await tools.send_peer({peer: `codex:old-title.${a}`, message: 'test'})).toMatchObject({outcome: 'rejected', refusal: 'self_send'});
      expect(await tools.send_peer({peer: `codex:project-beta.${b}`, message: 'test'})).toMatchObject({outcome: 'accepted'});
      const records = await tools.message_log({});
      expect(records.records.find(r => 'from' in r && r.from.runtime === 'codex')).toMatchObject({from: {thread_id: a, name: 'project-alpha', cwd: '/src/alpha'}});
    });
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('ambiguous sender identity refuses a send before delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tincan-identity-'));
  try {
    const tools = createTools(isolatedHost(), new MessageLog(join(dir, 'log')));
    expect(await tools.send_peer({peer: `codex:project-beta.${b}`, message: 'test'})).toMatchObject({outcome: 'rejected', refusal: 'self_unknown'});
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a metadata-identified thread without listing metadata never borrows the daemon project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tincan-identity-'));
  try {
    const host = buildSide('codex', {pid: process.pid, cwd: '/daemon', registryDirs: () => [], env: {}}, {
      codex: {...codex, listThreads: async () => []}, sweep: {socketDirs: []},
    });
    const log = new MessageLog(join(dir, 'log'));
    log.appendUnsent('msg_synthetic', {runtime: 'external', name: 'notice', cwd: '/daemon'}, 'alpha', 'peer_unknown', 'Other project');
    const tools = createTools(host, log);
    await codexRequestContext.run({threadId: a}, async () => {
      expect(await host.resolveSelf()).toMatchObject({sessionId: a, name: 'thread', cwd: ''});
      const scoped = await tools.message_log({});
      expect(scoped.records).toEqual([]);
      expect(scoped.scope_note).toMatch(/unknown/i);
      expect((await tools.message_log({all_projects: true})).records).toHaveLength(1);
    });
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
