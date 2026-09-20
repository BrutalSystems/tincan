import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRuntime, selfNameFor, buildSide, codexSelfNameOf, makeSelfNameResolver } from '../src/runtime.js';
import { CLAUDE_LIMITS, CODEX_LIMITS } from '../src/guard.js';
import { createTools } from '../src/tools.js';
import { MessageLog } from '../src/log.js';
import { fakeInbox, fakeOpencodeInstance } from './fakes.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tincan-rt-'));
  mkdirSync(join(dir, 'sessions'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('detectRuntime', () => {
  test('is claude-code when the messaging socket is in the environment', () => {
    expect(detectRuntime({ CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock' })).toBe(
      'claude-code',
    );
  });

  test('assumes codex otherwise', () => {
    expect(detectRuntime({})).toBe('codex');
  });
});

describe('selfNameFor', () => {
  test('uses the hosting Claude session name from the registry', () => {
    writeFileSync(
      join(dir, 'sessions', '4242.json'),
      JSON.stringify({ pid: 4242, name: 'billing-api', cwd: '/src/billing' }),
    );
    expect(selfNameFor('claude-code', { registryDir: join(dir, 'sessions'), pid: 4242, cwd: '/src/billing' })).toBe(
      'billing-api',
    );
  });

  test('finds the hosting session by CLAUDE_CODE_SESSION_ID, since the MCP server is a child process', () => {
    writeFileSync(
      join(dir, 'sessions', '4242.json'),
      JSON.stringify({
        pid: 4242,
        sessionId: '5af69d42-2214-41d9-b13f-9c3177eb60ce',
        name: 'billing-api',
        cwd: '/src/billing',
      }),
    );
    const name = selfNameFor('claude-code', {
      registryDir: join(dir, 'sessions'),
      pid: 99999,
      cwd: '/src/billing',
      env: { CLAUDE_CODE_SESSION_ID: '5af69d42-2214-41d9-b13f-9c3177eb60ce' },
    });
    expect(name).toBe('billing-api');
  });

  test('falls back to the working directory name when no registry entry exists', () => {
    expect(selfNameFor('codex', { registryDir: join(dir, 'sessions'), pid: 1, cwd: '/src/auth-service' })).toBe(
      'auth-service',
    );
  });
});

describe('self-name resolution timing', () => {
  test('a directory fallback is not cached, so a later lookup can still find the real name', async () => {
    // A Codex thread has no title until its first turn, but the MCP server
    // starts before that and resolves selfName for its startup diagnostic.
    // Caching that fallback left the session calling itself by its directory
    // for the rest of its life.
    let titled = false;
    const resolve = async () => (titled ? 'respond-to-greeting' : undefined);
    const cached = makeSelfNameResolver(resolve, '/Users/mike/Source/brutalsystems/tincan');

    expect(await cached()).toBe('tincan'); // before the first turn
    titled = true;
    expect(await cached()).toBe('respond-to-greeting'); // after it
  });

  test('a real name is cached, so the protocol call happens once', async () => {
    let calls = 0;
    const resolve = async () => {
      calls++;
      return 'auth-refactor';
    };
    const cached = makeSelfNameResolver(resolve, '/src/x');
    await cached();
    await cached();
    expect(calls).toBe(1);
  });
});

describe('codexSelfNameOf', () => {
  test('slugifies the thread title, so `from=` matches what a peer must type to reply', () => {
    expect(codexSelfNameOf('Respond to greeting', '/src/x')).toBe('respond-to-greeting');
  });

  test('falls back to the directory name when the thread has no title', () => {
    expect(codexSelfNameOf(null, '/Users/mike/Source/brutalsystems')).toBe('brutalsystems');
  });
});

describe('buildSide', () => {
  test('hosted in Claude Code, it exposes Codex and opencode peers', () => {
    // Claude Code reaches its own sessions natively via SendMessage, so its
    // own kind is the only runtime excluded.
    const side = buildSide('claude-code', { registryDir: join(dir, 'sessions'), pid: 1, cwd: '/src/x' });
    expect(side.selfRuntime).toBe('claude-code');
    expect(side.peerRuntimes).toEqual(['codex', 'opencode']);
  });

  test('honours TINCAN_HOME when discovering opencode peers, matching the plugin', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tincan-oc-home-'));
    try {
      const registryDir = join(home, 'peers', 'opencode');
      mkdirSync(registryDir, { recursive: true });
      const inbox = await fakeInbox();
      try {
        writeFileSync(
          join(registryDir, 'ses_a.json'),
          JSON.stringify({
            session_id: 'ses_a',
            slug: 'nimble-wizard',
            directory: '/repo',
            state: 'idle',
            socket: inbox.path,
            instance_id: 'inst-a91f',
            pid: 4242,
          }),
        );
        const side = buildSide('claude-code', {
          registryDir: join(dir, 'sessions'),
          pid: 1,
          cwd: '/src/x',
          env: { TINCAN_HOME: home },
        });
        const { peers } = await side.listPeers(await side.resolveSelf());
        expect(peers).toContainEqual(
          expect.objectContaining({ runtime: 'opencode', uuid: 'ses_a', rawName: 'nimble-wizard' }),
        );
      } finally {
        await inbox.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test(
    'the urgent flag reaches the opencode wire as delivery:"steer"/"queue" — the exact seam ' +
      'where an arrow with a dropped parameter would type-check but silently always queue',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'tincan-oc-home2-'));
      try {
        const registryDir = join(home, 'peers', 'opencode');
        mkdirSync(registryDir, { recursive: true });
        const instance = await fakeOpencodeInstance();
        try {
          writeFileSync(
            join(registryDir, 'ses_b.json'),
            JSON.stringify({
              session_id: 'ses_b',
              slug: 'nimble-wizard',
              directory: '/repo',
              state: 'idle',
              socket: instance.path,
              instance_id: 'inst-b91f',
              pid: 4242,
            }),
          );
          const side = buildSide('claude-code', {
            registryDir: join(dir, 'sessions'),
            pid: 1,
            cwd: '/src/x',
            env: { TINCAN_HOME: home },
          });
          // One SelfRef for the whole "call", exactly as createTools does.
          const self = await side.resolveSelf();
          const { peers } = await side.listPeers(self);
          const ocPeer = peers.find((p) => p.runtime === 'opencode')!;

          await side.deliver(self, ocPeer, 'msg_urgent', 'hi urgent', true);
          await side.deliver(self, ocPeer, 'msg_queued', 'hi queued', false);

          expect(instance.rawLines.map((l) => JSON.parse(l).delivery)).toEqual(['steer', 'queue']);
        } finally {
          await instance.close();
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test('hosted in Codex, it exposes all three runtimes', () => {
    // Codex's collaboration tools only reach its own spawn tree, so it has no
    // native path to an independent Codex session, a Claude one, or an
    // opencode one — matching change notice §4's table.
    const side = buildSide('codex', { registryDir: join(dir, 'sessions'), pid: 1, cwd: '/src/x' });
    expect(side.peerRuntimes).toEqual(['codex', 'claude-code', 'opencode']);
  });

  test('hosted in Codex, a live opencode session appears in listPeers (change notice §9 row 2)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tincan-oc-codex-'));
    try {
      const registryDir = join(home, 'peers', 'opencode');
      mkdirSync(registryDir, { recursive: true });
      const inbox = await fakeInbox();
      try {
        writeFileSync(
          join(registryDir, 'ses_a.json'),
          JSON.stringify({
            session_id: 'ses_a',
            slug: 'nimble-wizard',
            directory: '/repo',
            state: 'idle',
            socket: inbox.path,
            instance_id: 'inst-a91f',
            pid: 4242,
          }),
        );
        const side = buildSide('codex', {
          registryDir: join(dir, 'sessions'),
          pid: 1,
          cwd: '/src/x',
          env: { TINCAN_HOME: home },
        });
        const { peers } = await side.listPeers(await side.resolveSelf());
        expect(peers).toContainEqual(
          expect.objectContaining({ runtime: 'opencode', uuid: 'ses_a', rawName: 'nimble-wizard' }),
        );
      } finally {
        await inbox.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('budgets are per peer runtime, so Codex stays tighter in a mixed listing', () => {
    const side = buildSide('codex', { registryDir: join(dir, 'sessions'), pid: 1, cwd: '/src/x' });
    expect(side.limitsFor('codex')).toBe(CODEX_LIMITS);
    expect(side.limitsFor('claude-code')).toBe(CLAUDE_LIMITS);
  });

  test('resolves its own name lazily, since the Codex side must derive it at runtime', async () => {
    const side = buildSide('claude-code', { registryDir: join(dir, 'sessions'), pid: 1, cwd: '/src/auth-service' });
    expect(typeof side.selfName).toBe('function');
    expect(await side.selfName(await side.resolveSelf())).toBe('auth-service');
  });

  test('reports urgent as supported wherever opencode is among the peer runtimes', () => {
    // claude-code and codex hosted both list opencode peers, which opencode's
    // own wire format can steer (delivery: "steer").
    expect(
      buildSide('claude-code', { registryDir: join(dir, 'sessions'), pid: 1, cwd: '/src/x' }).supportsUrgent,
    ).toBe(true);
    expect(
      buildSide('codex', { registryDir: join(dir, 'sessions'), pid: 1, cwd: '/src/x' }).supportsUrgent,
    ).toBe(true);
  });
});

describe('buildSide, hosted in opencode', () => {
  let home: string;
  let registryDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tincan-oc-self-'));
    registryDir = join(home, 'peers', 'opencode');
    mkdirSync(registryDir, { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  // Two sessions of the SAME opencode instance (same socket, same pid), the
  // real shape the change notice describes: "one instance commonly runs
  // several sessions in the same directory."
  async function writeInstance(instance: Awaited<ReturnType<typeof fakeOpencodeInstance>>) {
    writeFileSync(
      join(registryDir, 'ses_self.json'),
      JSON.stringify({
        session_id: 'ses_self',
        slug: 'nimble-wizard',
        directory: '/repo',
        state: 'idle',
        socket: instance.path,
        instance_id: 'inst-a91f',
        pid: 41233,
      }),
    );
    writeFileSync(
      join(registryDir, 'ses_sibling.json'),
      JSON.stringify({
        session_id: 'ses_sibling',
        slug: 'proud-forest',
        directory: '/repo',
        state: 'idle',
        socket: instance.path,
        instance_id: 'inst-a91f',
        pid: 41233,
      }),
    );
  }

  test('exposes all three runtimes, unlike the Claude Code host', () => {
    const side = buildSide('opencode', {
      registryDir: join(dir, 'sessions'),
      pid: 1,
      cwd: '/src/x',
      env: { OPENCODE_PID: '41233' },
    });
    expect(side.peerRuntimes).toEqual(['codex', 'claude-code', 'opencode']);
  });

  test(
    'caller file present: excludes exactly our own session, and a sibling session in the ' +
      'same instance stays addressable — the entire reason the caller file exists rather ' +
      'than just excluding by OPENCODE_PID',
    async () => {
      const instance = await fakeOpencodeInstance();
      try {
        await writeInstance(instance);
        writeFileSync(
          join(registryDir, 'inst-a91f.caller.json'),
          JSON.stringify({
            instance_id: 'inst-a91f',
            session_id: 'ses_self',
            pid: 41233,
            tool: 'tincan_send_peer',
            at: '2026-09-19T14:02:11Z',
          }),
        );
        const side = buildSide('opencode', {
          registryDir: join(dir, 'sessions'),
          pid: 1,
          cwd: '/src/x',
          env: { TINCAN_HOME: home, OPENCODE_PID: '41233' },
        });
        const { peers } = await side.listPeers(await side.resolveSelf());
        const uuids = peers.filter((p) => p.runtime === 'opencode').map((p) => p.uuid);
        expect(uuids).not.toContain('ses_self');
        expect(uuids).toContain('ses_sibling');
      } finally {
        await instance.close();
      }
    },
  );

  test(
    'caller file absent: falls back to excluding every session of our own instance, ' +
      'including the sibling — over-excluding is safe, under-excluding is not',
    async () => {
      const instance = await fakeOpencodeInstance();
      try {
        await writeInstance(instance);
        // Deliberately no inst-a91f.caller.json.
        const side = buildSide('opencode', {
          registryDir: join(dir, 'sessions'),
          pid: 1,
          cwd: '/src/x',
          env: { TINCAN_HOME: home, OPENCODE_PID: '41233' },
        });
        const { peers } = await side.listPeers(await side.resolveSelf());
        const uuids = peers.filter((p) => p.runtime === 'opencode').map((p) => p.uuid);
        expect(uuids).not.toContain('ses_self');
        expect(uuids).not.toContain('ses_sibling');
      } finally {
        await instance.close();
      }
    },
  );

  test(
    'OPENCODE_PID missing or unparseable: excludes every opencode session, since there is ' +
      'no pid to key even the instance-level fallback on',
    async () => {
      const instance = await fakeOpencodeInstance();
      try {
        await writeInstance(instance);
        // No caller file, and no usable OPENCODE_PID either.
        const side = buildSide('opencode', {
          registryDir: join(dir, 'sessions'),
          pid: 1,
          cwd: '/src/x',
          env: { TINCAN_HOME: home, OPENCODE: '1' },
        });
        const { peers } = await side.listPeers(await side.resolveSelf());
        expect(peers.filter((p) => p.runtime === 'opencode')).toEqual([]);
      } finally {
        await instance.close();
      }
    },
  );

  test(
    'OPENCODE_PID as an empty string: excludes our own session (and every sibling) rather ' +
      "than treating it as pid 0 — Number('') is 0, and Number.isInteger(0) is true, so a " +
      'naive check alone would let our own session through as an ordinary, addressable peer',
    async () => {
      const instance = await fakeOpencodeInstance();
      const logDir = mkdtempSync(join(tmpdir(), 'tincan-oc-emptypid-'));
      try {
        await writeInstance(instance);
        // Deliberately no caller file: this exercises the instance-level
        // fallback (tier 2), which is exactly where the naive
        // Number.isInteger(0) === true guard let a real session's pid
        // (41233) compare unequal to a bogus "self" pid of 0 and stay listed.
        const side = buildSide('opencode', {
          registryDir: join(dir, 'sessions'),
          pid: 1,
          cwd: '/src/x',
          env: { TINCAN_HOME: home, OPENCODE_PID: '' },
        });

        const { peers } = await side.listPeers(await side.resolveSelf());
        const uuids = peers.filter((p) => p.runtime === 'opencode').map((p) => p.uuid);
        expect(uuids).not.toContain('ses_self');
        expect(uuids).not.toContain('ses_sibling');

        // Our own slug is gone from the list entirely, so a self-send by
        // that slug must never resolve to a deliverable peer.
        const log = new MessageLog(join(logDir, 'messages.jsonl'));
        const r = await createTools(side, log).send_peer({ peer: 'nimble-wizard', message: 'hi' });
        expect(r.delivered).toBe(false);
        expect(r.refusal).toBe('peer_unknown');
      } finally {
        await instance.close();
        rmSync(logDir, { recursive: true, force: true });
      }
    },
  );

  test('selfName() resolves our own slug from ses_*.json, not the cwd basename', async () => {
    const instance = await fakeOpencodeInstance();
    try {
      await writeInstance(instance);
      writeFileSync(
        join(registryDir, 'inst-a91f.caller.json'),
        JSON.stringify({
          instance_id: 'inst-a91f',
          session_id: 'ses_self',
          pid: 41233,
          tool: 'tincan_send_peer',
          at: '2026-09-19T14:02:11Z',
        }),
      );
      const side = buildSide('opencode', {
        registryDir: join(dir, 'sessions'),
        pid: 1,
        cwd: '/src/some-other-directory-name',
        env: { TINCAN_HOME: home, OPENCODE_PID: '41233' },
      });
      expect(await side.selfName(await side.resolveSelf())).toBe('nimble-wizard');
    } finally {
      await instance.close();
    }
  });

  test(
    'resolves self exactly once per tool call: the envelope from= and the wire ' +
      'message_from name the same session even when every read of the caller file ' +
      'answers differently (the change notice §4 race, in its sharpest form)',
    async () => {
      const instance = await fakeOpencodeInstance();
      const logDir = mkdtempSync(join(tmpdir(), 'tincan-oc-once-'));
      try {
        await writeInstance(instance); // ses_self / nimble-wizard, ses_sibling / proud-forest
        writeFileSync(
          join(registryDir, 'ses_target.json'),
          JSON.stringify({
            session_id: 'ses_target',
            slug: 'target-session',
            directory: '/repo',
            state: 'idle',
            socket: instance.path,
            instance_id: 'inst-a91f',
            pid: 41233,
          }),
        );

        // A self-resolver that returns a different session on each successive
        // call. Three independent resolutions in one send_peer — listPeers,
        // the envelope's from=, and the wire's message_from — could then
        // disagree, and the envelope is the load-bearing provenance control
        // on this path.
        const answers = ['ses_self', 'ses_sibling', 'ses_self', 'ses_sibling'];
        let i = 0;
        const side = buildSide(
          'opencode',
          {
            registryDir: join(dir, 'sessions'),
            pid: 1,
            cwd: '/src/x',
            env: { TINCAN_HOME: home, OPENCODE_PID: '41233' },
          },
          { resolveSelfSession: async () => answers[i++ % answers.length]! },
        );

        const log = new MessageLog(join(logDir, 'messages.jsonl'));
        const r = await createTools(side, log).send_peer({
          peer: 'target-session',
          message: 'hi',
        });
        expect(r.delivered).toBe(true);

        const wire = JSON.parse(instance.rawLines[0]!) as { message_from: string; text: string };
        expect(wire.text).toContain(`from="${wire.message_from}"`);
        // ...and it is a real session's slug, not the cwd fallback.
        expect(['nimble-wizard', 'proud-forest']).toContain(wire.message_from);
        // One tool call, one resolution.
        expect(i).toBe(1);
      } finally {
        await instance.close();
        rmSync(logDir, { recursive: true, force: true });
      }
    },
  );

  test('send_peer addressed to our own slug is refused as a self-send, never delivered', async () => {
    const instance = await fakeOpencodeInstance();
    const logDir = mkdtempSync(join(tmpdir(), 'tincan-oc-log-'));
    try {
      await writeInstance(instance);
      writeFileSync(
        join(registryDir, 'inst-a91f.caller.json'),
        JSON.stringify({
          instance_id: 'inst-a91f',
          session_id: 'ses_self',
          pid: 41233,
          tool: 'tincan_send_peer',
          at: '2026-09-19T14:02:11Z',
        }),
      );
      const side = buildSide('opencode', {
        registryDir: join(dir, 'sessions'),
        pid: 1,
        cwd: '/src/x',
        env: { TINCAN_HOME: home, OPENCODE_PID: '41233' },
      });
      const log = new MessageLog(join(logDir, 'messages.jsonl'));
      const r = await createTools(side, log).send_peer({ peer: 'nimble-wizard', message: 'hi' });
      expect(r.delivered).toBe(false);
      expect(r.refusal).toBe('peer_unknown');
      expect(r.detail?.toLowerCase()).toContain('yourself');
    } finally {
      await instance.close();
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
