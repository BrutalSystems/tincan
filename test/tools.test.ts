import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageLog } from '../src/log.js';
import { CODEX_LIMITS, CLAUDE_LIMITS } from '../src/guard.js';
import { createTools, type Side, type SidePeer } from '../src/tools.js';

let dir: string;
let log: MessageLog;

const peer = (over: Partial<SidePeer> = {}): SidePeer => ({
  runtime: 'codex',
  rawName: 'Auth refactor',
  uuid: '00000000-0000-0000-0000-0000000007f3',
  cwd: '/src/auth',
  state: 'idle',
  threadId: '00000000-0000-0000-0000-0000000007f3',
  ...over,
});

interface Delivered {
  text: string;
  logLinesAtDeliveryTime: number;
}

function makeSide(over: Partial<Side> = {}) {
  const delivered: Delivered[] = [];
  const side: Side = {
    selfRuntime: 'claude-code',
    selfName: async () => 'billing-api',
    selfCwd: '/src/billing',
    peerRuntimes: ['codex'],
    limitsFor: (r: 'codex' | 'claude-code') => (r === 'codex' ? CODEX_LIMITS : CLAUDE_LIMITS),
    supportsUrgent: false,
    listPeers: async () => ({ peers: [peer()] }),
    deliver: async (_p, _e, text) => {
      delivered.push({ text, logLinesAtDeliveryTime: log.read({ last_n: 999 }).length });
      return { delivered: true, method: 'thread/queue/add' as const };
    },
    ...over,
  };
  return { side, delivered };
}

