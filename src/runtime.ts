/**
 * Which harness is hosting us, and what the opposite side looks like.
 * Not a config flag (§4): the environment already answers it.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { assertNever, slugify, type RuntimeName } from './naming.js';
import { CLAUDE_LIMITS, CODEX_LIMITS, OPENCODE_LIMITS } from './guard.js';
import type { Side, SidePeer, SelfRef, DeliveryOutcome } from './tools.js';
import { listClaudeSessions, probeSocket, canonicalDir, dedupeDirs } from './claude/discover.js';
import { sweepUnaccounted } from './claude/sweep.js';
import { resolveConfigDirFromProcess, type ConfigDirResolver } from './claude/env.js';
import { readPointers, pointerDir } from './claude/registry.js';
import { sendToInbox, type InboxAuth } from './claude/client.js';
import { listCodexPeers, type CodexEnv } from './codex/discover.js';
import { createCodexEnv, parentPidLookup } from './codex/cli.js';
import { pickSelfThreadId, ancestorPids } from './codex/self.js';
import { listOpencodeSessions, type OpencodeSession } from './opencode/discover.js';
import { sendToInstance } from './opencode/client.js';
import { selfSessionId, parseOpencodePid } from './opencode/self.js';

export interface HostContext {
  /**
   * Our own dir first, then every dir a pointer record names — resolved on
   * every call, never once at boot. A Claude Code session runs for days and
   * the second-account session it wants to reach is usually started later,
   * so a list captured at startup is the one list guaranteed to be wrong.
   * The opencode arm's resolveSelfSession carries the same warning.
   */
  registryDirs: () => string[];
  pid: number;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Where Claude Code session registries live. Our own config dir is always
 * first and always present; the rest are what other Tin Cans announced.
 *
 * There is no glob here on purpose. Nothing constrains CLAUDE_CONFIG_DIR to
 * $HOME, to a dotfile, or to the string "claude" — a glob would be a guess
 * about a convention that does not exist. What a config dir cannot hide from
 * is the socket dir, which is the sweep's job, not this function's.
 */
export function claudeRegistryDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const own = join(
    env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0
      ? env.CLAUDE_CONFIG_DIR
      : join(home, '.claude'),
    'sessions',
  );
  const dirs = [own];
  const seen = new Set([canonicalDir(own)]);
  for (const rec of readPointers(pointerDir(env, home))) {
    const key = canonicalDir(rec.registryDir);
    if (seen.has(key)) continue;
    if (!existsSync(rec.registryDir)) continue;
    seen.add(key);
    dirs.push(rec.registryDir);
  }
  return dirs;
}

/** Mirrors the plugin's peersDir. Keep these two in step. */
export function opencodeRegistryDir(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): string {
  const base = env.TINCAN_HOME && env.TINCAN_HOME.length > 0 ? env.TINCAN_HOME : join(home, '.tincan');
  return join(base, 'peers', 'opencode');
}

export function detectRuntime(env: NodeJS.ProcessEnv): RuntimeName {
  // OPENCODE first, deliberately. An MCP subprocess inherits the environment of
  // whatever launched opencode, so CLAUDE_CODE_MESSAGING_SOCKET can be present
  // at the same time — verified with a stub MCP server. Checking Claude first
  // makes an opencode-hosted instance misidentify its own host.
  if (env.OPENCODE || env.OPENCODE_PID) return 'opencode';
  if (env.CLAUDE_CODE_MESSAGING_SOCKET) return 'claude-code';
  return 'codex';
}

export function selfNameFor(runtime: RuntimeName, ctx: HostContext): string {
  if (runtime === 'claude-code') {
    // Tin Can runs as a child of the session, so ctx.pid is never the
    // session's — which is why the old `rec.pid === pid` arm could not match,
    // and why a session under an alternate config dir fell through to its
    // cwd. CLAUDE_CODE_SESSION_ID is the only identifier that works.
    const sessionId = (ctx.env ?? process.env).CLAUDE_CODE_SESSION_ID;
    const name = findSessionName(ctx.registryDirs(), sessionId);
    if (name !== undefined) return name;
  }
  return basename(ctx.cwd) || runtime;
}

