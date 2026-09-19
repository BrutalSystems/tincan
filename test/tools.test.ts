import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageLog } from '../src/log.js';
import { Guard, CODEX_LIMITS } from '../src/guard.js';
import { createTools, type Side, type SidePeer } from '../src/tools.js';

let dir: string;
let log: MessageLog;

const peer = (over: Partial<SidePeer> = {}): SidePeer => ({
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
    selfName: 'billing-api',
    selfCwd: '/src/billing',
    peerRuntime: 'codex',
    limits: CODEX_LIMITS,
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

const tools = (side: Side) => createTools(side, log, new Guard(side.limits));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tincan-tools-'));
  log = new MessageLog(join(dir, 'messages.jsonl'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('peers', () => {
  test('lists the other runtime with display name, state and cwd', async () => {
    const { side } = makeSide();
    const r = await tools(side).peers();
    expect(r.peers[0]).toMatchObject({
      name: 'auth-refactor',
      canonical_id: 'codex:auth-refactor.7f3',
      state: 'idle',
      cwd: '/src/auth',
      thread_id: '00000000-0000-0000-0000-0000000007f3',
    });
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
