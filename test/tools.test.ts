import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageLog } from '../src/log.js';
import { buildEnvelope } from '../src/envelope.js';
import { CODEX_LIMITS, CLAUDE_LIMITS } from '../src/guard.js';
import { createTools, labelList, type Side, type SidePeer } from '../src/tools.js';
import { VERSION } from '../src/version.js';

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
    resolveSelf: async () => ({ sessionId: undefined }),
    selfName: async () => 'billing-api',
    selfCwd: '/src/billing',
    peerRuntimes: ['codex'],
    limitsFor: (r: 'codex' | 'claude-code') => (r === 'codex' ? CODEX_LIMITS : CLAUDE_LIMITS),
    listPeers: async () => ({ peers: [peer()] }),
    deliver: async (_self, _selfName, _p, _e, text) => {
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

describe('labelList', () => {
  test('renders one runtime as its bare label', () => {
    expect(labelList(['codex'])).toBe('Codex');
  });

  test('joins two with "and", no comma', () => {
    expect(labelList(['codex', 'claude-code'])).toBe('Codex and Claude Code');
  });

  test('joins three as a list, not "A and B and C"', () => {
    // The Codex and opencode hosts list all three runtimes, so every peer
    // tool description on those hosts read "Codex and Claude Code and
    // opencode".
    expect(labelList(['codex', 'claude-code', 'opencode'])).toBe(
      'Codex, Claude Code, and opencode',
    );
  });

  test('collapses a repeated runtime rather than naming it twice', () => {
    expect(labelList(['codex', 'codex'])).toBe('Codex');
  });

  test('renders an empty list as the empty string', () => {
    expect(labelList([])).toBe('');
  });
});

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
    expect(result.outcome).toBe('accepted');
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
      canonical_id: 'codex:auth-refactor.00000000-0000-0000-0000-0000000007f3',
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

  test('names the specific runtime that cannot be steered, not "neither"', async () => {
    const { side } = makeSide();
    const r = await tools(side).peers();
    expect(r.notes?.join(' ')).toMatch(/urgent/i);
    // The human label, the same one tool-definitions.ts uses — not the raw
    // RuntimeName token.
    expect(r.notes?.join(' ')).toContain('Codex');
    expect(r.notes?.join(' ')).not.toMatch(/neither/i);
  });

  test('labels runtimes in the urgent note exactly as the tool descriptions do', async () => {
    // tool-definitions.ts renders "Codex and Claude Code"; this note used to
    // join the raw tokens and render "codex and claude-code" for the same
    // pair of runtimes, in the same tool output.
    const { side } = makeSide({
      peerRuntimes: ['codex', 'claude-code'],
      listPeers: async () => ({ peers: [peer()] }),
    });
    const r = await tools(side).peers();
    expect(r.notes?.join(' ')).toContain('Codex and Claude Code');
    expect(r.notes?.join(' ')).not.toContain('claude-code');
  });

  test('says urgent has no effect for opencode either, now that nothing is steerable', async () => {
    // opencode was the last steerable runtime, via the v2 prompt route's
    // delivery:"steer". That route does not run the message on a TUI-hosted
    // session, so the plugin moved to v1 prompt_async, which has no delivery
    // mode. The note must now name opencode too rather than exempting it.
    const { side } = makeSide({
      selfRuntime: 'opencode',
      peerRuntimes: ['opencode'],
      listPeers: async () => ({ peers: [peer({ runtime: 'opencode', socketPath: '/tmp/x.sock' })] }),
    });
    const r = await tools(side).peers();
    expect(r.notes?.join(' ')).toMatch(/urgent/i);
    expect(r.notes?.join(' ')).toContain('opencode');
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
      'codex:auth-refactor.00000000-0000-0000-0000-0000000007f3',
      'claude-code:billing-api.5af69d42-2214-41d9-b13f-9c3177eb60ce',
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
    expect(claudeOk.outcome).toBe('accepted');
  });
});

