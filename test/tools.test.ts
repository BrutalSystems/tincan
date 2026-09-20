import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
    resolveSelf: async () => ({ sessionId: undefined }),
    selfName: async () => 'billing-api',
    selfCwd: '/src/billing',
    peerRuntimes: ['codex'],
    limitsFor: (r: 'codex' | 'claude-code') => (r === 'codex' ? CODEX_LIMITS : CLAUDE_LIMITS),
    listPeers: async () => ({ peers: [peer()] }),
    deliver: async (_self, _p, _e, text) => {
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

  test('emits no urgent note when every listed peer runtime can be steered', async () => {
    // An opencode host, not the default Claude Code one: this asserts the
    // note array is *empty*, so the side must also be one that lists its own
    // kind and therefore earns no scope note either.
    const { side } = makeSide({
      selfRuntime: 'opencode',
      peerRuntimes: ['opencode'],
      listPeers: async () => ({ peers: [peer({ runtime: 'opencode', socketPath: '/tmp/x.sock' })] }),
    });
    const r = await tools(side).peers();
    expect(r.notes ?? []).toEqual([]);
  });

  test('says the host’s own kind is missing from the list', async () => {
    // The Claude Code host lists Codex and opencode only. Nothing in the rows
    // says so, so a model reports a three-row list as the whole machine.
    const { side } = makeSide({ peerRuntimes: ['codex', 'opencode'] });
    const r = await tools(side).peers();
    const scope = (r.notes ?? []).join(' ');
    expect(scope).toContain('Claude Code');
    expect(scope).toContain('SendMessage');
    // The human label everywhere, as with the urgent note above.
    expect(scope).not.toContain('claude-code');
  });

  test('says so even when no peers are listed at all', async () => {
    // The case that misleads most: an empty list plus no explanation reads as
    // "nothing is running", when a dozen Claude Code sessions may be.
    const { side } = makeSide({
      peerRuntimes: ['codex', 'opencode'],
      listPeers: async () => ({ peers: [] }),
    });
    const r = await tools(side).peers();
    expect((r.notes ?? []).join(' ')).toContain('SendMessage');
  });

  test('emits no scope note on a side that lists its own kind', async () => {
    const { side } = makeSide({
      selfRuntime: 'codex',
      peerRuntimes: ['codex', 'claude-code', 'opencode'],
    });
    const r = await tools(side).peers();
    expect((r.notes ?? []).join(' ')).not.toContain('SendMessage');
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
        deliver: async (_self, _p, _e, _t, urgent) => {
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
      deliver: async (_self, _p, _e, _t, urgent) => {
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

  test('logs delivery:"queue" for a normal send', async () => {
    const { side } = makeSide();
    await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi' });
    expect(log.read({ last_n: 1 })[0]).toMatchObject({ delivery: 'queue' });
  });

  test('logs delivery:"steer" for an urgent send to a peer that can act on it', async () => {
    const { side } = makeSide({
      listPeers: async () => ({ peers: [peer({ runtime: 'opencode', socketPath: '/tmp/x.sock' })] }),
      deliver: async () => ({ delivered: true, method: 'opencode/prompt' as const }),
    });
    await tools(side).send_peer({ peer: 'auth-refactor', message: 'hi', urgent: true });
    expect(log.read({ last_n: 1 })[0]).toMatchObject({ delivery: 'steer' });
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

describe('opencode admission is not execution', () => {
  // Reproduced 2026-09-20 against opencode 1.18.31, then corrected by reading
  // opencode's own log: a turn IS scheduled, 68ms after admission, even on an
  // idle session. What failed was the turn — ModelUnavailableError — and that
  // failure reached nobody: the POST had already returned 200, the session got
  // no error message, and the only trace was one ERROR line in a log file.
  // Tin Can sees even less: client.ts never reads a response, so `delivered`
  // means "the plugin accepted the line", nothing more. Hence a notice on
  // every opencode send, not a claim about scheduling.
  const ocPeer = (state: 'idle' | 'busy') =>
    peer({ runtime: 'opencode', rawName: 'witty-orchid', socketPath: '/tmp/x.sock', state, threadId: undefined });

  const sendTo = async (state: 'idle' | 'busy') => {
    const { side } = makeSide({
      selfRuntime: 'claude-code',
      peerRuntimes: ['codex', 'opencode'],
      listPeers: async () => ({ peers: [ocPeer(state)] }),
      deliver: async () => ({ delivered: true, method: 'opencode/prompt' as const }),
    });
    return tools(side).send_peer({ peer: 'witty-orchid', message: 'hello' });
  };

  test('warns that Tin Can cannot confirm an opencode peer acted on it', async () => {
    const r = await sendTo('idle');
    expect(r.delivered).toBe(true);
    expect(r.notice).toMatch(/cannot confirm/i);
  });

  test('names the TUI-hosted failure and the served contrast', async () => {
    // Isolated by the Muster session on stock 1.18.31, no muster involved:
    // same session, same model string, 24s apart — a turn started in the TUI
    // streams fine, a drain from an admitted prompt cannot resolve the model.
    // Corroborated here by 17 drain failures across a different provider.
    const n = (await sendTo('idle')).notice!;
    expect(n).toMatch(/TUI/);
    expect(n).toMatch(/opencode serve/);
  });

  test('does not overclaim: Tin Can cannot tell which kind of host this is', async () => {
    // Third revision of this text. "Will not run" would be wrong for a served
    // peer, and Tin Can has no signal that distinguishes one from the other.
    const n = (await sendTo('idle')).notice!;
    expect(n).toMatch(/cannot tell|cannot confirm/i);
  });

  test('does not claim the turn was never scheduled — it is', async () => {
    // The mechanism 0.5.7 asserted was wrong. opencode schedules on
    // admission; the turn can then fail silently. Saying otherwise taught
    // readers a false model of the system.
    const r = await sendTo('idle');
    expect(r.notice).not.toMatch(/not schedul|never schedul|no agent turn/i);
  });

  test('still reports delivered — the plugin did accept it', async () => {
    // Not a failure: the message is durably admitted and a human opening that
    // session sees it. Calling this delivered:false would be as wrong as
    // calling it silently fine.
    expect((await sendTo('idle')).delivered).toBe(true);
    expect((await sendTo('idle')).refusal).toBeUndefined();
  });

  test('warns for a busy opencode peer too', async () => {
    // 0.5.7 exempted busy peers, on the theory that idle ones were never
    // scheduled. Both are scheduled; neither can be confirmed. The state was
    // never the thing that mattered.
    expect((await sendTo('busy')).notice).toMatch(/cannot confirm/i);
  });

  test('does not warn for Codex or Claude Code peers', async () => {
    // Their queue and inbox both genuinely run the message.
    for (const runtime of ['codex', 'claude-code'] as const) {
      const { side } = makeSide({
        selfRuntime: 'opencode',
        peerRuntimes: ['codex', 'claude-code'],
        listPeers: async () => ({
          peers: [peer({ runtime, rawName: 'other', state: 'idle', ...(runtime === 'claude-code' ? { threadId: undefined } : {}) })],
        }),
      });
      const r = await tools(side).send_peer({ peer: 'other', message: 'hello' });
      expect(r.notice).toBeUndefined();
    }
  });

  test('records the caveat in the message log, not only in the tool result', async () => {
    // A log line reading "delivered" with no detail, beside a tool result
    // that hedges, is the drift this codebase keeps closing. Before the fix
    // the log took outcome.notice, which is undefined on this path.
    const { side } = makeSide({
      peerRuntimes: ['codex', 'opencode'],
      listPeers: async () => ({ peers: [ocPeer('idle')] }),
      deliver: async () => ({ delivered: true, method: 'opencode/prompt' as const }),
    });
    await tools(side).send_peer({ peer: 'witty-orchid', message: 'hello' });
    // read() folds the outcome onto the sent record as `notice`.
    const records = log.read({ last_n: 10 }) as Array<{ delivered?: boolean; notice?: string }>;
    const rec = records.at(-1);
    expect(rec?.delivered).toBe(true);
    expect(rec?.notice).toMatch(/cannot confirm/i);
  });

  test('does not clobber a notice the delivery itself produced', async () => {
    const { side } = makeSide({
      peerRuntimes: ['codex', 'opencode'],
      listPeers: async () => ({ peers: [ocPeer('idle')] }),
      deliver: async () => ({ delivered: true, method: 'opencode/prompt' as const, notice: 'held by the peer' }),
    });
    const r = await tools(side).send_peer({ peer: 'witty-orchid', message: 'hello' });
    expect(r.notice).toContain('held by the peer');
    expect(r.notice).toMatch(/cannot confirm/i);
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
