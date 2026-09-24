/**
 * README claims that are mechanically checkable, pinned to the code that makes
 * them true (#28).
 *
 * The failure this prevents is specific: a subsystem is written, later changed
 * or extended, and the documentation keeps describing the earlier version in
 * the present tense. Nothing fails and nothing warns. The Tools table went
 * fourteen releases describing `send_peer` as a one-recipient tool with five
 * parameters, while fan-out, `expect_id`, `answers` and `idempotency_key` all
 * shipped underneath it.
 *
 * Only claims with a single unambiguous source in the code belong here. Prose
 * that explains a trade-off is not testable and is not the point — the point
 * is the handful of sentences that name a value, a key or a path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolDefinitions } from '../src/tool-definitions.js';
import { createTools, MAX_FANOUT, sendPeerSchema, type Side, type SidePeer } from '../src/tools.js';
import { CODEX_LIMITS } from '../src/guard.js';
import { PEER_STATES } from '../src/claude/discover.js';
import { buildSide, type HostContext } from '../src/runtime.js';
import { LABEL, type RuntimeName } from '../src/naming.js';
import { MessageLog, messagesPath } from '../src/log.js';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  engines: { node: string };
};

/** The `## Tools` section, up to the next heading. */
function toolsSection(): string {
  const start = README.indexOf('\n## Tools\n');
  expect(start, 'README has no `## Tools` section').toBeGreaterThan(-1);
  const rest = README.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Table rows keyed by the backticked tool name in the first cell. */
function toolRows(): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of toolsSection().split('\n')) {
    const m = /^\|\s*`([a-z_]+)`\s*\|(.*)\|\s*$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) rows.set(m[1], m[2]);
  }
  return rows;
}

/**
 * The parameter names `send_peer` actually accepts, read off the zod schema
 * that refuses everything else. `innerType()` unwraps the two `.refine()`
 * wrappers — it is public API, unlike `_def`.
 */
function schemaKeys(): string[] {
  let base: unknown = sendPeerSchema;
  while (typeof (base as { innerType?: unknown }).innerType === 'function') {
    base = (base as { innerType: () => unknown }).innerType();
  }
  const shape = (base as { shape?: Record<string, unknown> }).shape;
  expect(shape, 'could not reach the send_peer object shape').toBeDefined();
  return Object.keys(shape!).sort();
}

/** Keys of the result object in the README's `send_peer` example block. */
function sendPeerExampleKeys(): string[] {
  const block = [...README.matchAll(/```jsonc\n([\s\S]*?)```/g)]
    .map((m) => m[1] ?? '')
    .find((b) => b.includes('// send_peer'));
  expect(block, 'README has no ```jsonc block showing a send_peer call').toBeDefined();
  const json = (block ?? '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n')
    .trim();
  return Object.keys(JSON.parse(json) as Record<string, unknown>);
}

/** The smallest side that can deliver, so a real result can be inspected. */
function side(): Side {
  const p: SidePeer = {
    runtime: 'codex',
    rawName: 'Auth refactor',
    uuid: '00000000-0000-0000-0000-0000000007f3',
    cwd: '/src/auth',
    state: 'idle',
    threadId: '00000000-0000-0000-0000-0000000007f3',
  };
  return {
    selfRuntime: 'claude-code',
    ownKindScope: 'cross-config-dir',
    resolveSelf: async () => ({ sessionId: undefined }),
    selfName: async () => 'billing-api',
    selfCwd: '/src/billing',
    peerRuntimes: ['codex'],
    limitsFor: () => CODEX_LIMITS,
    listPeers: async () => ({ peers: [p] }),
    deliver: async () => ({ delivered: true, method: 'thread/queue/add' }),
  };
}