describe('send_peer', () => {
  test('envelopes the message and delivers the sender text verbatim inside it', async () => {
    const { side, delivered } = makeSide();
    await tools(side).send_peer({ peer: 'auth-refactor', message: 'why does verifyToken skew?' });
    expect(delivered[0]!.text).toContain('<peer_message from="billing-api"');
    expect(delivered[0]!.text).toContain('why does verifyToken skew?');
    // The text leads and the metadata self-closes, so the sender's words are
    // the first thing in the envelope — and the first thing a Claude Code
    // recipient previews on its collapsed line.
    expect(delivered[0]!.text.split('\n')[0]).toBe('why does verifyToken skew?');
  });

  test(
    'passes urgent through to Side.deliver — the exact seam where an arrow with a dropped ' +
      'parameter type-checks but silently always queues (C2)',
    async () => {
      const recorded: boolean[] = [];
      const { side } = makeSide({
        deliver: async (_self, _selfName, _p, _e, _t, urgent) => {
          recorded.push(urgent);
          return { delivered: true, method: 'thread/queue/add' as const };
        },
      });
      await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi', urgent: true });
      expect(recorded).toEqual([true]);
    },
  );

  test('defaults urgent to false when omitted, and Side.deliver sees false, not undefined', async () => {
    const recorded: boolean[] = [];
    const { side } = makeSide({
      deliver: async (_self, _selfName, _p, _e, _t, urgent) => {
        recorded.push(urgent);
        return { delivered: true, method: 'thread/queue/add' as const };
      },
    });
    await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi' });
    expect(recorded).toEqual([false]);
  });

  test('always populates method and peer_state', async () => {
    const { side } = makeSide();
    const r = await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi' });
    expect(r).toMatchObject({ outcome: 'accepted', method: 'thread/queue/add', peer_state: 'idle' });
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
    expect(r.outcome).toBe('rejected');
    expect(r.refusal).toBe('self_send');
    expect(r.detail?.toLowerCase()).toContain('yourself');
  });

  test('a self-send is refusal "self_send", not "peer_unknown" — the peer exists', async () => {
    // #4. The detail string always said this plainly, but the machine-readable
    // code did not: a caller branching on `refusal` saw "no such peer" for a
    // peer that definitely exists. It matters most on a Claude Code host,
    // where `peer_unknown` otherwise covers three different situations at
    // once — a typo, a session in another CLAUDE_CONFIG_DIR that is not
    // listed, and yourself.
    const { side } = makeSide({ selfName: async () => 'auth-service' });
    const r = await tools(side).send_peer({ peer: 'auth-service', message: 'hi' });
    expect(r.refusal).toBe('self_send');
    expect(r.refusal).not.toBe('peer_unknown');
  });

  /**
   * Cross-account mis-send.
   *
   * A Claude Code host carries no session id of its own (`resolveSelf` answers
   * NO_SESSION), so `isSelfAddress` can only compare NAMES. `selfNameFor` falls
   * back to `basename(cwd)` when CLAUDE_CODE_SESSION_ID is absent or the
   * registry lookup misses — and CLAUDE_CODE_SESSION_ID being absent is now
   * also what makes the arm hide its own config dir, so the peers left in the
   * list at that moment are precisely the other accounts.
   *
   * `resolvePeer` delivers on a single PREFIX match. So a fallback self-name
   * that prefixes exactly one other-account peer resolves to that peer and
   * delivers: the message leaves the account, to a stranger's session, while
   * the sender believes they addressed themselves. Under-exclusion like #19,
   * except the message does not loop back — it lands somewhere else.
   */
  test('never delivers to another account when the address also names us', async () => {
    const { side, delivered } = makeSide({
      // The cwd-basename fallback: CLAUDE_CODE_SESSION_ID absent.
      selfName: async () => 'tincan',
      listPeers: async () => ({
        peers: [
          peer({
            runtime: 'claude-code',
            rawName: 'tincan arm',
            uuid: '00000000-0000-0000-0000-00000000a17f',
            cwd: '/Users/other/Source/tincan',
            threadId: undefined,
            configDir: '/Users/other/.claude-arm',
          }),
        ],
      }),
    });

    const r = await tools(side).send_peer({ peer: 'tincan', message: 'note to self' });

    expect(delivered).toHaveLength(0);
    expect(r.outcome).toBe('rejected');
    expect(r.refusal).toBe('self_send');
  });

  test('an exact peer name still wins over a self-name that merely prefixes it', async () => {
    // The precedence above must not swallow a legitimate send. Exact beats
    // self; self beats prefix. Here `review` is exactly a peer's name and
    // also a prefix of our own `review-tools`, and the peer must get it.
    const { side, delivered } = makeSide({
      selfName: async () => 'review-tools',
      listPeers: async () => ({
        peers: [peer({ rawName: 'review', uuid: '00000000-0000-0000-0000-0000000004e2' })],
      }),
    });

    const r = await tools(side).send_peer({ peer: 'review', message: 'hi' });

    expect(r.outcome).toBe('accepted');
    expect(delivered).toHaveLength(1);
  });

  test('refuses an unknown peer', async () => {
    const { side } = makeSide();
    const r = await tools(side).send_peer({ peer: 'nope', message: 'hi' });
    expect(r).toMatchObject({ outcome: 'rejected', refusal: 'peer_unknown' });
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
    expect(r).toMatchObject({ outcome: 'rejected', refusal: 'peer_ambiguous' });
    expect(r.candidates?.sort()).toEqual(['review-phase-1.aaa', 'review-phase-1.bbb']);
  });

  test('refuses an unreachable peer without attempting delivery', async () => {
    const { side, delivered } = makeSide({
      listPeers: async () => ({ peers: [peer({ state: 'unreachable' })] }),
    });
    const r = await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi' });
    expect(r).toMatchObject({ outcome: 'rejected', refusal: 'peer_unreachable' });
    expect(delivered).toEqual([]);
  });

  test('refuses an oversize message before the guard even sees a peer', async () => {
    const { side } = makeSide();
    const r = await tools(side).send_peer({ peer: 'auth-refactor', message: 'x'.repeat(100_001) });
    expect(r).toMatchObject({ outcome: 'rejected', refusal: 'too_large' });
  });

  test('refuses an identical repeat and records the drop in the log', async () => {
    const { side } = makeSide();
    const t = tools(side);
    await t.send_peer({ peer: 'auth-refactor', message: 'ping' });
    const r = await t.send_peer({ peer: 'auth-refactor', message: 'ping' });
    expect(r).toMatchObject({ outcome: 'rejected', refusal: 'identical_repeat' });
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
    expect(r.outcome).toBe('accepted');
    const rec = log.read({ last_n: 1 })[0]!;
    expect(rec).toMatchObject({ in_reply_to: 'msg_never_seen' });
  });

  test('records a hold notice as a notice, not a delivery failure', async () => {
    const { side } = makeSide({
      deliver: async () => ({ delivered: true, method: 'inbox' as const, notice: 'receiver held message' }),
    });
    const r = await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi' });
    expect(r.outcome).toBe('accepted');
    expect(log.read({ last_n: 99 })[0]).toMatchObject({ notice: 'receiver held message' });
  });

  test('marks delivery false and keeps the record when the transport fails', async () => {
    const { side } = makeSide({
      deliver: async () => ({ delivered: false, method: 'thread/queue/add' as const, error: 'thread not found' }),
    });
    const r = await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi' });
    expect(r.outcome).toBe('failed');
    expect(r.detail).toContain('thread not found');
    expect(log.read({ last_n: 1 })[0]).toMatchObject({ outcome: 'failed' });
  });

  test(
    'a peer that vanished mid-send is refused as peer_unreachable, not delivery_failed ' +
      '— the caller can tell "that session exited" from "something went wrong" (issue #10)',
    async () => {
      const { side } = makeSide({
        deliver: async () => ({
          delivered: false,
          method: 'inbox' as const,
          unreachable: true,
          error: 'ECONNREFUSED',
        }),
      });
      const r = await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi' });
      expect(r.outcome).toBe('failed');
      expect(r.refusal).toBe('peer_unreachable');
      expect(r.peer_state).toBe('unreachable');
      // The transport's own error is still worth surfacing, but the refusal
      // is what a caller branches on.
      expect(r.detail).toContain('ECONNREFUSED');
    },
  );

  test('a delivery that genuinely errored is still delivery_failed', async () => {
    const { side } = makeSide({
      deliver: async () => ({
        delivered: false,
        method: 'thread/queue/add' as const,
        error: 'malformed request',
      }),
    });
    const r = await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi' });
    expect(r.refusal).toBe('delivery_failed');
  });

  test('logs delivery:"queue" for a normal send', async () => {
    const { side } = makeSide();
    await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi' });
    expect(log.read({ last_n: 1 })[0]).toMatchObject({ delivery: 'queue' });
  });

  test('logs delivery:"queue" for an urgent send to opencode — v1 has no steer', async () => {
    // Was 'steer'. The v2 route that accepted delivery:"steer" is the one
    // that does not run the message on a TUI-hosted session; v1 prompt_async
    // runs it and has no delivery mode. Logging 'steer' would record an
    // intent the wire no longer carries.
    const { side } = makeSide({
      listPeers: async () => ({ peers: [peer({ runtime: 'opencode', socketPath: '/tmp/x.sock' })] }),
      deliver: async () => ({ delivered: true, method: 'opencode/prompt_async' as const }),
    });
    await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi', urgent: true });
    expect(log.read({ last_n: 1 })[0]).toMatchObject({ delivery: 'queue' });
  });

  test(
    'logs delivery:"queue" — not "steer" — for an urgent send to a peer whose runtime cannot ' +
      'act on it (Codex, Claude Code): the field records effect, not bare urgent intent',
    async () => {
      const { side } = makeSide(); // default peer() is a Codex peer
      await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi', urgent: true });
      expect(log.read({ last_n: 1 })[0]).toMatchObject({ delivery: 'queue' });
    },
  );
});