function findSessionName(
  registryDirs: string[],
  sessionId: string | undefined,
): string | undefined {
  if (sessionId === undefined || sessionId === '') return undefined;
  for (const registryDir of registryDirs) {
    if (!existsSync(registryDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(registryDir).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      continue;
    }
    for (const file of entries) {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(readFileSync(join(registryDir, file), 'utf8')) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (rec.sessionId === sessionId && typeof rec.name === 'string' && rec.name !== '') {
        return rec.name;
      }
    }
  }
  return undefined;
}

export interface SideDeps {
  /**
   * Test seam. Production sweeps socketDirCandidates, which always includes
   * the real /tmp/cc-socks — so without this a test sweeps whatever sessions
   * happen to be running on the machine it is executed on.
   */
  sweep?: SweepDeps;
  /**
   * Test seam only. Production always reads the caller file
   * (`selfSessionId`); this exists so a test can make successive reads
   * disagree, which is the change notice §4 race the per-call `SelfRef`
   * exists to survive.
   */
  resolveSelfSession?: () => Promise<string | undefined>;
  /**
   * Test seam. Production lists the real Codex threads, so without this a
   * test sees whatever Codex sessions happen to be running on the machine it
   * executes on — the same hazard `sweep` exists for, and the reason an
   * empty-list assertion could otherwise pass by taking the non-empty branch.
   */
  listCodex?: typeof listCodexPeers;
}

export interface SweepDeps {
  resolveConfigDir?: ConfigDirResolver;
  isLive?: (pid: number) => boolean;
  socketDirs?: string[];
}

/** The session ids that wrote a pointer — i.e. the peers that can answer. */
export function replyCapableSessionIds(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): Set<string> {
  return new Set(readPointers(pointerDir(env, home)).map((r) => r.sessionId));
}

/**
 * The one place Claude peers are built, so all three arms agree on what a
 * Claude peer is. Registries first; then the sweep, which can only be run
 * once the registries have said which pids they accounted for.
 */
export async function claudePeersWithSweep(
  ctx: HostContext,
  env: NodeJS.ProcessEnv,
  uid: number,
  replyCapable: Set<string>,
  deps: SweepDeps = {},
): Promise<{ peers: SidePeer[]; diagnostic?: string }> {
  const known = ctx.registryDirs();
  const first = await listClaudeSessions({ registryDirs: known, selfPid: ctx.pid, env });

  const swept = sweepUnaccounted({
    env,
    uid,
    accountedPids: first.accountedPids,
    resolveConfigDir: deps.resolveConfigDir ?? resolveConfigDirFromProcess,
    ...(deps.isLive !== undefined && { isLive: deps.isLive }),
    ...(deps.socketDirs !== undefined && { socketDirs: deps.socketDirs }),
  });

  // Re-run over the UNION, never concatenate two listings. A swept dir can
  // hold a stale record for a pid a known dir also claims; two separate runs
  // are each internally collision-free and would still emit that pid twice,
  // with two tokens, one of them dead — exactly what the procStart tiebreak
  // exists to prevent. One run sees both candidates and judges them.
  const listing =
    swept.resolvedDirs.length === 0
      ? first
      : await listClaudeSessions({
          registryDirs: dedupeDirs([...known, ...swept.resolvedDirs]),
          selfPid: ctx.pid,
          env,
        });

  const peers: SidePeer[] = listing.sessions.map((session) => ({
    runtime: 'claude-code',
    rawName: session.rawName,
    uuid: session.uuid,
    cwd: session.cwd,
    state: session.state,
    socketPath: session.socketPath,
    configDir: session.configDir,
    canReply: replyCapable.has(session.uuid),
    ...(session.auth !== undefined && { auth: session.auth }),
  }));

  // The pid is all we honestly know — but it must still be a *distinct* name.
  // rawName null and uuid '' would slug to the literal 'thread' with an empty
  // suffix (see assignNames), which is both what unnamed Codex threads are
  // already called and identical between any two unresolved peers:
  // resolvePeer could then only ever call them ambiguous.
  //
  // It is addressable despite having no token: the inbox was measured
  // accepting an unauthenticated write (see the spec's Delivery section).
  // That is an observation of 2.1.267, not a contract — if a later build
  // enforces the token, these peers start failing delivery loudly, which is
  // the right way for that assumption to break.
  for (const u of swept.unresolved) {
    peers.push({
      runtime: 'claude-code',
      rawName: `unknown-${u.pid}`,
      uuid: `pid-${u.pid}`,
      cwd: '',
      state: (await probeSocket(u.socketPath)) ? 'idle' : 'unreachable',
      socketPath: u.socketPath,
      canReply: false,
    });
  }

  const notes: string[] = [];
  if (listing.diagnostic !== undefined) notes.push(listing.diagnostic);
  if (swept.unresolved.length > 0) {
    const pids = swept.unresolved.map((u) => u.pid).join(', ');
    const many = swept.unresolved.length > 1;
    notes.push(
      `Claude Code pid${many ? 's' : ''} ${pids} ${many ? 'are' : 'is'} live but in a config ` +
        `dir Tin Can could not identify, so ${many ? 'they' : 'it'} cannot answer you. Run Tin ` +
        `Can in that session once and it becomes an ordinary peer.`,
    );
  }

  return { peers, ...(notes.length > 0 && { diagnostic: notes.join(' ') }) };
}

export const NO_PEERS_DIAGNOSTIC =
  'No other agent sessions are running. Start a Codex, Claude Code, or opencode ' +
  'session, or check that it has taken its first turn.';

/**
 * The diagnostic for an empty peer list.
 *
 * The opencode note is an *addition*, never a substitute. It is produced on a
 * plain ENOENT of the opencode registry, which is the normal state for every
 * user who does not run opencode — so letting it win replaced the one hint
 * that actually applies to the host with advice about a runtime the user
 * never asked for. Change notice §1 asked that an empty *opencode* list name
 * the plugin; it did not ask for that to outrank everything else.
 */
/**
 * The whole diagnostic for an empty peer list, composed the same way on every
 * arm.
 *
 * Three arms each built this inline and each built it differently — the Codex
 * and opencode arms fell back to the generic hint, the Claude arm did not, so
 * with the opencode plugin installed (no ENOENT note), zero peers and no Codex
 * diagnostic it answered `peers: []` and nothing at all (#7).
 *
 * All three also dropped the CLAUDE listing's diagnostic here, which is the
 * more costly half: `listClaudeSessions` reports pids that appear in more than
 * one config dir and could not be told apart, and it SKIPS them — so that
 * report and an empty list arrive together, and the one message explaining the
 * emptiness was discarded at exactly the moment it applied. Cross-config-dir
 * ambiguity is a multi-account symptom, which is the case this whole arm
 * exists to serve.
 *
 * The generic hint is a FALLBACK, not a prefix: a listing that explained
 * itself has said something truer than "nothing is running".
 */
export function emptyListDiagnostic(listings: {
  codex?: string | undefined;
  claude?: string | undefined;
  opencode?: string | undefined;
}): string | undefined {
  const specific = [listings.codex, listings.claude].filter(
    (s): s is string => s !== undefined && s !== '',
  );
  return composeEmptyDiagnostic(
    specific.length > 0 ? specific.join(' ') : NO_PEERS_DIAGNOSTIC,
    listings.opencode,
  );
}

export function composeEmptyDiagnostic(
  primary: string | undefined,
  opencodeNote: string | undefined,
): string | undefined {
  const parts = [primary, opencodeNote].filter(
    (s): s is string => s !== undefined && s !== '',
  );
  return parts.length === 0 ? undefined : parts.join(' ');
}

/**
 * A host that names itself from its own environment resolves nothing per
 * call: only the opencode arm has an answer that can change underneath it.
 */
const NO_SESSION: SelfRef = { sessionId: undefined };

/**
 * The host's own Claude Code session id, or `undefined` when there is not one.
 *
 * Shared by all three arms rather than re-derived, for the reason
 * `parseOpencodePid` is shared: a guard copied per call site gets tightened at
 * one and not the others. This one had two copies and the third arm had none
 * at all (#5).
 *
 * Normalised to `undefined` when absent or empty: a Claude registry record
 * with no sessionId reads back as `''`, and two empty strings must not match
 * each other into "this peer is us".
 */
function selfClaudeSessionId(env: NodeJS.ProcessEnv): string | undefined {
  return env.CLAUDE_CODE_SESSION_ID !== undefined && env.CLAUDE_CODE_SESSION_ID !== ''
    ? env.CLAUDE_CODE_SESSION_ID
    : undefined;
}

export function buildSide(runtime: RuntimeName, ctx: HostContext, deps: SideDeps = {}): Side {
  const env = ctx.env ?? process.env;
  const common = { selfRuntime: runtime, selfCwd: ctx.cwd };
  const listCodex = deps.listCodex ?? listCodexPeers;

  switch (runtime) {
    case 'claude-code': {
      // Claude Code's own sessions are reached natively by SendMessage — but
      // only within one config dir. A session under a different
      // CLAUDE_CONFIG_DIR is invisible to it, which is precisely the gap Tin
      // Can fills here. The exclusion was never about the runtime; it is
      // about reachability, and two logged paths to one destination is still
      // worse than one.
      const codex = createCodexEnv();
      const name = selfNameFor(runtime, ctx);
      const registryDir = opencodeRegistryDir(env);
      const peerRuntimes: RuntimeName[] = ['codex', 'opencode', 'claude-code'];

      // From the environment, never from registryDirs()[0]: `resolve('')`
      // returns the *cwd*, so an empty list would silently compare every peer
      // against the working directory, match nothing, and list the
      // same-account sessions SendMessage already covers.
      const ownRegistryDir = resolve(
        join(
          env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0
            ? env.CLAUDE_CONFIG_DIR
            : join(homedir(), '.claude'),
          'sessions',
        ),
      );
      const selfSessionId = selfClaudeSessionId(env);

      return {
        ...common,
        ownKindScope: 'cross-config-dir',
        resolveSelf: async () => NO_SESSION,
        selfName: async () => name,
        peerRuntimes,
        limitsFor,
        async listPeers() {
          const [codexListing, opencodeListing, claudeListing] = await Promise.all([
            listCodex(codex),
            listOpencodeSessions({ registryDir }),
            claudePeersWithSweep(
              ctx,
              env,
              process.getuid?.() ?? 0,
              replyCapableSessionIds(env),
              deps.sweep ?? {},
            ),
          ]);

          const claudePeers = claudeListing.peers.filter((p) => {
            // Ours, by session id: the one exclusion that must never fail,
            // since a self-send would deliver over our own inbox.
            if (selfSessionId !== undefined && p.uuid === selfSessionId) return false;
            // Same config dir: SendMessage's job, not ours. An unresolved
            // swept peer has no configDir and is by definition not ours.
            if (
              p.configDir !== undefined &&
              resolve(join(p.configDir, 'sessions')) === ownRegistryDir
            ) {
              return false;
            }
            return true;
          });

          const peers = [
            ...codexListing.peers.map(toCodexSidePeer),
            ...opencodeListing.peers.map(toOpencodeSidePeer),
            ...claudePeers,
          ];
          const diagnostic =
            peers.length === 0
              ? emptyListDiagnostic({
                  codex: codexListing.diagnostic,
                  claude: claudeListing.diagnostic,
                  opencode: opencodeListing.diagnostic,
                })
              : (codexListing.diagnostic ?? claudeListing.diagnostic);
          return {
            peers,
            ...(diagnostic !== undefined && { diagnostic }),
          };
        },
        deliver: (_self, peer, id, text, urgent) =>
          deliverTo(codex, ctx, peer, id, text, urgent, async () => name),
      };
    }

    case 'opencode': {
      // opencode has no native peer messaging of any kind (change notice §4),
      // so unlike the Claude Code host this side lists all three runtimes —
      // including its own. That means a Tin Can instance hosted here must
      // exclude itself from among its opencode siblings too, not merely from
      // Codex/Claude Code.
      const registryDir = opencodeRegistryDir(env);
      const codexForOpencode = createCodexEnv();
      const peerRuntimes: RuntimeName[] = ['codex', 'claude-code', 'opencode'];

      // Deliberately NOT cached across calls: the caller file is scoped to
      // the opencode *instance*, and one instance can run several sessions
      // that each call a Tin Can tool through the same shared MCP subprocess
      // (SPEC §4). Caching the first answer would freeze "self" to whichever
      // session happened to call first, misidentifying every later caller.
      const resolveSelfSession =
        deps.resolveSelfSession ?? (() => selfSessionId({ registryDir, env }));

      return {
        ...common,
        ownKindScope: 'included',
        // Called once per tool call by createTools, never from inside the
        // three consumers below — that is the whole point.
        resolveSelf: async () => ({ sessionId: await resolveSelfSession() }),
        selfName: (self) => opencodeSelfName(registryDir, self.sessionId, ctx.cwd),
        peerRuntimes,
        limitsFor,

        async listPeers(self) {
          const selfSession = self.sessionId;
          const [codexListing, claudeListing, opencodeListing] = await Promise.all([
            listCodex(codexForOpencode),
            claudePeersWithSweep(
              ctx,
              env,
              process.getuid?.() ?? 0,
              replyCapableSessionIds(env),
              deps.sweep ?? {},
            ),
            listOpencodeSessions({ registryDir }),
          ]);

          const codexPeers = codexListing.peers.map(toCodexSidePeer);
          // `listClaudeSessions` can only drop `pid === selfPid`, and selfPid
          // is `ctx.pid` — Tin Can's own MCP subprocess, never the session's
          // (see selfNameFor's comment). On the Codex arm that construct is
          // provably safe, because detectRuntime cannot return `codex` while
          // CLAUDE_CODE_MESSAGING_SOCKET is set. This arm is the first that
          // *can* be entered with that socket present, since §4 deliberately
          // orders OPENCODE first — so if a Claude Code session's environment
          // leaks in around us, our own session would otherwise be listed as
          // an ordinary peer and a self-send would deliver over its inbox.
          // Normalised to undefined when absent or empty: a Claude record
          // with no sessionId reads back as '' and must not be mistaken for
          // us on the strength of two empty strings matching.
          const selfClaudeSession = selfClaudeSessionId(env);
          const claudePeers: SidePeer[] = claudeListing.peers.filter(
            (p) => p.uuid !== selfClaudeSession,
          );

          // Self-exclusion (change notice §4, corrected by the probe). When
          // the caller file names our exact session, exclude only it — a
          // sibling session in the same instance stays addressable, which is
          // the entire reason the caller file exists rather than just keying
          // off OPENCODE_PID. When it does not (missing or unreadable caller
          // file), fall back to excluding every session of our own
          // instance: over-excluding a sibling is safe, under-excluding
          // risks a self-send delivering to ourselves.
          // Shared with self.ts's own guard (parseOpencodePid) rather than
          // re-derived here — a duplicated `Number(env.OPENCODE_PID)` is
          // exactly how the positive-integer check (Number('') is 0, and
          // Number.isInteger(0) is true) got fixed in one copy and not the
          // other.
          const selfPid = parseOpencodePid(env);
          const opencodePeers = opencodeListing.peers
            .filter((s) => {
              if (selfSession !== undefined) return s.uuid !== selfSession;
              if (selfPid !== undefined) return s.pid !== selfPid;
              // We cannot identify ourselves at all — OPENCODE_PID itself is
              // missing or unparseable, so there is no pid to key the
              // instance-level fallback on either. Exclude every opencode
              // session rather than risk a self-send: over-excluding here is
              // safe, listing ourselves is not.
              return false;
            })
            .map(toOpencodeSidePeer);

          const peers = [...codexPeers, ...claudePeers, ...opencodePeers];
          if (peers.length === 0) {
            return {
              peers,
              diagnostic: emptyListDiagnostic({
                codex: codexListing.diagnostic,
                claude: claudeListing.diagnostic,
                opencode: opencodeListing.diagnostic,
              }),
            };
          }
          return {
            peers,
            ...(codexListing.diagnostic !== undefined && { diagnostic: codexListing.diagnostic }),
          };
        },

        deliver: (self, peer, id, text, urgent) =>
          deliverTo(codexForOpencode, ctx, peer, id, text, urgent, () =>
            opencodeSelfName(registryDir, self.sessionId, ctx.cwd),
          ),
      };
    }

    case 'codex': {
      // Hosted in Codex. Codex's own collaboration.list_agents / send_message
      // are scoped to a spawn tree ("live agents in the current root thread
      // tree") and cannot reach an independently launched session, so Tin Can
      // exposes Codex, Claude, AND opencode peers here. The asymmetry with the
      // Claude side is deliberate — see the README. Unlike the opencode host,
      // a Codex thread has no opencode session of its own to exclude, so
      // opencode peers need no self-filtering here.
      const codexForSelf = createCodexEnv();
      const registryDir = opencodeRegistryDir(env);
      let selfThread: string | undefined;
      const selfName = makeSelfNameResolver(
        () => codexThreadName(codexForSelf, ctx, env),
        ctx.cwd,
      );
      const peerRuntimes: RuntimeName[] = ['codex', 'claude-code', 'opencode'];

      return {
        ...common,
        ownKindScope: 'included',
        resolveSelf: async () => NO_SESSION,
        selfName,
        peerRuntimes,
        limitsFor,

        async listPeers() {
          selfThread ??= await selfThreadId_(codexForSelf, ctx, env);

          const [codexListing, claudeListing, opencodeListing] = await Promise.all([
            listCodex(codexForSelf),
            claudePeersWithSweep(
              ctx,
              env,
              process.getuid?.() ?? 0,
              replyCapableSessionIds(env),
              deps.sweep ?? {},
            ),
            listOpencodeSessions({ registryDir }),
          ]);

          const codexPeers = codexListing.peers
            .filter((p) => p.threadId !== selfThread) // never list ourselves
            .map(toCodexSidePeer);

          // #5. The same filter the opencode arm has carried since 0.5.0.
          // listClaudeSessions can only drop `pid === selfPid`, and selfPid is
          // ctx.pid — Tin Can's own MCP subprocess, never the session's — so
          // without this our host's own Claude session is an ordinary peer and
          // a self-send delivers over its inbox. This arm was safe only
          // because detectRuntime cannot return `codex` while
          // CLAUDE_CODE_MESSAGING_SOCKET is set: a property of the detection
          // order, not of this arm. One function's safety should not rest on
          // another function's internals.
          const claudePeers: SidePeer[] = claudeListing.peers.filter(
            (p) => p.uuid !== selfClaudeSessionId(env),
          );

          const opencodePeers = opencodeListing.peers.map(toOpencodeSidePeer);

          const peers = [...codexPeers, ...claudePeers, ...opencodePeers];
          if (peers.length === 0) {
            return {
              peers,
              diagnostic: emptyListDiagnostic({
                codex: codexListing.diagnostic,
                claude: claudeListing.diagnostic,
                opencode: opencodeListing.diagnostic,
              }),
            };
          }
          return {
            peers,
            ...(codexListing.diagnostic !== undefined && { diagnostic: codexListing.diagnostic }),
          };
        },

        deliver: (_self, peer, id, text, urgent) =>
          deliverTo(codexForSelf, ctx, peer, id, text, urgent, selfName),
      };
    }

    default:
      return assertNever(runtime, 'buildSide');
  }
}

export function limitsFor(runtime: RuntimeName) {
  switch (runtime) {
    case 'codex':
      return CODEX_LIMITS;
    case 'claude-code':
      return CLAUDE_LIMITS;
    case 'opencode':
      return OPENCODE_LIMITS;
    default:
      return assertNever(runtime, 'limitsFor');
  }
}

function toCodexSidePeer(p: {
  rawName: string | null;
  uuid: string;
  cwd: string;
  state: ReturnType<typeof String> extends never ? never : SidePeer['state'];
  threadId: string;
}): SidePeer {
  return {
    runtime: 'codex',
    rawName: p.rawName,
    uuid: p.uuid,
    cwd: p.cwd,
    state: p.state,
    threadId: p.threadId,
  };
}

function toOpencodeSidePeer(p: OpencodeSession): SidePeer {
  return {
    runtime: 'opencode',
    rawName: p.rawName,
    uuid: p.uuid,
    cwd: p.cwd,
    state: p.state,
    socketPath: p.socketPath,
  };
}

/**
 * Delivery dispatches on the peer's runtime, not on the host's.
 *
 * `urgent` must reach every branch that can act on it. It is threaded through
 * explicitly here — rather than folded into a closure captured elsewhere —
 * because an arrow with fewer parameters than `Side.deliver`'s declared type
 * is assignable to it with no compiler error (see runtime.test.ts and
 * tools.test.ts's end-to-end `urgent` tests). `selfName` is only needed for
 * the opencode wire, which is the one that carries a sender field explicitly.
 */
async function deliverTo(
  codex: CodexEnv,
  ctx: HostContext,
  peer: SidePeer,
  id: string,
  text: string,
  urgent: boolean,
  selfName: () => Promise<string>,
): Promise<DeliveryOutcome> {
  switch (peer.runtime) {
    case 'codex': {
      const r = await codex.queue(peer.threadId ?? peer.uuid, text);
      return {
        delivered: r.ok,
        method: 'thread/queue/add',
        ...(r.error !== undefined && { error: r.error }),
      };
    }
    case 'claude-code': {
      const r = await sendToInbox({
        socketPath: peer.socketPath!,
        auth: peer.auth as InboxAuth | undefined,
        text,
        msgId: id,
      });
      return {
        delivered: r.delivered,
        method: 'inbox',
        ...(r.notice !== undefined && { notice: r.notice }),
        ...(r.error !== undefined && { error: r.error }),
        ...(r.unreachable !== undefined && { unreachable: r.unreachable }),
      };
    }
    case 'opencode': {
      const r = await sendToInstance({
        socketPath: peer.socketPath!,
        toSession: peer.uuid,
        from: await selfName(),
        text,
        // opencode's own default is "steer"; Tin Can's policy is queue-by-
        // default (SPEC §7 / change-notice-opencode.md §3). This field must
        // always be set explicitly — never leave it to inherit opencode's
        // default, which would silently invert the policy.
        delivery: urgent ? 'steer' : 'queue',
        messageId: id,
      });
      return {
        delivered: r.delivered,
        method: 'opencode/prompt_async',
        ...(r.error !== undefined && { error: r.error }),
        ...(r.unreachable !== undefined && { unreachable: r.unreachable }),
      };
    }
    default:
      return assertNever(peer.runtime, 'deliverTo');
  }
}

/**
 * Our own slug: peers address us by whatever `slug` our own `ses_*.json`
 * advertises (I6), not by our working directory's basename. `isSelfAddress`
 * (tools.ts) compares a typed address against exactly this value, so getting
 * it wrong means a self-send typed as our slug is never recognised as self —
 * it either returns a misleading `peer_unknown` instead of `self_send`, or,
 * when the caller file is absent, is not excluded at all and delivers.
 *
 * Slugified, exactly as the Codex path slugifies its thread title
 * (`codexSelfNameOf`). The registry slug is the plugin's to write and is
 * interpolated straight into `from="…"` by `renderEnvelope`, which does no
 * escaping — a slug containing `"` or a literal `</peer_message>` would break
 * the framing of the one control that marks a message as a peer's (SPEC §7).
 * It is also what a peer has to type back into `send_peer`, which is reason
 * enough on its own.
 *
 * Falls back to the directory name, the same as every other host, whenever a
 * session cannot be resolved, its record has no slug, or the slug survives
 * slugify as nothing.
 */
async function opencodeSelfName(
  registryDir: string,
  sessionId: string | undefined,
  cwd: string,
): Promise<string> {
  const raw = sessionId === undefined ? undefined : readOpencodeSlug(registryDir, sessionId);
  const slug = raw === undefined ? '' : slugify(raw);
  return slug !== '' ? slug : basename(cwd) || 'opencode';
}

function readOpencodeSlug(registryDir: string, sessionId: string): string | undefined {
  const path = join(registryDir, `${sessionId}.json`);
  if (!existsSync(path)) return undefined;
  try {
    const rec = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return typeof rec.slug === 'string' && rec.slug.length > 0 ? rec.slug : undefined;
  } catch {
    return undefined;
  }
}

/** Our own Codex thread, so a Codex-hosted instance never lists itself. */
async function selfThreadId_(
  codex: CodexEnv,
  ctx: HostContext,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const live = await codex.liveThreads();
    const holders = new Map<string, number>();
    for (const [threadId, info] of live) {
      if (info.pid !== undefined) holders.set(threadId, info.pid);
    }
    const chain = [ctx.pid, ...(await ancestorPids(ctx.pid, parentPidLookup(env)))];
    return pickSelfThreadId(holders, chain);
  } catch {
    return undefined;
  }
}

