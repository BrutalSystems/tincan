import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageLog } from '../src/log.js';
import { CODEX_LIMITS, CLAUDE_LIMITS } from '../src/guard.js';
import { createTools, labelList, type Side, type SidePeer } from '../src/tools.js';

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
    ownKindScope: 'cross-config-dir',
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
      ownKindScope: 'included',
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
   * A Claude Code host lists Claude sessions ONLY from other CLAUDE_CONFIG_DIRs
   * — same-account ones are reached natively by SendMessage — and it carries no
   * session id of its own (`resolveSelf` answers NO_SESSION), so `isSelfAddress`
   * can only compare NAMES. `selfNameFor` falls back to `basename(cwd)` when
   * CLAUDE_CODE_SESSION_ID is absent or the registry lookup misses.
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
    expect(r.delivered).toBe(false);
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

    expect(r.delivered).toBe(true);
    expect(delivered).toHaveLength(1);
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
      expect(r.delivered).toBe(false);
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
    expect(r.delivered).toBe(true);
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
    expect(r.records[0]).toMatchObject({ text: 'hi there', direction: 'out', delivered: true });
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

test('the peers note names SendMessage as the path to same-account sessions', async () => {
  const { side } = makeSide({ listPeers: async () => ({ peers: [] }) });
  const result = await tools(side).peers();
  expect(result.notes?.join(' ')).toContain('SendMessage');
  expect(result.notes?.join(' ')).toContain('CLAUDE_CONFIG_DIR');
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