describe('opencode delivery, after the move to v1 prompt_async', () => {
  // The notice this block used to assert is gone. It existed because the v2
  // route admitted a message and then failed to run it on a TUI-hosted
  // session. v1 prompt_async runs it — verified on stock 1.18.31, three
  // sends, three turns, three answers — so opencode is now in the same
  // position as Codex and Claude Code: `delivered` means the peer's harness
  // accepted it, which is all it ever meant for them either.
  const ocPeer = () =>
    peer({ runtime: 'opencode', rawName: 'witty-orchid', socketPath: '/tmp/x.sock', state: 'idle', threadId: undefined });

  const send = async () => {
    const { side } = makeSide({
      peerRuntimes: ['codex', 'opencode'],
      listPeers: async () => ({ peers: [ocPeer()] }),
      deliver: async () => ({ delivered: true, method: 'opencode/prompt_async' as const }),
    });
    return tools(side).send_peer({ peer: 'witty-orchid', message: 'hello' });
  };

  test('carries no notice — there is no longer a caveat to give', async () => {
    const r = await send();
    expect(r.outcome).toBe('accepted');
    expect(r.notice).toBeUndefined();
  });

  test('reports the v1 method, so the log says which route carried it', async () => {
    expect((await send()).method).toBe('opencode/prompt_async');
  });

  test('still surfaces a notice the delivery itself produced', async () => {
    const { side } = makeSide({
      peerRuntimes: ['codex', 'opencode'],
      listPeers: async () => ({ peers: [ocPeer()] }),
      deliver: async () => ({ delivered: true, method: 'opencode/prompt_async' as const, notice: 'held by the peer' }),
    });
    expect((await tools(side).send_peer({ peer: 'witty-orchid', message: 'x' })).notice).toBe('held by the peer');
  });
});

describe('message_log', () => {
  test('reads back what was sent, as one record per message', async () => {
    const { side } = makeSide();
    await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi there' });
    const r = await tools(side).message_log({ last_n: 20 });
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ text: 'hi there', direction: 'out', outcome: 'accepted' });
  });
});

test('a claude peer reports its config dir and whether it can reply', async () => {
  const { side } = makeSide({
    peerRuntimes: ['codex', 'opencode', 'claude-code'],
    listPeers: async () => ({
      peers: [
        peer({
          runtime: 'claude-code',
          rawName: 'other-account',
          uuid: 'sid-1',
          threadId: undefined,
          configDir: '/Users/x/.claude-arm',
          canReply: true,
        }),
      ],
    }),
  });
  const result = await tools(side).peers();
  expect(result.peers[0]?.config_dir).toBe('/Users/x/.claude-arm');
  expect(result.peers[0]?.can_reply).toBe(true);
});

test('a codex peer reports neither field', async () => {
  const { side } = makeSide();
  const result = await tools(side).peers();
  expect(result.peers[0]).not.toHaveProperty('config_dir');
  expect(result.peers[0]).not.toHaveProperty('can_reply');
});

test('an empty peer list carries no note claiming sessions were scoped out of it', async () => {
  // This note existed because an empty scoped list reads as "nothing else is
  // running". The list is not scoped any more, so an empty one means empty,
  // and a note pointing at a native path would send the reader looking for
  // sessions that are not there.
  const { side } = makeSide({ listPeers: async () => ({ peers: [] }) });
  const notes = (await tools(side).peers()).notes?.join(' ') ?? '';
  expect(notes).not.toContain('ListAgents');
  expect(notes).not.toContain('SendMessage');
  expect(notes).not.toContain('CLAUDE_CONFIG_DIR');
});

describe('message_log integrity', () => {
  test('stays quiet on a healthy log', async () => {
    const { side } = makeSide();
    await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi' });
    const r = await tools(side).message_log({ last_n: 10 });
    expect(r.integrity).toBeUndefined();
  });

  test('reports a damaged log instead of quietly returning fewer records', async () => {
    const { side } = makeSide();
    await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi' });
    appendFileSync(join(dir, 'messages.jsonl'), '{"id":"msg_half","at":\n');

    const r = await tools(side).message_log({ last_n: 10 });
    expect(r.integrity?.ok).toBe(false);
    expect(r.integrity?.unparseable).toBe(1);
    expect(r.integrity?.detail).toMatch(/incomplete|edited/i);
  });
});

// A model that is unsure whether its first send landed — its turn was
// interrupted, the tool call timed out, the human retried the prompt — has no
// way to ask. The only safe move available to it today is to send again, and
// the peer reads the message twice. `identical_repeat` catches only byte-equal
// text inside 60s, so changing one character defeats it.
describe('idempotency_key', () => {
  test('a repeat under the same key is refused and names the original message', async () => {
    const { side, delivered } = makeSide();
    const tools = createTools(side, log);

    const first = await tools.send_peer({
      peer: 'auth-refactor',
      message: 'rebase onto main',
      idempotency_key: 'turn-41-send-1',
    });
    expect(first.outcome).toBe('accepted');
    expect(delivered).toHaveLength(1);

    const second = await tools.send_peer({
      peer: 'auth-refactor',
      message: 'rebase onto main',
      idempotency_key: 'turn-41-send-1',
    });

    expect(second.outcome).toBe('rejected');
    expect(second.refusal).toBe('duplicate_send');
    // The whole point: the caller can tell "already sent" from "failed", and
    // can go read the original rather than guessing.
    expect(second.message_id).toBe(first.message_id);
    expect(delivered).toHaveLength(1);
  });

  test('a key reused with different text is refused and says the parameters differ', async () => {
    const { side, delivered } = makeSide();
    const tools = createTools(side, log);

    const first = await tools.send_peer({
      peer: 'auth-refactor',
      message: 'rebase onto main',
      idempotency_key: 'turn-41-send-1',
    });
    const second = await tools.send_peer({
      peer: 'auth-refactor',
      message: 'actually, hold off',
      idempotency_key: 'turn-41-send-1',
    });

    expect(second.refusal).toBe('duplicate_send');
    expect(second.message_id).toBe(first.message_id);
    // A reused key with changed parameters is a caller bug, not a retry, and
    // saying so is the difference between fixing it and resending forever.
    expect(second.detail).toMatch(/differ/i);
    expect(delivered).toHaveLength(1);
  });

  test('without a key, nothing changes: two different messages both go through', async () => {
    const { side, delivered } = makeSide();
    const tools = createTools(side, log);

    const a = await tools.send_peer({ peer: 'auth-refactor', message: 'first' });
    const b = await tools.send_peer({ peer: 'auth-refactor', message: 'second' });

    expect(a.outcome).toBe('accepted');
    expect(b.outcome).toBe('accepted');
    expect(a.message_id).not.toBe(b.message_id);
    expect(delivered).toHaveLength(2);
  });

  test('a refused send does not burn the key: the retry that follows it can succeed', async () => {
    // Otherwise the first transient failure poisons the key permanently, and
    // the caller's correct behaviour — retry under the same key — is exactly
    // what stops working.
    const { side, delivered } = makeSide({
      deliver: async () => ({ delivered: false, error: 'socket closed', method: 'thread/queue/add' as const }),
    });
    const tools = createTools(side, log);
    const first = await tools.send_peer({
      peer: 'auth-refactor',
      message: 'rebase onto main',
      idempotency_key: 'turn-41-send-1',
    });
    expect(first.outcome).toBe('failed');
    expect(first.refusal).not.toBe('duplicate_send');

    const { side: working, delivered: sent } = makeSide();
    const retryTools = createTools(working, log);
    const second = await retryTools.send_peer({
      peer: 'auth-refactor',
      message: 'rebase onto main',
      idempotency_key: 'turn-41-send-1',
    });
    expect(second.outcome).toBe('accepted');
    expect(sent).toHaveLength(1);
    expect(delivered).toHaveLength(0);
  });
});