/**
 * Caches only a real answer. A Codex thread has no title until its first turn,
 * but the MCP server starts before that and resolves its own name for the
 * startup diagnostic — caching that fallback left a session calling itself by
 * its directory for the rest of its life.
 */
export function makeSelfNameResolver(
  resolve: () => Promise<string | undefined>,
  cwd: string,
): () => Promise<string> {
  let cached: string | undefined;
  return async () => {
    if (cached !== undefined) return cached;
    const name = await resolve();
    if (name === undefined || name === '') return basename(cwd) || 'codex';
    cached = name;
    return cached;
  };
}

/**
 * The slugified title of the Codex thread hosting us, or undefined if it does
 * not have one yet. Undefined rather than a fallback, so the caller can decide
 * whether the answer is worth caching.
 */
async function codexThreadName(
  codex: CodexEnv,
  ctx: HostContext,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const id = await selfThreadId_(codex, ctx, env);
    if (id === undefined) return undefined;
    const threads = await codex.listThreads();
    const raw = threads.find((t) => t.id === id)?.name;
    const slug = raw === undefined || raw === null ? '' : slugify(raw);
    return slug === '' ? undefined : slug;
  } catch {
    return undefined;
  }
}


/**
 * The name a Codex-hosted tincan puts in `from=`. Slugified, because that is
 * what a peer types back into send_peer.
 */
export function codexSelfNameOf(threadName: string | null, cwd: string): string {
  const slug = threadName === null ? '' : slugify(threadName);
  return slug !== '' ? slug : basename(cwd) || 'codex';
}