describe('README parity', () => {
  const defs = toolDefinitions(['codex'], 'codex', 'included');

  it('documents every tool the server exposes, and invents none', () => {
    expect([...toolRows().keys()].sort()).toEqual(defs.map((d) => d.name).sort());
  });

  // Both directions matter and fail differently: an undocumented parameter is
  // a capability nobody finds, and a documented one that does not exist sends
  // a caller down a path that is refused.
  it('documents exactly the parameters send_peer accepts', () => {
    const row = toolRows().get('send_peer');
    expect(row, 'no `send_peer` row in the Tools table').toBeDefined();
    const signature = /\{([^}]+)\}/.exec(row ?? '')?.[1];
    expect(signature, 'the `send_peer` row states no {param, ...} signature').toBeDefined();
    const documented = (signature ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\?$/, '').replace(/`/g, ''))
      .filter((s) => s !== '')
      .sort();
    expect(documented).toEqual(schemaKeys());
  });

  it('names exactly the peer states peers can return', () => {
    const row = toolRows().get('peers');
    const backticked = [...(row ?? '').matchAll(/`([a-z]+)`/g)].map((m) => m[1]);
    for (const state of PEER_STATES) {
      expect(backticked, `the peers row does not name the \`${state}\` state`).toContain(state);
    }
    // No invented states: every backticked lowercase word in the states list
    // must be one the code can actually return.
    const stateList = /state \(([^)]+)\)/.exec(row ?? '')?.[1] ?? '';
    const named = [...stateList.matchAll(/`([a-z]+)`/g)].map((m) => m[1]);
    expect(named).toEqual([...PEER_STATES]);
  });

  // The example is the first thing a reader copies, and it is the claim most
  // likely to rot: it shows a RESULT, and result shapes change. 1.0.0 replaced
  // `delivered` with `outcome` and this block kept printing the old field.
  // Compared against a real `send_peer` return rather than a remembered shape.
  it('shows a send_peer result whose fields send_peer actually returns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tincan-readme-'));
    try {
      const tools = createTools(side(), new MessageLog(join(dir, 'messages.jsonl')));
      const real = await tools.send_peer({ peer: 'auth-refactor', message: 'hello' });
      expect(real.outcome, 'the fixture side should deliver').toBe('accepted');

      for (const key of sendPeerExampleKeys()) {
        expect(
          Object.keys(real),
          `README shows \`${key}\` in a send_peer result; send_peer does not return it`,
        ).toContain(key);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('states the fan-out cap send_peer actually enforces', () => {
    expect(README).toContain(`up to ${MAX_FANOUT} recipients`);
  });

  // The asymmetry table is the claim a reader uses to decide whether a missing
  // peer is a bug or the design, and it is three rows of prose beside a switch
  // statement. Checked against the side each host actually builds.
  describe('the peer matrix matches the side each host builds', () => {
    const ctx = (): HostContext => ({
      registryDirs: () => [join(mkdtempSync(join(tmpdir(), 'tincan-matrix-')), 'sessions')],
      pid: 1,
      cwd: '/src/x',
      env: {},
    });

    /** The `Hosted in | Lists` rows, keyed by the host's label. */
    const matrixRows = (): Map<string, string> => {
      const rows = new Map<string, string>();
      for (const line of README.split('\n')) {
        const m = /^\|\s*(Claude Code|Codex|opencode)\s*\|(.+)\|\s*$/.exec(line);
        if (m?.[1] !== undefined && m[2] !== undefined) rows.set(m[1], m[2]);
      }
      return rows;
    };

    it.each(['claude-code', 'codex', 'opencode'] as const)('%s', (runtime) => {
      const built = buildSide(runtime, ctx(), { sweep: { socketDirs: [] } });
      const row = matrixRows().get(LABEL[runtime]);
      expect(row, `no matrix row for ${LABEL[runtime]}`).toBeDefined();

      const listed = (Object.keys(LABEL) as RuntimeName[]).filter((r) =>
        // `opencode` is a substring of nothing else; `Codex` and `Claude Code`
        // are distinct. Word-ish match so "Claude Code" does not count as
        // "Codex".
        new RegExp(`\\b${LABEL[r]}\\b`).test(row ?? ''),
      );
      expect(new Set(listed)).toEqual(new Set(built.peerRuntimes));

      // The one row that must carry the caveat is the one whose side scopes
      // its own kind. Stating it on the wrong row is how a reader concludes a
      // peer is unreachable when it is natively listed.
      const scoped = /other\*{0,2}\s*config dirs|other config dirs/i.test(row ?? '');
      expect(scoped).toBe(built.ownKindScope === 'cross-config-dir');
    });
  });

  it('names the log path the code actually writes', () => {
    const row = toolRows().get('message_log');
    expect(row).toContain(messagesPath({}, '~'));
  });

  // The engines floor is a promise to a user choosing a Node version, and it
  // is made in two files that have never been checked against each other.
  it('states the same Node floor as package.json engines', () => {
    const floor = /(\d+)/.exec(pkg.engines.node)?.[1];
    expect(floor).toBeDefined();
    expect(README).toContain(`Node ${floor} or newer`);
  });
});