// A peer can exit between `peers` and `send_peer`, and a new session can take
// its slug — Codex titles threads from their first prompt, so two sessions
// started from similar work slug identically. The message then goes to a
// stranger and is reported delivered, because it was.
describe('pinning a peer to the session that was listed', () => {
  const ID = '00000000-0000-0000-0000-0000000007f3';

  test('delivers when the listed session is still the one answering to the name', async () => {
    const { side, delivered } = makeSide();
    const tools = createTools(side, log);
    const r = await tools.send_peer({ peer: 'auth-refactor', message: 'ping', expect_id: ID });
    expect(r.outcome).toBe('accepted');
    expect(delivered).toHaveLength(1);
  });

  test('refuses when the name now resolves to a different session', async () => {
    // Same slug, different durable id: the original exited and a new session
    // took the name.
    const { side, delivered } = makeSide({
      listPeers: async () => ({
        peers: [peer({ uuid: '11111111-1111-1111-1111-111111111abc', threadId: '11111111-1111-1111-1111-111111111abc' })],
      }),
    });
    const tools = createTools(side, log);

    const r = await tools.send_peer({ peer: 'auth-refactor', message: 'ping', expect_id: ID });

    expect(r.outcome).toBe('rejected');
    expect(r.refusal).toBe('peer_changed');
    // Both ids, so the caller can tell which session it meant and which one is
    // there now, rather than being told only that something went wrong.
    expect(r.detail).toContain(ID);
    expect(r.detail).toContain('11111111-1111-1111-1111-111111111abc');
    expect(delivered).toHaveLength(0);
  });

  test('without expect_id nothing changes: the name resolves as it always did', async () => {
    const { side, delivered } = makeSide({
      listPeers: async () => ({
        peers: [peer({ uuid: '11111111-1111-1111-1111-111111111abc', threadId: '11111111-1111-1111-1111-111111111abc' })],
      }),
    });
    const tools = createTools(side, log);
    const r = await tools.send_peer({ peer: 'auth-refactor', message: 'ping' });
    expect(r.outcome).toBe('accepted');
    expect(delivered).toHaveLength(1);
  });

  test('a mismatch is refused before the guard sees it, so it costs no budget', async () => {
    const { side } = makeSide({
      listPeers: async () => ({
        peers: [peer({ uuid: '11111111-1111-1111-1111-111111111abc', threadId: '11111111-1111-1111-1111-111111111abc' })],
      }),
    });
    const tools = createTools(side, log);
    for (let i = 0; i < 6; i += 1) {
      const r = await tools.send_peer({ peer: 'auth-refactor', message: `ping ${i}`, expect_id: ID });
      expect(r.refusal).toBe('peer_changed');
    }
  });
});

// `rotated` rides on the integrity object, which was only returned when
// something was WRONG. A rotation is not a fault, so the notice would have
// been computed and then silently dropped — leaving a caller with a short log
// and nothing to explain it.
describe('message_log surfaces rotation', () => {
  test('returns integrity for a healthy but rotated log', async () => {
    const rotating = new MessageLog(join(dir, 'rot.jsonl'), { maxBytes: 4_000 });
    for (let i = 0; i < 60; i += 1) {
      rotating.appendMessage(
        buildEnvelope({
          id: `msg_${String(i).padStart(4, '0')}`,
          from: { runtime: 'claude-code', name: 'billing-api', cwd: '/src/billing' },
          to: { runtime: 'codex', name: 'auth-refactor', thread_id: 'x' },
          method: 'thread/queue/add',
          expect_reply: false,
          reply_tool: true,
          text: 'x'.repeat(200),
        }),
        true,
      );
    }
    const { side } = makeSide();
    const r = await createTools(side, rotating).message_log({ last_n: 5 });

    expect(r.integrity).toBeDefined();
    expect(r.integrity?.ok).toBe(true);
    expect(r.integrity?.rotated?.count).toBeGreaterThan(0);
  });

  test('still says nothing for a healthy unrotated log', async () => {
    const { side } = makeSide();
    const r = await createTools(side, log).message_log({ last_n: 5 });
    expect(r.integrity).toBeUndefined();
  });
});