const tools = (side: Side) => createTools(side, log);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tincan-tools-'));
  log = new MessageLog(join(dir, 'messages.jsonl'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('peers', () => {
  test.each([null, '', '   ', '???'])('labels an unnamed session (%j) with its project and trailing id', async (rawName) => {
    const { side } = makeSide({
      listPeers: async () => ({ peers: [peer({ rawName, cwd: '/src/billing-v2/' })] }),
    });
    const r = await tools(side).peers();
    expect(r.peers[0]).toMatchObject({
      display_label: 'billing-v2 · 07f3',
      thread_id: '00000000-0000-0000-0000-0000000007f3',
    });
    // The human label must not replace the existing send address.
    const result = await tools(side).send_peer({ peer: r.peers[0]!.name, message: 'hello' });
    expect(result.delivered).toBe(true);
  });

  test.each(['', '/'])('labels an unnamed session without a project using its runtime (%j)', async (cwd) => {
    const { side } = makeSide({
      listPeers: async () => ({ peers: [peer({ rawName: null, cwd })] }),
    });
    expect((await tools(side).peers()).peers[0]).toMatchObject({ display_label: 'codex · 07f3' });
  });

  test('lists the other runtime with display name, state and cwd', async () => {
    const { side } = makeSide();
    const r = await tools(side).peers();
    expect(r.peers[0]).toMatchObject({
      name: 'auth-refactor',
      display_label: 'auth-refactor',
      canonical_id: 'codex:auth-refactor.7f3',
      state: 'idle',
      cwd: '/src/auth',
      thread_id: '00000000-0000-0000-0000-0000000007f3',
    });
  });

  test('exposes a durable session_id for Claude peers, not just the address', async () => {
    // CANONICAL_ID.md tells consumers to key on the id rather than the name,
    // because canonical_id is not unique. Claude peers must therefore carry one.
    const { side } = makeSide({
      peerRuntimes: ['claude-code'],
      listPeers: async () => ({
        peers: [peer({ runtime: 'claude-code', rawName: 'billing-api', uuid: '5af69d42-2214-41d9-b13f-9c3177eb60ce', threadId: undefined })],
      }),
    });
    const r = await tools(side).peers();
    expect(r.peers[0]).toMatchObject({ session_id: '5af69d42-2214-41d9-b13f-9c3177eb60ce' });
    expect(r.peers[0]).not.toHaveProperty('thread_id');
  });

  test('exposes thread_id for Codex peers, and no session_id', async () => {
    const { side } = makeSide();
    const r = await tools(side).peers();
    expect(r.peers[0]).toMatchObject({ thread_id: '00000000-0000-0000-0000-0000000007f3' });
    expect(r.peers[0]).not.toHaveProperty('session_id');
  });

  test('every peer carries a durable id, whichever runtime it is', async () => {
    for (const runtime of ['codex', 'claude-code'] as const) {
      const { side } = makeSide({ peerRuntimes: [runtime], listPeers: async () => ({ peers: [peer({ runtime, threadId: runtime === 'codex' ? '00000000-0000-0000-0000-0000000007f3' : undefined })] }) });
      const r = await tools(side).peers();
      const p0 = r.peers[0]!;
      expect(p0.thread_id ?? p0.session_id).toBeTruthy();
    }
  });

  test('carries a diagnostic instead of a bare empty list when the far side is absent', async () => {
    const { side } = makeSide({
      listPeers: async () => ({ peers: [], diagnostic: 'No usable `codex` on PATH.' }),
    });
    const r = await tools(side).peers();
    expect(r.peers).toEqual([]);
    expect(r.diagnostic).toContain('codex');
  });

  test('reports that urgent has no effect when the runtime cannot be steered', async () => {
    const { side } = makeSide();
    const r = await tools(side).peers();
    expect(r.notes?.join(' ')).toMatch(/urgent/i);
  });
});

describe('mixed-runtime peer lists', () => {
  const mixed = () =>
    makeSide({
      peerRuntimes: ['codex', 'claude-code'],
      listPeers: async () => ({
        peers: [
          peer({ runtime: 'codex', rawName: 'Auth refactor', uuid: '00000000-0000-0000-0000-0000000007f3' }),
          peer({
            runtime: 'claude-code',
            rawName: 'billing-api',
            uuid: '5af69d42-2214-41d9-b13f-9c3177eb60ce',
            threadId: undefined,
          }),
        ],
      }),
    });

  test('names each peer by its own runtime, not the host side', async () => {
    const r = await tools(mixed().side).peers();
    expect(r.peers.map((p) => p.canonical_id)).toEqual([
      'codex:auth-refactor.7f3',
      'claude-code:billing-api.0ce',
    ]);
  });

  test('gives each peer the durable id field of its own runtime', async () => {
    const r = await tools(mixed().side).peers();
    expect(r.peers[0]).toHaveProperty('thread_id');
    expect(r.peers[1]).toHaveProperty('session_id');
  });

  test('records the delivery method of the peer runtime, not the host', async () => {
    const { side } = mixed();
    const t = tools(side);
    await t.send_peer({ peer: 'auth-refactor', message: 'to codex' });
    await t.send_peer({ peer: 'billing-api', message: 'to claude' });
    const methods = log.read({ last_n: 10 }).map((r) => (r.kind === undefined ? r.method : null));
    expect(methods).toEqual(['thread/queue/add', 'inbox']);
  });

  test('suffixes a name that collides across runtimes', async () => {
    const { side } = makeSide({
      peerRuntimes: ['codex', 'claude-code'],
      listPeers: async () => ({
        peers: [
          peer({ runtime: 'codex', rawName: 'api', uuid: '00000000-0000-0000-0000-000000000aaa' }),
          peer({ runtime: 'claude-code', rawName: 'api', uuid: '00000000-0000-0000-0000-000000000bbb', threadId: undefined }),
        ],
      }),
    });
    const r = await tools(side).peers();
    expect(r.peers.map((p) => p.name)).toEqual(['api.aaa', 'api.bbb']);
  });

  test('holds each peer to the guard budget of its own runtime', async () => {
    // Codex is tighter because every send starts a turn.
    const { side } = mixed();
    const t = tools(side);
    for (let i = 0; i < CODEX_LIMITS.perMinute; i++) {
      await t.send_peer({ peer: 'auth-refactor', message: `codex ${i}` });
    }
    const overCodex = await t.send_peer({ peer: 'auth-refactor', message: 'one too many' });
    expect(overCodex.refusal).toBe('rate_limited');

    // the Claude peer still has budget left
    const claudeOk = await t.send_peer({ peer: 'billing-api', message: 'still fine' });
    expect(claudeOk.delivered).toBe(true);
  });
});

describe('send_peer', () => {
  test('envelopes the message and delivers the sender text verbatim inside it', async () => {
    const { side, delivered } = makeSide();
    await tools(side).send_peer({ peer: 'auth-refactor', message: 'why does verifyToken skew?' });
    expect(delivered[0]!.text).toContain('<peer_message from="billing-api"');
    expect(delivered[0]!.text).toContain('why does verifyToken skew?');
    expect(delivered[0]!.text).toContain('</peer_message>');
  });

  test('always populates method and peer_state', async () => {
    const { side } = makeSide();
    const r = await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi' });
    expect(r).toMatchObject({ delivered: true, method: 'thread/queue/add', peer_state: 'idle' });
    expect(r.message_id).toMatch(/^msg_/);
  });

  test('logs the message before attempting delivery', async () => {
    const { side, delivered } = makeSide();
    await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi' });
    expect(delivered[0]!.logLinesAtDeliveryTime).toBe(1);
  });

  test('refuses a send to yourself by name, saying so plainly', async () => {
    // A Codex-hosted instance filters its own thread out of the listing, so a
    // self-send would otherwise read as "no such peer", which is misleading.
    const { side } = makeSide({ selfName: async () => 'auth-service' });
    const r = await tools(side).send_peer({ peer: 'auth-service', message: 'hi' });
    expect(r.delivered).toBe(false);
    expect(r.refusal).toBe('peer_unknown');
    expect(r.detail?.toLowerCase()).toContain('yourself');
  });

  test('refuses an unknown peer', async () => {
    const { side } = makeSide();
    const r = await tools(side).send_peer({ peer: 'nope', message: 'hi' });
    expect(r).toMatchObject({ delivered: false, refusal: 'peer_unknown' });
  });

  test('refuses an ambiguous peer and lists the suffixed candidates', async () => {
    const { side } = makeSide({
      listPeers: async () => ({
        peers: [
          peer({ rawName: 'Review phase 1', uuid: '00000000-0000-0000-0000-000000000aaa' }),
          peer({ rawName: 'Review phase-1', uuid: '00000000-0000-0000-0000-000000000bbb' }),
        ],
      }),
    });
    const r = await tools(side).send_peer({ peer: 'review', message: 'hi' });
    expect(r).toMatchObject({ delivered: false, refusal: 'peer_ambiguous' });
    expect(r.candidates?.sort()).toEqual(['review-phase-1.aaa', 'review-phase-1.bbb']);
  });

  test('refuses an unreachable peer without attempting delivery', async () => {
    const { side, delivered } = makeSide({
      listPeers: async () => ({ peers: [peer({ state: 'unreachable' })] }),
    });
    const r = await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi' });
    expect(r).toMatchObject({ delivered: false, refusal: 'peer_unreachable' });
    expect(delivered).toEqual([]);
  });

  test('refuses an oversize message before the guard even sees a peer', async () => {
    const { side } = makeSide();
    const r = await tools(side).send_peer({ peer: 'auth-refactor', message: 'x'.repeat(100_001) });
    expect(r).toMatchObject({ delivered: false, refusal: 'too_large' });
  });

  test('refuses an identical repeat and records the drop in the log', async () => {
    const { side } = makeSide();
    const t = tools(side);
    await t.send_peer({ peer: 'auth-refactor', message: 'ping' });
    const r = await t.send_peer({ peer: 'auth-refactor', message: 'ping' });
    expect(r).toMatchObject({ delivered: false, refusal: 'identical_repeat' });
    expect(r.detail?.toLowerCase()).toContain('do not resend');
    const dropped = log.read({ last_n: 99 }).filter((x) => x.kind === 'dropped');
    expect(dropped).toHaveLength(1);
  });

  test('records an unknown in_reply_to without validating it', async () => {
    const { side } = makeSide();
    const r = await tools(side).send_peer({
      peer: 'auth-refactor',
      message: 'hi',
      in_reply_to: 'msg_never_seen',
    });
    expect(r.delivered).toBe(true);
    const rec = log.read({ last_n: 1 })[0]!;
    expect(rec).toMatchObject({ in_reply_to: 'msg_never_seen' });
  });

  test('records a hold notice as a notice, not a delivery failure', async () => {
    const { side } = makeSide({
      deliver: async () => ({ delivered: true, method: 'inbox' as const, notice: 'receiver held message' }),
    });
    const r = await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi' });
    expect(r.delivered).toBe(true);
    expect(log.read({ last_n: 99 })[0]).toMatchObject({ notice: 'receiver held message' });
  });

  test('marks delivery false and keeps the record when the transport fails', async () => {
    const { side } = makeSide({
      deliver: async () => ({ delivered: false, method: 'thread/queue/add' as const, error: 'thread not found' }),
    });
    const r = await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi' });
    expect(r.delivered).toBe(false);
    expect(r.detail).toContain('thread not found');
    expect(log.read({ last_n: 1 })[0]).toMatchObject({ delivered: false });
  });
});

describe('message_log', () => {
  test('reads back what was sent, as one record per message', async () => {
    const { side } = makeSide();
    await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi there' });
    const r = await tools(side).message_log({ last_n: 20 });
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ text: 'hi there', direction: 'out', delivered: true });
  });
});