// Telling three agents the same thing took three calls, and none of the three
// knew the other two had been told — so all three went and did the same work.
// The fan-out is the cheap half; saying who else was told is the point.
describe('fan-out', () => {
  const three = () => [
    peer({ rawName: 'Auth refactor', uuid: '00000000-0000-0000-0000-0000000007f3', threadId: '00000000-0000-0000-0000-0000000007f3' }),
    peer({ rawName: 'Docs pass', uuid: '00000000-0000-0000-0000-000000000abc', threadId: '00000000-0000-0000-0000-000000000abc' }),
    peer({ rawName: 'Tests pass', uuid: '00000000-0000-0000-0000-000000000def', threadId: '00000000-0000-0000-0000-000000000def' }),
  ];
  const fleet = (over = {}) => makeSide({ listPeers: async () => ({ peers: three() }), ...over });

  test('delivers to each named peer and ties them with one broadcast id', async () => {
    const { side, delivered } = fleet();
    const r: any = await createTools(side, log).send_peer({
      peers: ['auth-refactor', 'docs-pass'],
      message: 'the flaky test is mine',
    });

    expect(delivered).toHaveLength(2);
    expect(r.requested).toBe(2);
    expect(r.accepted).toBe(2);
    expect(r.results).toHaveLength(2);
    expect(r.broadcast_id).toMatch(/^bc_/);
    expect(new Set(r.results.map((x: any) => x.message_id)).size).toBe(2);
  });

  test('each recipient is told who else was told, and never itself', async () => {
    const { side, delivered } = fleet();
    await createTools(side, log).send_peer({
      peers: ['auth-refactor', 'docs-pass', 'tests-pass'],
      message: 'look at the flaky test',
    });

    const toAuth = delivered[0]!.text;
    expect(toAuth).toContain('also_sent_to');
    expect(toAuth).toContain('docs-pass');
    expect(toAuth).toContain('tests-pass');
    expect(toAuth).not.toMatch(/also_sent_to="[^"]*auth-refactor/);
  });

  test('a single-element list says nothing about others, because there are none', async () => {
    const { side, delivered } = fleet();
    await createTools(side, log).send_peer({ peers: ['auth-refactor'], message: 'just you' });
    expect(delivered[0]!.text).not.toContain('also_sent_to');
  });

  // You cannot un-send a message. A caller who reads `delivered` and skips
  // `detail` would otherwise believe three peers know something two were told.
  // Note the name has to be one that cannot resolve by PREFIX: 'docs-pas'
  // would legitimately resolve to 'docs-pass', which is documented behaviour
  // and not a typo Tin Can can detect.
  test('one unresolvable name refuses the whole call and sends nothing', async () => {
    const { side, delivered } = fleet();
    const before = log.read({ last_n: 999 }).length;
    const r: any = await createTools(side, log).send_peer({
      peers: ['auth-refactor', 'docs-passed', 'tests-pass'],
      message: 'x',
    });

    expect(r.accepted).toBe(0);
    expect(r.refusal).toBe('peer_unknown');
    expect(r.detail).toContain('docs-passed');
    expect(delivered).toHaveLength(0);
    // Assert the log too: a result that says nothing was sent is not evidence
    // that nothing was sent. No MESSAGE record may appear — and since #23 the
    // one new record is the attempt itself, naming the address that could not
    // be resolved and nobody else. The reachable two were never tried, so
    // recording an attempt against them would invent one.
    const after = log.read({ last_n: 999 });
    expect(after.filter((r) => r.kind === undefined)).toHaveLength(before);
    const unsent = after.filter((r) => r.kind === 'unsent');
    expect(unsent).toHaveLength(1);
    expect(unsent[0]).toMatchObject({ to_address: 'docs-passed', reason: 'peer_unknown' });
  });

  test('one unreachable peer refuses the whole call: it was knowable before sending', async () => {
    const { side, delivered } = makeSide({
      listPeers: async () => ({
        peers: [three()[0]!, { ...three()[1]!, state: 'unreachable' as const }],
      }),
    });
    const r: any = await createTools(side, log).send_peer({
      peers: ['auth-refactor', 'docs-pass'],
      message: 'x',
    });
    expect(r.refusal).toBe('peer_unreachable');
    expect(delivered).toHaveLength(0);
  });

  test('a peer that dies mid-fan-out is reported per recipient, not as a whole-call failure', async () => {
    let n = 0;
    const { side, delivered } = fleet({
      deliver: async (_s: unknown, _n: unknown, _p: unknown, _e: unknown, text: string) => {
        n += 1;
        if (n === 2) return { delivered: false, unreachable: true, error: 'gone' };
        delivered.push({ text, logLinesAtDeliveryTime: 0 });
        return { delivered: true, method: 'thread/queue/add' as const };
      },
    });
    const r: any = await createTools(side, log).send_peer({
      peers: ['auth-refactor', 'docs-pass', 'tests-pass'],
      message: 'x',
    });

    expect(r.requested).toBe(3);
    expect(r.accepted).toBe(2);
    expect(r.results.filter((x: any) => x.outcome !== 'accepted')).toHaveLength(1);
    expect(r.results.find((x: any) => x.outcome !== 'accepted').refusal).toBe('peer_unreachable');
  });

  test('peer and peers together, or neither, is a schema error', async () => {
    const { side } = fleet();
    const tools = createTools(side, log);
    await expect(tools.send_peer({ peer: 'a', peers: ['b'], message: 'x' } as any)).rejects.toThrow();
    await expect(tools.send_peer({ message: 'x' } as any)).rejects.toThrow();
  });

  test('the single-peer result shape is untouched', async () => {
    const { side } = fleet();
    const r: any = await createTools(side, log).send_peer({ peer: 'auth-refactor', message: 'x' });
    expect(r.outcome).toBe('accepted');
    expect(r).not.toHaveProperty('results');
    expect(r).not.toHaveProperty('broadcast_id');
  });
});

// The receiver could not route a reply by identity because the identity was
// never on the wire: EnvelopeParty has always declared thread_id/session_id,
// the `to` side filled them, and the `from` side did not. Observed live — a
// renamed Codex thread's reply-to name no longer resolved, and the replying
// model picked a different session from the candidate list.
describe('the sender identifies itself durably', () => {
  test('writes the sender durable id into the envelope and the log record', async () => {
    const { side } = makeSide({
      selfDurableId: async () => ({ thread_id: 'sender-thread-1' }),
    });
    const r = await createTools(side, log).send_peer({ peer: 'auth-refactor', message: 'x' });

    const rec: any = log.read({ last_n: 5 }).find((x) => x.id === r.message_id);
    expect(rec.from.thread_id).toBe('sender-thread-1');
  });

  test('omits it rather than inventing one when the arm cannot resolve it', async () => {
    const { side } = makeSide({ selfDurableId: async () => undefined });
    const r = await createTools(side, log).send_peer({ peer: 'auth-refactor', message: 'x' });

    const rec: any = log.read({ last_n: 5 }).find((x) => x.id === r.message_id);
    expect(rec.from.thread_id).toBeUndefined();
    expect(rec.from.session_id).toBeUndefined();
    expect(rec.from.name).toBe('billing-api');
  });
});

// #24 catch-up. A refused send can be left for the recipient to collect when
// it returns, but only when the sender said so: `replay_for_minutes` sets the
// shelf life, and absent it nothing is replayed, which is what Tin Can already
// did. Replay also needs to know WHO the message was for, and an `unsent`
// record has only the address as typed — so the durable id comes from
// `expect_id` where the caller gave one, and from the resolved peer where
// there was one. Neither available means not replayable, deliberately: a name
// match would hand a restarted session its predecessor's mail.
describe('a refused send can be left for the recipient, when the sender says so', () => {
  const ghostSide = () =>
    makeSide({ listPeers: async () => ({ peers: [] }) });

  test('records the shelf life and the intended recipient from expect_id', async () => {
    const { side } = ghostSide();
    const before = Date.now();
    const r = await tools(side).send_peer({
      peer: 'gone-session',
      message: 'the key rotated',
      expect_id: '5af69d42-2214-41d9-b13f-9c3177eb60ce',
      replay_for_minutes: 30,
    });

    const rec: any = log.read({ last_n: 5 }).find((x) => x.id === r.message_id);
    expect(rec.kind).toBe('unsent');
    expect(rec.to_id).toBe('5af69d42-2214-41d9-b13f-9c3177eb60ce');
    const until = Date.parse(rec.replay_until);
    expect(until).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
  });

  test('takes the durable id from the resolved peer when one was reached for', async () => {
    const { side } = makeSide({
      listPeers: async () => ({ peers: [{ ...peer(), state: 'unreachable' as const }] }),
    });
    const r = await tools(side).send_peer({
      peer: 'auth-refactor',
      message: 'x',
      replay_for_minutes: 30,
    });

    const rec: any = log.read({ last_n: 5 }).find((x) => x.id === r.message_id);
    expect(rec.reason).toBe('peer_unreachable');
    expect(rec.to_id).toBe('00000000-0000-0000-0000-0000000007f3');
  });

  test('records nothing replayable when the sender set no shelf life', async () => {
    const { side } = ghostSide();
    const r = await tools(side).send_peer({
      peer: 'gone-session',
      message: 'x',
      expect_id: '5af69d42-2214-41d9-b13f-9c3177eb60ce',
    });

    const rec: any = log.read({ last_n: 5 }).find((x) => x.id === r.message_id);
    expect(rec.kind).toBe('unsent');
    expect(rec.replay_until).toBeUndefined();
  });

  test('says so when a shelf life was set but nothing identifies the recipient', async () => {
    const { side } = ghostSide();
    const r = await tools(side).send_peer({
      peer: 'gone-session',
      message: 'x',
      replay_for_minutes: 30,
    });

    const rec: any = log.read({ last_n: 5 }).find((x) => x.id === r.message_id);
    expect(rec.to_id).toBeUndefined();
    expect(rec.replay_until).toBeUndefined();
    // Silent no-ops are the failure mode here: the sender believes the message
    // is waiting for someone, and it is not.
    expect(r.detail).toContain('expect_id');
  });
});

// The other half of #24: a returning session asks what it missed. Nothing can
// be pushed to it, so this is a filter on the log it can already read.
describe('message_log missed: what was left for this session', () => {
  const MINE = 'aaaaaaaa-0000-0000-0000-00000000mine';
  const from = { runtime: 'codex' as const, name: 'auth-refactor', cwd: '/src/auth' };
  const mineSide = (over: Partial<Side> = {}) =>
    makeSide({ selfDurableId: async () => ({ session_id: MINE }), ...over });

  const leave = (toId: string, minutesFromNow: number, text: string) =>
    log.appendUnsent(newId(), from, 'billing-api', 'peer_unknown', text, {
      until: new Date(Date.now() + minutesFromNow * 60_000).toISOString(),
      toId,
    });

  let n = 0;
  const newId = () => `msg_${(n++).toString().padStart(24, '0')}`;

  test('returns an attempt left for this session and still in date', async () => {
    leave(MINE, 30, 'the key rotated');
    const { side } = mineSide();
    const r = await tools(side).message_log({ missed: true });
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ kind: 'unsent', text: 'the key rotated' });
  });

  test('does not return one whose shelf life has passed', async () => {
    leave(MINE, -1, 'rebase onto main');
    const { side } = mineSide();
    expect((await tools(side).message_log({ missed: true })).records).toEqual([]);
  });

  test('does not return one left for a different session', async () => {
    leave('bbbbbbbb-0000-0000-0000-000000theirs', 30, 'not for you');
    const { side } = mineSide();
    expect((await tools(side).message_log({ missed: true })).records).toEqual([]);
  });

  test('does not return an attempt nobody asked to have replayed', async () => {
    log.appendUnsent(newId(), from, 'billing-api', 'peer_unknown', 'no shelf life');
    const { side } = mineSide();
    expect((await tools(side).message_log({ missed: true })).records).toEqual([]);
  });

  test('says why rather than returning a bare empty list when we have no durable id', async () => {
    leave(MINE, 30, 'the key rotated');
    const { side } = makeSide({ selfDurableId: async () => undefined });
    const r = await tools(side).message_log({ missed: true });
    expect(r.records).toEqual([]);
    expect(r.scope_note).toMatch(/durable id/i);
  });
});

// The `to` side carried a durable id only for Codex, because the envelope
// hardcoded `thread_id` instead of asking `durableIdOf` which key the
// recipient's runtime uses. Measured on a live log: Codex recipients had one on
// 202 of 202 records, Claude Code on 0 of 312 and opencode on 0 of 48 — so 64%
// of sends recorded who they went to by display name alone, which is the name
// that goes stale (#23) and the misdelivery `expect_id` exists to prevent.
describe('the recipient is identified durably', () => {
  const claudePeer = () =>
    peer({
      runtime: 'claude-code',
      rawName: 'billing-api',
      uuid: '5af69d42-2214-41d9-b13f-9c3177eb60ce',
      threadId: undefined,
    });

  test('writes a Claude Code recipient session_id into the log record', async () => {
    const { side } = makeSide({
      peerRuntimes: ['claude-code'],
      listPeers: async () => ({ peers: [claudePeer()] }),
    });
    const r = await tools(side).send_peer({ peer: 'billing-api', message: 'x' });

    const rec: any = log.read({ last_n: 5 }).find((x) => x.id === r.message_id);
    expect(rec.to.session_id).toBe('5af69d42-2214-41d9-b13f-9c3177eb60ce');
  });

  test('still writes a Codex recipient thread_id, under the key that runtime uses', async () => {
    const { side } = makeSide();
    const r = await tools(side).send_peer({ peer: 'auth-refactor', message: 'x' });

    const rec: any = log.read({ last_n: 5 }).find((x) => x.id === r.message_id);
    expect(rec.to.thread_id).toBe('00000000-0000-0000-0000-0000000007f3');
    expect(rec.to.session_id).toBeUndefined();
  });
});

// The stray ACK, reproduced. A reply carried in_reply_to for a message the
// recipient never sent, and Tin Can delivered it anyway — in_reply_to was an
// unvalidated string. The machine-global log already holds the original
// sender's own record, so the check costs a lookup.
describe('a reply must go to whoever sent the message', () => {
  // What the OTHER session's Tin Can wrote when it messaged us.
  const theirMessage = (over: { thread_id?: string; name?: string } = {}) =>
    log.appendMessage(
      buildEnvelope({
        id: 'msg_theirs',
        from: {
          runtime: 'codex',
          name: over.name ?? 'auth-refactor',
          cwd: '/src/auth',
          ...(over.thread_id !== undefined && { thread_id: over.thread_id }),
        },
        to: { runtime: 'claude-code', name: 'billing-api', cwd: '/src/billing' },
        method: 'inbox',
        expect_reply: false,
        reply_tool: true,
        text: 'challenge',
      }),
      true,
    );

  test('refuses a reply addressed to a session that did not send it', async () => {
    theirMessage();
    const { side, delivered } = makeSide({
      listPeers: async () => ({
        peers: [peer({ rawName: 'Docs pass', uuid: '00000000-0000-0000-0000-000000000abc', threadId: '00000000-0000-0000-0000-000000000abc' })],
      }),
    });
    const r = await createTools(side, log).send_peer({
      peer: 'docs-pass',
      message: 'ACK',
      in_reply_to: 'msg_theirs',
    });

    expect(r.outcome).toBe('rejected');
    expect(r.refusal).toBe('reply_misrouted');
    expect(r.detail).toContain('auth-refactor');
    expect(delivered).toHaveLength(0);
  });

  test('allows the reply when it goes to the original sender', async () => {
    theirMessage();
    const { side, delivered } = makeSide();
    const r = await createTools(side, log).send_peer({
      peer: 'auth-refactor',
      message: 'ACK',
      in_reply_to: 'msg_theirs',
    });
    expect(r.outcome).toBe('accepted');
    expect(delivered).toHaveLength(1);
  });

  // Matching on the durable id is the point of carrying it: the display name
  // is exactly what goes stale when a session is renamed.
  test('matches on the durable id, so a renamed sender is still replyable', async () => {
    theirMessage({ thread_id: '00000000-0000-0000-0000-0000000007f3', name: 'old-name' });
    const { side, delivered } = makeSide();
    const r = await createTools(side, log).send_peer({
      peer: 'auth-refactor',
      message: 'ACK',
      in_reply_to: 'msg_theirs',
    });
    expect(r.outcome).toBe('accepted');
    expect(delivered).toHaveLength(1);
  });

  // An envelope written by an older Tin Can is not in this log at all, and
  // refusing those would break every conversation in flight at upgrade.
  test('allows a reply it cannot check, rather than breaking older conversations', async () => {
    const { side, delivered } = makeSide();
    const r = await createTools(side, log).send_peer({
      peer: 'auth-refactor',
      message: 'ACK',
      in_reply_to: 'msg_from_before_the_upgrade',
    });
    expect(r.outcome).toBe('accepted');
    expect(delivered).toHaveLength(1);
  });

  test('a fan-out reply is fine as long as the original sender is one of the recipients', async () => {
    theirMessage();
    const { side, delivered } = makeSide({
      listPeers: async () => ({
        peers: [
          peer(),
          peer({ rawName: 'Docs pass', uuid: '00000000-0000-0000-0000-000000000abc', threadId: '00000000-0000-0000-0000-000000000abc' }),
        ],
      }),
    });
    const r: any = await createTools(side, log).send_peer({
      peers: ['auth-refactor', 'docs-pass'],
      message: 'ACK and FYI',
      in_reply_to: 'msg_theirs',
    });
    expect(r.accepted).toBe(2);
    expect(delivered).toHaveLength(2);
  });

  test('never suggests picking an arbitrary peer when a reply target cannot be found', async () => {
    theirMessage();
    const { side } = makeSide({
      listPeers: async () => ({
        peers: [peer({ rawName: 'Docs pass', uuid: '00000000-0000-0000-0000-000000000abc', threadId: '00000000-0000-0000-0000-000000000abc' })],
      }),
    });
    const r = await createTools(side, log).send_peer({
      peer: 'auth-refactor',
      message: 'ACK',
      in_reply_to: 'msg_theirs',
    });

    expect(r.refusal).toBe('peer_unknown');
    expect(r.detail).toMatch(/do not send it to a different/i);
    // The full listing as `candidates` is what invited the wrong pick.
    expect(r.candidates ?? []).not.toContain('docs-pass');
  });
});

// One boolean answered four different questions. `outcome` names which of
// them happened, because the caller's correct next move differs: rejected
// means you did something wrong and should fix it, failed means the peer or
// transport did and retrying later may work.
describe('outcome replaces delivered', () => {
  test('accepted when the harness takes it', async () => {
    const { side } = makeSide();
    const r = await createTools(side, log).send_peer({ peer: 'auth-refactor', message: 'x' });
    expect(r.outcome).toBe('accepted');
    expect(r).not.toHaveProperty('delivered');
  });

  test('rejected when we refuse before sending', async () => {
    const { side, delivered } = makeSide();
    const tools = createTools(side, log);
    const unknown = await tools.send_peer({ peer: 'nobody-here', message: 'x' });
    expect(unknown.outcome).toBe('rejected');
    expect(unknown.refusal).toBe('peer_unknown');

    await tools.send_peer({ peer: 'auth-refactor', message: 'same' });
    const repeat = await tools.send_peer({ peer: 'auth-refactor', message: 'same' });
    expect(repeat.outcome).toBe('rejected');
    expect(repeat.refusal).toBe('identical_repeat');
    expect(delivered).toHaveLength(1);
  });

  test('failed when we tried and the transport did not take it', async () => {
    const { side } = makeSide({ deliver: async () => ({ delivered: false, error: 'socket closed', method: 'thread/queue/add' as const }) });
    const r = await createTools(side, log).send_peer({ peer: 'auth-refactor', message: 'x' });
    expect(r.outcome).toBe('failed');
    expect(r.refusal).toBe('delivery_failed');
  });

  test('a fan-out counts instead of overloading one field', async () => {
    let n = 0;
    const { side } = makeSide({
      listPeers: async () => ({
        peers: [
          peer(),
          peer({ rawName: 'Docs pass', uuid: '00000000-0000-0000-0000-000000000abc', threadId: '00000000-0000-0000-0000-000000000abc' }),
        ],
      }),
      deliver: async () => {
        n += 1;
        return n === 2 ? { delivered: false, error: 'gone', method: 'thread/queue/add' as const } : { delivered: true, method: 'thread/queue/add' as const };
      },
    });
    const r: any = await createTools(side, log).send_peer({
      peers: ['auth-refactor', 'docs-pass'],
      message: 'x',
    });

    expect(r.requested).toBe(2);
    expect(r.accepted).toBe(1);
    expect(r).not.toHaveProperty('delivered');
    expect(r.results.map((x: any) => x.outcome)).toEqual(['accepted', 'failed']);
  });
});

// One machine-global log meant any session could read every conversation on
// the machine, including projects it had nothing to do with. Defensible under
// one OS user; still more than a caller asking "what have I been told" wants,
// and it is the local half of a problem that stops being local at all once
// peers are on other machines.
describe('message_log is scoped to this project', () => {
  const elsewhere = (id: string) =>
    log.appendMessage(
      buildEnvelope({
        id,
        from: { runtime: 'codex', name: 'other-a', cwd: '/src/unrelated' },
        to: { runtime: 'codex', name: 'other-b', cwd: '/src/unrelated' },
        method: 'thread/queue/add',
        expect_reply: false,
        reply_tool: true,
        text: 'not our business',
      }),
      true,
    );

  test('hides a conversation between two sessions in another project', async () => {
    elsewhere('msg_elsewhere');
    const { side } = makeSide();
    const r = await createTools(side, log).message_log({ last_n: 20 });
    expect(r.records.map((x) => x.id)).not.toContain('msg_elsewhere');
  });

  test('keeps a message where either end is this project', async () => {
    const { side } = makeSide();
    const tools = createTools(side, log);
    const sent = await tools.send_peer({ peer: 'auth-refactor', message: 'ours' });
    const r = await tools.message_log({ last_n: 20 });
    expect(r.records.map((x) => x.id)).toContain(sent.message_id);
  });

  test('all_projects returns the whole machine, for when that is what you want', async () => {
    elsewhere('msg_elsewhere');
    const { side } = makeSide();
    const r = await createTools(side, log).message_log({ last_n: 20, all_projects: true });
    expect(r.records.map((x) => x.id)).toContain('msg_elsewhere');
  });

  // Silence would be the worst outcome: a session whose cwd does not match
  // what was recorded — a symlinked path, a moved checkout — would see an
  // empty log and conclude nothing had ever been sent.
  test('says so when scoping is what emptied the result', async () => {
    elsewhere('msg_elsewhere');
    const { side } = makeSide();
    const r = await createTools(side, log).message_log({ last_n: 20 });
    expect(r.records).toHaveLength(0);
    expect(r.scope_note).toMatch(/all_projects/);
  });
});

// #23/#24. A send that is refused before delivery wrote NOTHING to the log:
// `peer_unknown`, `peer_unreachable` and `peer_changed` all return before
// `appendMessage`, and only guard refusals wrote anything at all. So a session
// that was down while someone tried to reach it found no evidence anyone had
// — not because it had caught up, but because nothing was ever written.
//
// That is the prerequisite #24 turns on: a returning session cannot read a
// backlog that was never recorded. It is worth having on its own, because
// "someone tried to reach me and could not" was invisible to everyone except
// the sender's own turn.
describe('an attempt that never became a send is still recorded', () => {
  test('records a send to an unreachable peer, with who it was for and why it failed', async () => {
    const { side } = makeSide({
      listPeers: async () => ({ peers: [peer({ state: 'unreachable' })] }),
    });
    const r = await tools(side).send_peer({ peer: 'auth-refactor', message: 'are you there?' });
    expect(r.outcome).toBe('rejected');
    expect(r.refusal).toBe('peer_unreachable');

    const [rec] = log.read({ last_n: 10 });
    expect(rec).toMatchObject({
      kind: 'unsent',
      reason: 'peer_unreachable',
      to_address: 'auth-refactor',
      text: 'are you there?',
    });
  });

  test('records a send to a name that resolves to nobody', async () => {
    const { side } = makeSide({ listPeers: async () => ({ peers: [] }) });
    const r = await tools(side).send_peer({ peer: 'ghost', message: 'hello?' });
    expect(r.refusal).toBe('peer_unknown');
    expect(log.read({ last_n: 10 })[0]).toMatchObject({ kind: 'unsent', to_address: 'ghost' });
  });

  // The point of recording it is being able to FIND it. The peer filter only
  // matched messages, so an attempt to a peer was invisible to the one query a
  // returning session would run.
  test('the peer filter finds attempts, not just delivered messages', async () => {
    const { side } = makeSide({
      listPeers: async () => ({ peers: [peer({ state: 'unreachable' })] }),
    });
    await tools(side).send_peer({ peer: 'auth-refactor', message: 'are you there?' });
    const found = log.read({ last_n: 10, peer: 'auth-refactor' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'unsent' });
  });

  // A self-send is a caller mistake, not a missed message. Recording it would
  // put noise in the one place a returning session looks.
  test('does not record a self-send', async () => {
    const { side } = makeSide({ selfName: async () => 'auth-service' });
    const r = await tools(side).send_peer({ peer: 'auth-service', message: 'hi me' });
    expect(r.refusal).toBe('self_send');
    expect(log.read({ last_n: 10 })).toHaveLength(0);
  });
});

// #32, the caller-facing half. `state` keeps its safe default so nothing that
// switches on it changes behaviour; the flag rides alongside so a caller can
// tell a peer that is genuinely mid-turn from one whose status Tin Can could
// not read.
describe('a peer whose published status could not be read', () => {
  test('is reported busy, and says the state is a default rather than a reading', async () => {
    const { side } = makeSide({
      listPeers: async () => ({ peers: [peer({ state: 'busy', statusUnreadable: true })] }),
    });
    const r = await tools(side).peers();
    expect(r.peers[0]).toMatchObject({ state: 'busy', status_unreadable: true });
  });

  test('says nothing at all when the status was understood', async () => {
    const { side } = makeSide({ listPeers: async () => ({ peers: [peer({ state: 'busy' })] }) });
    const r = await tools(side).peers();
    expect(r.peers[0]).not.toHaveProperty('status_unreadable');
  });
});

/**
 * Reporting the version (#-, from a live intake failure).
 *
 * A session could not answer "which tincan is running here" from its tools at
 * all: `peers`, `send_peer` and `message_log` carried no version, and the
 * three places VERSION did reach — MCP serverInfo, `--version`, the stderr
 * startup line — are none of them readable by the model inside the session.
 * The workaround, shelling out to `tincan --version`, answers a DIFFERENT
 * question: it reports whatever is on PATH, not the build this server started
 * with, and on this repo HEAD routinely runs ahead of the installed CLI.
 *
 * The peer half costs nothing to add: every Claude Code session already
 * writes `tincanVersion` into its pointer record, and `readPointers` already
 * parses it back. It was read and then dropped.
 */
describe('peers reports which tincan is running', () => {
  test('reports the version of the tincan serving this call', async () => {
    const { side } = makeSide();
    const r = await tools(side).peers();
    expect(r.tincan_version).toBe(VERSION);
  });

  test("reports a peer's own version, from the pointer record it wrote", async () => {
    const { side } = makeSide({
      listPeers: async () => ({ peers: [peer({ tincanVersion: '1.7.0' })] }),
    });
    const r = await tools(side).peers();
    expect(r.peers[0]).toMatchObject({ tincan_version: '1.7.0' });
  });

  /**
   * Absent, not "unknown". A peer that wrote no pointer record — a Codex or
   * opencode session, or a Claude session running no Tin Can — has no version
   * to report, and inventing a string for it would make "we did not look" and
   * "it told us nothing" read identically.
   */
  test('omits the field entirely for a peer whose version is unknown', async () => {
    const { side } = makeSide();
    const r = await tools(side).peers();
    expect(r.peers[0]).not.toHaveProperty('tincan_version');
  });
});

/**
 * The manual lever, for when the automatic one is not trusted or not enough.
 *
 * It exists because the failure it repairs is invisible from inside the
 * session it happens to: the session is told by an arriving envelope that it
 * has no way to answer, and has no other signal that anything is wrong.
 */
describe('reregister', () => {
  test('repairs the registration and says which id it now holds', async () => {
    const { side } = makeSide({
      reregister: async () => ({
        registered: true,
        session_id: 'sid-now',
        name: 'billing-api',
        tincan_version: VERSION,
        previous_session_id: 'sid-boot',
        detail: 'repaired',
      }),
    });
    const r = await tools(side).reregister();
    expect(r).toMatchObject({
      registered: true,
      session_id: 'sid-now',
      previous_session_id: 'sid-boot',
    });
  });

  /**
   * Honest rather than absent on the other two runtimes. A tool that silently
   * does nothing is worse than one that says there was nothing to do.
   */
  test('says plainly that there is nothing to register on a runtime that does not', async () => {
    const { side } = makeSide();
    const r = await tools(side).reregister();
    expect(r.registered).toBe(false);
    expect(r.tincan_version).toBe(VERSION);
    expect(r.detail.toLowerCase()).toContain('claude code');
  });
});
