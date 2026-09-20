# opencode Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an opencode plugin that makes live opencode sessions addressable by Tin Can — advertising them as files under `~/.tincan/peers/opencode/`, accepting enveloped messages on a Unix socket, and injecting them into the session.

**Architecture:** One globbed entry file (`tincan.ts`) that does nothing but wire together pure, unit-tested helpers in `tincan-lib/`. The opencode plugin loader invokes *every* exported function in a globbed file as a plugin and does not descend into subdirectories, so `tincan.ts` exports exactly one function and all testable logic lives in `tincan-lib/`. Every helper is either pure or takes its I/O as an injected parameter, so the entire plugin is testable under the repo's existing vitest without running opencode.

**Tech Stack:** TypeScript (no build step — opencode runs `.ts` directly under Bun 1.3.14), `node:net` / `node:fs` only, vitest 2.1 for tests, zero runtime dependencies.

**Spec:** [`plugins/opencode/SPEC.md`](../../../plugins/opencode/SPEC.md) — Rev 2, verified against opencode 1.18.31. Read it before Task 1; every task below argues from it.

## Global Constraints

- **opencode 1.18.31** is the verified target. Pin it in the README.
- **Zero dependencies**, runtime *and* dev. Do not add `@opencode-ai/plugin` — its published types contradict the 1.18.31 runtime. Hand-write types in `tincan-lib/types.ts`.
- **No build step.** The plugin ships as `.ts` and is copied into place.
- **`tincan.ts` exports exactly one function** and no `default`. Every exported function is invoked by the loader as a plugin.
- **Helpers live in `plugins/opencode/tincan-lib/`** — one level down, never globbed.
- **Never log message text.** Sender, session, delivery mode, message id only (SPEC §8.2).
- **Socket mode `0600`; parent directory mode `0700`** (SPEC §8.3).
- **Registry writes are atomic** — temp file in the same directory, then rename (SPEC §4).
- **Never crash the host.** Every socket handler, file write and transport call is wrapped (SPEC §8.1).
- **v2 routes are prefixed `/api/`.** A wrong path returns 200 with SPA HTML, so a 200 alone never means success (SPEC §3).
- Node `>=22`, `strict` TypeScript with `noUncheckedIndexedAccess`.
- **Import helpers as `./tincan-lib/name.js`.** TypeScript `NodeNext` requires the extension, and Bun resolves `.js` to the `.ts` on disk — verified inside the opencode worker, so this one spelling satisfies both the typechecker and the runtime.

---

## Why TDD fits here, and where it stops

Eight units with real edge cases, several of them security-relevant: envelope byte-integrity, socket permissions, the HTML-that-looks-like-200, and a redaction guarantee. SPEC §9 is already a red-phase backlog. This is not too small for TDD.

What TDD cannot reach: the `event` hook actually firing, `dispose` actually running, and a real injection landing in a real agent's context. Those need a live TUI and are Task 11, a scripted acceptance pass against SPEC §10.

---

## File Structure

| File | Responsibility |
|---|---|
| `plugins/opencode/tincan.ts` | The only globbed file. One export, no `default`. Resolves deps and calls `startPlugin`. No logic. |
| `plugins/opencode/tincan-lib/types.ts` | Hand-written types. No imports, no logic. |
| `plugins/opencode/tincan-lib/log.ts` | Structured logging with a whitelist that makes leaking message text impossible. |
| `plugins/opencode/tincan-lib/paths.ts` | `TINCAN_HOME` resolution, registry paths, socket path length guard. Pure. |
| `plugins/opencode/tincan-lib/wire.ts` | Parse and validate one inbound line. Pure. |
| `plugins/opencode/tincan-lib/registry.ts` | Compose a record, atomic write, delete, sweep orphans. |
| `plugins/opencode/tincan-lib/events.ts` | Map an opencode event to a registry effect. Pure. |
| `plugins/opencode/tincan-lib/delivery.ts` | Build the prompt request, interpret the response. |
| `plugins/opencode/tincan-lib/server.ts` | `node:net` socket lifecycle, newline framing, liveness probe. |
| `plugins/opencode/tincan-lib/caller.ts` | Records which session invoked a Tin Can MCP tool, for self-exclusion. |
| `plugins/opencode/tincan-lib/plugin.ts` | The line handler and `startPlugin`. The only file that holds mutable state. |
| `plugins/opencode/test/*.test.ts` | One test file per `tincan-lib` module, plus `line-handler.test.ts`. |
| `plugins/opencode/test/send.py` | Wire sender for the live acceptance pass. |
| `plugins/opencode/README.md` | Install, uninstall, troubleshooting, pinned version. |
| `vitest.config.ts` | Modified — widen `include` to pick up plugin tests. |
| `tsconfig.plugin.json` | Created — typecheck `plugins/**` without emitting into `dist`. |
| `package.json` | Modified — `typecheck:plugin` script, ship the plugin (not its tests) on npm. |

---

## Task 1: Harness wiring and types

Nothing testable exists yet, so this task's deliverable is *the harness itself*: proof that a test file under `plugins/opencode/test/` runs, and that `plugins/**` typechecks.

**Files:**
- Create: `plugins/opencode/tincan-lib/types.ts`
- Create: `tsconfig.plugin.json`
- Create: `plugins/opencode/test/types.test.ts`
- Modify: `vitest.config.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: every type below. Later tasks import from `../tincan-lib/types.js`.

- [ ] **Step 1: Write the failing test**

Create `plugins/opencode/test/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PLUGIN_VERSION, SESSION_ID_RE, MESSAGE_ID_RE } from '../tincan-lib/types.js';

describe('plugin constants', () => {
  it('exposes a semver plugin version', () => {
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('matches opencode session ids and rejects others', () => {
    expect(SESSION_ID_RE.test('ses_f4185535affe0nxzk66nw19ihJ')).toBe(true);
    expect(SESSION_ID_RE.test('sess_abc')).toBe(true);
    expect(SESSION_ID_RE.test('msg_abc')).toBe(false);
    expect(SESSION_ID_RE.test('')).toBe(false);
  });

  it('matches opencode message ids and rejects others', () => {
    expect(MESSAGE_ID_RE.test('msg_01J8TESTAAAAAAAAAAAAAAAA')).toBe(true);
    expect(MESSAGE_ID_RE.test('not-a-msg-id')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/opencode/test/types.test.ts`
Expected: FAIL — vitest reports "No test files found" (the `include` pattern does not cover `plugins/`).

- [ ] **Step 3: Widen the vitest include**

Replace `vitest.config.ts` entirely:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'plugins/**/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
});
```

- [ ] **Step 4: Run test to verify it now fails for the right reason**

Run: `npx vitest run plugins/opencode/test/types.test.ts`
Expected: FAIL — "Cannot find module '../tincan-lib/types.js'". The harness is wired; the code is missing.

- [ ] **Step 5: Write the types**

Create `plugins/opencode/tincan-lib/types.ts`:

```ts
/**
 * Hand-written types for the slice of opencode 1.18.31 this plugin touches.
 *
 * Deliberately NOT imported from @opencode-ai/plugin: its published types
 * disagree with the 1.18.31 runtime in both directions — they declare a
 * `client.v2` that does not exist, and omit the `slug` that does.
 * See SPEC.md §2.
 */

export const PLUGIN_VERSION = '1.0.0';
export const OPENCODE_TESTED_VERSION = '1.18.31';

/** Server-enforced: sessionID must match ^ses, message id must match ^msg_. */
export const SESSION_ID_RE = /^ses/;
export const MESSAGE_ID_RE = /^msg_/;

/** No 'unreachable': the plugin cannot observe its own absence. Tin Can infers
 *  that from a refused socket and caches it in its own view. SPEC §4. */
export type SessionState = 'idle' | 'busy';
export type Delivery = 'queue' | 'steer';

/** The subset of opencode's Session we rely on. `slug` and `version` are
 *  present at runtime on event payloads even though the SDK type omits them. */
export interface SessionInfo {
  id: string;
  slug: string;
  title: string;
  directory: string;
  version: string;
}

export interface RegistryRecord {
  session_id: string;
  slug: string;
  title: string;
  directory: string;
  state: SessionState;
  socket: string;
  instance_id: string;
  pid: number;
  plugin_version: string;
  opencode_version: string;
  updated_at: string;
}

export interface InboundMessage {
  to_session: string;
  message_from: string;
  text: string;
  delivery: Delivery;
  message_id: string;
}

/** The hey-api client reachable at `input.client._client`. See SPEC.md §3. */
export interface TransportResponse {
  data?: unknown;
  error?: unknown;
  response?: { status?: number };
}
export interface Transport {
  get(args: { url: string }): Promise<TransportResponse>;
  post(args: { url: string; body?: unknown }): Promise<TransportResponse>;
}

export type DeliveryOutcome =
  | { kind: 'delivered'; admittedSeq: number; replay: boolean }
  | { kind: 'rejected'; status: number; tag: string; detail: string }
  | { kind: 'transport-broken'; detail: string };
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run plugins/opencode/test/types.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Add the plugin typecheck config**

Create `tsconfig.plugin.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "."
  },
  "include": ["plugins/**/*.ts"]
}
```

In `package.json`, add to `scripts`:

```json
"typecheck:plugin": "tsc -p tsconfig.plugin.json"
```

and add these three entries to the `files` array so the plugin ships on npm and users can copy it out of `node_modules` — the tests and the spec stay out of the tarball:

```json
"plugins/opencode/tincan.ts",
"plugins/opencode/tincan-lib",
"plugins/opencode/README.md"
```

- [ ] **Step 8: Verify the whole suite and the typecheck**

Run: `npm test && npm run typecheck:plugin`
Expected: the existing repo suite still passes, the new test passes, typecheck is clean.

- [ ] **Step 9: Commit**

```bash
git add vitest.config.ts tsconfig.plugin.json package.json plugins/opencode/tincan-lib/types.ts plugins/opencode/test/types.test.ts
git commit -m "feat(opencode): plugin test harness and hand-written types"
```

---

## Task 2: Redaction-safe logging

SPEC §8.2 forbids the plugin from ever writing message bodies into opencode's logs. A whitelist makes that a property of the code rather than a rule people remember.

**Files:**
- Create: `plugins/opencode/tincan-lib/log.ts`
- Create: `plugins/opencode/test/log.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `formatLog(fields: LogFields): string`, `makeLogger(sink: (line: string) => void): Logger`, types `LogFields` and `Logger`.

- [ ] **Step 1: Write the failing test**

Create `plugins/opencode/test/log.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatLog, makeLogger } from '../tincan-lib/log.js';

describe('formatLog', () => {
  it('renders whitelisted fields as key=value', () => {
    const line = formatLog({ event: 'delivered', session: 'ses_a', from: 'billing-api', delivery: 'queue', message_id: 'msg_1' });
    expect(line).toBe('[tincan] event=delivered session=ses_a from=billing-api delivery=queue message_id=msg_1');
  });

  it('omits absent fields entirely', () => {
    expect(formatLog({ event: 'bound' })).toBe('[tincan] event=bound');
  });

  it('drops any field outside the whitelist, including message text', () => {
    const hostile = { event: 'delivered', text: 'SECRET BODY', prompt: 'ALSO SECRET' } as never;
    const line = formatLog(hostile);
    expect(line).not.toContain('SECRET');
    expect(line).not.toContain('text=');
    expect(line).toBe('[tincan] event=delivered');
  });

  it('collapses newlines so one event is always one line', () => {
    const line = formatLog({ event: 'rejected', detail: 'line one\nline two' });
    expect(line).toBe('[tincan] event=rejected detail=line one line two');
  });
});

describe('makeLogger', () => {
  it('writes formatted lines to the sink', () => {
    const seen: string[] = [];
    const log = makeLogger((l) => seen.push(l));
    log({ event: 'dropped', detail: 'bad json' });
    expect(seen).toEqual(['[tincan] event=dropped detail=bad json']);
  });

  it('never throws when the sink throws', () => {
    const log = makeLogger(() => { throw new Error('sink exploded'); });
    expect(() => log({ event: 'bound' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/opencode/test/log.test.ts`
Expected: FAIL — "Cannot find module '../tincan-lib/log.js'".

- [ ] **Step 3: Write minimal implementation**

Create `plugins/opencode/tincan-lib/log.ts`:

```ts
/**
 * Logging with a hard whitelist. SPEC §8.2: the plugin must never write
 * message bodies into opencode's logs. Enforced here rather than remembered
 * at every call site.
 */

export interface LogFields {
  event: string;
  session?: string;
  from?: string;
  delivery?: string;
  message_id?: string;
  status?: number;
  detail?: string;
}

export type Logger = (fields: LogFields) => void;

const ORDER = ['event', 'session', 'from', 'delivery', 'message_id', 'status', 'detail'] as const;

export function formatLog(fields: LogFields): string {
  const parts: string[] = [];
  for (const key of ORDER) {
    const value = (fields as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${String(value).replace(/\s*[\r\n]+\s*/g, ' ')}`);
  }
  return `[tincan] ${parts.join(' ')}`;
}

export function makeLogger(sink: (line: string) => void): Logger {
  return (fields) => {
    try {
      sink(formatLog(fields));
    } catch {
      // A logging failure must never reach the host. SPEC §8.1.
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/opencode/test/log.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/opencode/tincan-lib/log.ts plugins/opencode/test/log.test.ts
git commit -m "feat(opencode): whitelist logger that cannot leak message text"
```

---

## Task 3: Path resolution and the socket length guard

macOS caps `AF_UNIX` paths at ~103 bytes — 102 binds, 106 fails. The default path is ~56 bytes, but a deep `TINCAN_HOME` breaks bind, and SPEC §4 requires a clear error instead of a raw throw.

**Files:**
- Create: `plugins/opencode/tincan-lib/paths.ts`
- Create: `plugins/opencode/test/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `peersDir(env, home)`, `sessionFile(dir, sessionID)`, `socketPath(dir, instanceID)`, `socketPathTooLong(path)`, `newInstanceId(randomHex)`, constant `MAX_UNIX_PATH`.

- [ ] **Step 1: Write the failing test**

Create `plugins/opencode/test/paths.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { peersDir, sessionFile, socketPath, socketPathTooLong, newInstanceId, MAX_UNIX_PATH } from '../tincan-lib/paths.js';

describe('peersDir', () => {
  it('defaults to ~/.tincan/peers/opencode', () => {
    expect(peersDir({}, '/Users/mike')).toBe('/Users/mike/.tincan/peers/opencode');
  });

  it('honours TINCAN_HOME', () => {
    expect(peersDir({ TINCAN_HOME: '/srv/tc' }, '/Users/mike')).toBe('/srv/tc/peers/opencode');
  });

  it('ignores an empty TINCAN_HOME', () => {
    expect(peersDir({ TINCAN_HOME: '' }, '/Users/mike')).toBe('/Users/mike/.tincan/peers/opencode');
  });
});

describe('file and socket paths', () => {
  it('names a session file by session id', () => {
    expect(sessionFile('/p', 'ses_abc')).toBe('/p/ses_abc.json');
  });

  it('names a socket by instance id', () => {
    expect(socketPath('/p', 'inst-a91f')).toBe('/p/inst-a91f.sock');
  });
});

describe('socketPathTooLong', () => {
  it('accepts a realistic default path', () => {
    const p = socketPath(peersDir({}, '/Users/mike'), 'inst-a91f2c');
    expect(p.length).toBeLessThan(MAX_UNIX_PATH);
    expect(socketPathTooLong(p)).toBe(false);
  });

  it('rejects a path at or beyond the limit', () => {
    expect(socketPathTooLong('/' + 'x'.repeat(MAX_UNIX_PATH))).toBe(true);
  });

  it('measures bytes, not characters', () => {
    // 'é' is two bytes in UTF-8; a path of 60 of them exceeds 103 bytes.
    expect(socketPathTooLong('/' + 'é'.repeat(60))).toBe(true);
  });
});

describe('newInstanceId', () => {
  it('prefixes the supplied random hex', () => {
    expect(newInstanceId(() => 'a91f2c')).toBe('inst-a91f2c');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/opencode/test/paths.test.ts`
Expected: FAIL — "Cannot find module '../tincan-lib/paths.js'".

- [ ] **Step 3: Write minimal implementation**

Create `plugins/opencode/tincan-lib/paths.ts`:

```ts
import { join } from 'node:path';

/**
 * macOS caps sun_path at 104 bytes including the NUL terminator; 102 bytes
 * binds and 106 fails on the verified machine. Guard at 103. SPEC §4.
 */
export const MAX_UNIX_PATH = 103;

export function peersDir(env: Record<string, string | undefined>, home: string): string {
  const base = env.TINCAN_HOME && env.TINCAN_HOME.length > 0 ? env.TINCAN_HOME : join(home, '.tincan');
  return join(base, 'peers', 'opencode');
}

export function sessionFile(dir: string, sessionID: string): string {
  return join(dir, `${sessionID}.json`);
}

export function socketPath(dir: string, instanceID: string): string {
  return join(dir, `${instanceID}.sock`);
}

export function socketPathTooLong(path: string): boolean {
  return Buffer.byteLength(path, 'utf8') >= MAX_UNIX_PATH;
}

export function newInstanceId(randomHex: () => string): string {
  return `inst-${randomHex()}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/opencode/test/paths.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/opencode/tincan-lib/paths.ts plugins/opencode/test/paths.test.ts
git commit -m "feat(opencode): registry paths and AF_UNIX length guard"
```

---

## Task 4: Inbound line parsing and validation

SPEC §7 fixes the wire format. Both id patterns are server-enforced, so validating at the plugin boundary turns a doomed HTTP call into a logged drop.

**Files:**
- Create: `plugins/opencode/tincan-lib/wire.ts`
- Create: `plugins/opencode/test/wire.test.ts`

**Interfaces:**
- Consumes: `InboundMessage`, `SESSION_ID_RE`, `MESSAGE_ID_RE` from `../tincan-lib/types.js`.
- Produces: `parseLine(line: string): ParseResult`, type `ParseResult = { ok: true; message: InboundMessage } | { ok: false; reason: string }`, constant `MAX_LINE_BYTES`.

- [ ] **Step 1: Write the failing test**

Create `plugins/opencode/test/wire.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseLine, MAX_LINE_BYTES } from '../tincan-lib/wire.js';

const good = {
  to_session: 'ses_f4185535affe0nxzk66nw19ihJ',
  message_from: 'billing-api',
  text: '<peer_message from="billing-api">hi</peer_message>',
  delivery: 'queue',
  message_id: 'msg_01J8TESTAAAAAAAAAAAAAAAA',
};

describe('parseLine', () => {
  it('accepts a well-formed line', () => {
    const r = parseLine(JSON.stringify(good));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toEqual(good);
  });

  it('preserves text byte-for-byte, including newlines and quotes', () => {
    const text = '<peer_message from="a" id="msg_1">\nline\ttwo\n</peer_message>';
    const r = parseLine(JSON.stringify({ ...good, text }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message.text).toBe(text);
      expect(Buffer.from(r.message.text)).toEqual(Buffer.from(text));
    }
  });

  it('rejects truncated JSON', () => {
    const r = parseLine('{"to_session":"ses_a"');
    expect(r).toEqual({ ok: false, reason: 'malformed json' });
  });

  it('rejects a JSON array', () => {
    expect(parseLine('[]')).toEqual({ ok: false, reason: 'not an object' });
  });

  it('rejects null', () => {
    expect(parseLine('null')).toEqual({ ok: false, reason: 'not an object' });
  });

  it.each([
    ['to_session', 'missing to_session'],
    ['message_from', 'missing message_from'],
    ['text', 'missing text'],
    ['delivery', 'missing delivery'],
    ['message_id', 'missing message_id'],
  ])('rejects a line missing %s', (field, reason) => {
    const body: Record<string, unknown> = { ...good };
    delete body[field];
    expect(parseLine(JSON.stringify(body))).toEqual({ ok: false, reason });
  });

  it('rejects a session id that does not start with ses', () => {
    const r = parseLine(JSON.stringify({ ...good, to_session: 'nope_1' }));
    expect(r).toEqual({ ok: false, reason: 'bad to_session' });
  });

  it('rejects a message id that does not start with msg_', () => {
    const r = parseLine(JSON.stringify({ ...good, message_id: 'not-a-msg-id' }));
    expect(r).toEqual({ ok: false, reason: 'bad message_id' });
  });

  it('rejects an unknown delivery mode', () => {
    const r = parseLine(JSON.stringify({ ...good, delivery: 'urgent' }));
    expect(r).toEqual({ ok: false, reason: 'bad delivery' });
  });

  it('accepts steer', () => {
    const r = parseLine(JSON.stringify({ ...good, delivery: 'steer' }));
    expect(r.ok).toBe(true);
  });

  it('rejects an oversize line', () => {
    const r = parseLine(JSON.stringify({ ...good, text: 'x'.repeat(MAX_LINE_BYTES) }));
    expect(r).toEqual({ ok: false, reason: 'oversize' });
  });

  it('never includes message text in the rejection reason', () => {
    const r = parseLine(JSON.stringify({ ...good, delivery: 'urgent', text: 'SECRET BODY' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toContain('SECRET');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/opencode/test/wire.test.ts`
Expected: FAIL — "Cannot find module '../tincan-lib/wire.js'".

- [ ] **Step 3: Write minimal implementation**

Create `plugins/opencode/tincan-lib/wire.ts`:

```ts
import { MESSAGE_ID_RE, SESSION_ID_RE, type Delivery, type InboundMessage } from './types.js';

/** One line, one message. Anything larger is a sender bug or an attack. */
export const MAX_LINE_BYTES = 256 * 1024;

export type ParseResult =
  | { ok: true; message: InboundMessage }
  | { ok: false; reason: string };

function str(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function parseLine(line: string): ParseResult {
  if (Buffer.byteLength(line, 'utf8') >= MAX_LINE_BYTES) return { ok: false, reason: 'oversize' };

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'malformed json' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'not an object' };
  }
  const o = raw as Record<string, unknown>;

  if (!str(o.to_session)) return { ok: false, reason: 'missing to_session' };
  if (!str(o.message_from)) return { ok: false, reason: 'missing message_from' };
  if (!str(o.text)) return { ok: false, reason: 'missing text' };
  if (!str(o.delivery)) return { ok: false, reason: 'missing delivery' };
  if (!str(o.message_id)) return { ok: false, reason: 'missing message_id' };

  if (!SESSION_ID_RE.test(o.to_session)) return { ok: false, reason: 'bad to_session' };
  if (!MESSAGE_ID_RE.test(o.message_id)) return { ok: false, reason: 'bad message_id' };
  if (o.delivery !== 'queue' && o.delivery !== 'steer') return { ok: false, reason: 'bad delivery' };

  return {
    ok: true,
    message: {
      to_session: o.to_session,
      message_from: o.message_from,
      text: o.text,
      delivery: o.delivery as Delivery,
      message_id: o.message_id,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/opencode/test/wire.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/opencode/tincan-lib/wire.ts plugins/opencode/test/wire.test.ts
git commit -m "feat(opencode): inbound line parsing and validation"
```

---

## Task 5: Registry records — compose, write atomically, delete

SPEC §4. `session.updated` fires repeatedly while the model rewrites the title, so an unchanged-record check is required or the file churns continuously during a turn.

**Files:**
- Create: `plugins/opencode/tincan-lib/registry.ts`
- Create: `plugins/opencode/test/registry.test.ts`

**Interfaces:**
- Consumes: `RegistryRecord`, `SessionInfo`, `SessionState` from `../tincan-lib/types.js`.
- Produces: `composeRecord(info, state, ctx)`, `sameIgnoringTimestamp(a, b)`, `writeRecord(dir, rec)`, `removeRecord(dir, sessionID)`, `removeAllForInstance(dir, instanceID)`, interface `RecordContext`.

- [ ] **Step 1: Write the failing test**

Create `plugins/opencode/test/registry.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeRecord, sameIgnoringTimestamp, writeRecord, removeRecord, removeAllForInstance, type RecordContext } from '../tincan-lib/registry.js';
import type { SessionInfo } from '../tincan-lib/types.js';

const info: SessionInfo = {
  id: 'ses_f4185535affe0nxzk66nw19ihJ',
  slug: 'nimble-wizard',
  title: 'auth refactor',
  directory: '/Users/mike/Source/billing',
  version: '1.18.31',
};

const ctx: RecordContext = {
  socket: '/Users/mike/.tincan/peers/opencode/inst-a91f.sock',
  instance_id: 'inst-a91f',
  pid: 41233,
  plugin_version: '1.0.0',
  now: () => new Date('2026-09-19T14:02:11.000Z'),
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tincan-reg-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('composeRecord', () => {
  it('builds the documented shape', () => {
    expect(composeRecord(info, 'idle', ctx)).toEqual({
      session_id: 'ses_f4185535affe0nxzk66nw19ihJ',
      slug: 'nimble-wizard',
      title: 'auth refactor',
      directory: '/Users/mike/Source/billing',
      state: 'idle',
      socket: '/Users/mike/.tincan/peers/opencode/inst-a91f.sock',
      instance_id: 'inst-a91f',
      pid: 41233,
      plugin_version: '1.0.0',
      opencode_version: '1.18.31',
      updated_at: '2026-09-19T14:02:11Z',
    });
  });

  it('takes opencode_version from the session info, not a constant', () => {
    const rec = composeRecord({ ...info, version: '1.19.0' }, 'busy', ctx);
    expect(rec.opencode_version).toBe('1.19.0');
  });
});

describe('sameIgnoringTimestamp', () => {
  it('is true when only updated_at differs', () => {
    const a = composeRecord(info, 'idle', ctx);
    const b = composeRecord(info, 'idle', { ...ctx, now: () => new Date('2027-01-01T00:00:00Z') });
    expect(sameIgnoringTimestamp(a, b)).toBe(true);
  });

  it('is false when the title changes', () => {
    const a = composeRecord(info, 'idle', ctx);
    const b = composeRecord({ ...info, title: 'PONG' }, 'idle', ctx);
    expect(sameIgnoringTimestamp(a, b)).toBe(false);
  });

  it('is false when the state changes', () => {
    const a = composeRecord(info, 'idle', ctx);
    const b = composeRecord(info, 'busy', ctx);
    expect(sameIgnoringTimestamp(a, b)).toBe(false);
  });
});

describe('writeRecord', () => {
  it('writes readable JSON named by session id', async () => {
    const rec = composeRecord(info, 'idle', ctx);
    await writeRecord(dir, rec);
    const onDisk = JSON.parse(readFileSync(join(dir, `${info.id}.json`), 'utf8'));
    expect(onDisk).toEqual(rec);
  });

  it('leaves no temp files behind', async () => {
    await writeRecord(dir, composeRecord(info, 'idle', ctx));
    expect(readdirSync(dir)).toEqual([`${info.id}.json`]);
  });

  it('forces the parent directory to 0700 even when it already exists at 0755', async () => {
    chmodSync(dir, 0o755);
    await writeRecord(dir, composeRecord(info, 'idle', ctx));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('overwrites an existing record', async () => {
    await writeRecord(dir, composeRecord(info, 'idle', ctx));
    await writeRecord(dir, composeRecord(info, 'busy', ctx));
    const onDisk = JSON.parse(readFileSync(join(dir, `${info.id}.json`), 'utf8'));
    expect(onDisk.state).toBe('busy');
    expect(readdirSync(dir)).toHaveLength(1);
  });
});

describe('removeRecord', () => {
  it('deletes the file', async () => {
    await writeRecord(dir, composeRecord(info, 'idle', ctx));
    await removeRecord(dir, info.id);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('is silent when the file is already gone', async () => {
    await expect(removeRecord(dir, 'ses_missing')).resolves.toBeUndefined();
  });
});

describe('removeAllForInstance', () => {
  it('deletes only records carrying the given instance id', async () => {
    await writeRecord(dir, composeRecord(info, 'idle', ctx));
    await writeRecord(dir, composeRecord({ ...info, id: 'ses_other' }, 'idle', { ...ctx, instance_id: 'inst-zzzz' }));
    await removeAllForInstance(dir, 'inst-a91f');
    expect(readdirSync(dir)).toEqual(['ses_other.json']);
  });

  it('ignores unparseable files rather than throwing', async () => {
    writeFileSync(join(dir, 'ses_junk.json'), 'not json');
    await expect(removeAllForInstance(dir, 'inst-a91f')).resolves.toBeUndefined();
    expect(readdirSync(dir)).toEqual(['ses_junk.json']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/opencode/test/registry.test.ts`
Expected: FAIL — "Cannot find module '../tincan-lib/registry.js'".

- [ ] **Step 3: Write minimal implementation**

Create `plugins/opencode/tincan-lib/registry.ts`:

```ts
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionFile } from './paths.js';
import type { RegistryRecord, SessionInfo, SessionState } from './types.js';

export interface RecordContext {
  socket: string;
  instance_id: string;
  pid: number;
  plugin_version: string;
  now: () => Date;
}

/** ISO 8601 to whole seconds, as SPEC §4's example shows. */
export function isoStamp(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

export function composeRecord(info: SessionInfo, state: SessionState, ctx: RecordContext): RegistryRecord {
  return {
    session_id: info.id,
    slug: info.slug,
    title: info.title,
    directory: info.directory,
    state,
    socket: ctx.socket,
    instance_id: ctx.instance_id,
    pid: ctx.pid,
    plugin_version: ctx.plugin_version,
    opencode_version: info.version,
    updated_at: isoStamp(ctx.now()),
  };
}

export function sameIgnoringTimestamp(a: RegistryRecord, b: RegistryRecord): boolean {
  const { updated_at: _a, ...restA } = a;
  const { updated_at: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

/** Atomic: temp file in the same directory, then rename. SPEC §4. */
export async function writeRecord(dir: string, rec: RegistryRecord): Promise<void> {
  // mkdir's `mode` is ignored when the directory already exists — and Tin Can
  // itself may have created ~/.tincan/peers at 0755. chmod unconditionally, or
  // the 0700 parent that closes the bind-to-chmod race in SPEC §8.3 is a
  // fiction.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const final = sessionFile(dir, rec.session_id);
  const tmp = `${final}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, final);
}

export async function removeRecord(dir: string, sessionID: string): Promise<void> {
  try {
    await unlink(sessionFile(dir, sessionID));
  } catch {
    // Already gone is the desired end state.
  }
}

export async function removeAllForInstance(dir: string, instanceID: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(await readFile(join(dir, name), 'utf8')) as RegistryRecord;
      if (rec.instance_id === instanceID) await unlink(join(dir, name));
    } catch {
      // Unreadable or unparseable: not ours to delete.
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/opencode/test/registry.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/opencode/tincan-lib/registry.ts plugins/opencode/test/registry.test.ts
git commit -m "feat(opencode): atomic registry record write and delete"
```

---

## Task 6: Event to effect mapping

SPEC §5. A pure reducer keeps the "advertise only what was announced" rule — the decision settled on 2026-09-20 — in one testable place.

**Files:**
- Create: `plugins/opencode/tincan-lib/events.ts`
- Create: `plugins/opencode/test/events.test.ts`

**Interfaces:**
- Consumes: `SessionInfo`, `SessionState` from `../tincan-lib/types.js`.
- Produces: `effectOf(event: unknown): EventEffect`, type `EventEffect = { kind: 'upsert'; info: SessionInfo } | { kind: 'state'; sessionID: string; state: SessionState } | { kind: 'remove'; sessionID: string } | { kind: 'ignore' }`.

- [ ] **Step 1: Write the failing test**

Create `plugins/opencode/test/events.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { effectOf } from '../tincan-lib/events.js';

const info = {
  id: 'ses_a',
  slug: 'nimble-wizard',
  title: 'auth refactor',
  directory: '/repo',
  version: '1.18.31',
  projectID: 'global',
  extra: 'ignored',
};

describe('effectOf', () => {
  it('upserts on session.created, keeping only the fields we use', () => {
    expect(effectOf({ type: 'session.created', properties: { info } })).toEqual({
      kind: 'upsert',
      info: { id: 'ses_a', slug: 'nimble-wizard', title: 'auth refactor', directory: '/repo', version: '1.18.31' },
    });
  });

  it('upserts on session.updated', () => {
    const e = effectOf({ type: 'session.updated', properties: { info: { ...info, title: 'PONG' } } });
    expect(e).toEqual({
      kind: 'upsert',
      info: { id: 'ses_a', slug: 'nimble-wizard', title: 'PONG', directory: '/repo', version: '1.18.31' },
    });
  });

  it('removes on session.deleted', () => {
    expect(effectOf({ type: 'session.deleted', properties: { info } })).toEqual({ kind: 'remove', sessionID: 'ses_a' });
  });

  it('sets idle on session.idle', () => {
    expect(effectOf({ type: 'session.idle', properties: { sessionID: 'ses_a' } })).toEqual({ kind: 'state', sessionID: 'ses_a', state: 'idle' });
  });

  it('maps status idle to idle', () => {
    expect(effectOf({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'idle' } } })).toEqual({ kind: 'state', sessionID: 'ses_a', state: 'idle' });
  });

  it.each(['busy', 'retry'])('maps status %s to busy', (type) => {
    expect(effectOf({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type } } })).toEqual({ kind: 'state', sessionID: 'ses_a', state: 'busy' });
  });

  it('maps an unknown future status to busy rather than dropping it', () => {
    expect(effectOf({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'hibernating' } } })).toEqual({ kind: 'state', sessionID: 'ses_a', state: 'busy' });
  });

  it.each([
    'session.diff',
    'message.updated',
    'message.part.delta',
    'plugin.added',
    'catalog.updated',
  ])('ignores %s', (type) => {
    expect(effectOf({ type, properties: { sessionID: 'ses_a' } })).toEqual({ kind: 'ignore' });
  });

  it('ignores a session event with no info', () => {
    expect(effectOf({ type: 'session.created', properties: {} })).toEqual({ kind: 'ignore' });
  });

  it('ignores an info payload missing a slug', () => {
    const { slug: _drop, ...noSlug } = info;
    expect(effectOf({ type: 'session.created', properties: { info: noSlug } })).toEqual({ kind: 'ignore' });
  });

  it('ignores malformed input without throwing', () => {
    expect(effectOf(null)).toEqual({ kind: 'ignore' });
    expect(effectOf(undefined)).toEqual({ kind: 'ignore' });
    expect(effectOf('session.created')).toEqual({ kind: 'ignore' });
    expect(effectOf({})).toEqual({ kind: 'ignore' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/opencode/test/events.test.ts`
Expected: FAIL — "Cannot find module '../tincan-lib/events.js'".

- [ ] **Step 3: Write minimal implementation**

Create `plugins/opencode/tincan-lib/events.ts`:

```ts
import type { SessionInfo, SessionState } from './types.js';

export type EventEffect =
  | { kind: 'upsert'; info: SessionInfo }
  | { kind: 'state'; sessionID: string; state: SessionState }
  | { kind: 'remove'; sessionID: string }
  | { kind: 'ignore' };

const IGNORE: EventEffect = { kind: 'ignore' };

function readInfo(v: unknown): SessionInfo | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (
    typeof o.id !== 'string' ||
    typeof o.slug !== 'string' ||
    typeof o.title !== 'string' ||
    typeof o.directory !== 'string' ||
    typeof o.version !== 'string'
  ) {
    return null;
  }
  return { id: o.id, slug: o.slug, title: o.title, directory: o.directory, version: o.version };
}

export function effectOf(event: unknown): EventEffect {
  if (typeof event !== 'object' || event === null) return IGNORE;
  const e = event as Record<string, unknown>;
  const props = (typeof e.properties === 'object' && e.properties !== null ? e.properties : {}) as Record<string, unknown>;

  switch (e.type) {
    case 'session.created':
    case 'session.updated': {
      const info = readInfo(props.info);
      return info ? { kind: 'upsert', info } : IGNORE;
    }
    case 'session.deleted': {
      const info = readInfo(props.info);
      return info ? { kind: 'remove', sessionID: info.id } : IGNORE;
    }
    case 'session.idle': {
      const id = props.sessionID;
      return typeof id === 'string' ? { kind: 'state', sessionID: id, state: 'idle' } : IGNORE;
    }
    case 'session.status': {
      const id = props.sessionID;
      if (typeof id !== 'string') return IGNORE;
      const status = props.status as { type?: unknown } | undefined;
      // Only 'idle' is idle. 'busy', 'retry' and anything opencode adds later
      // are all "the agent is not free". SPEC §5.
      const state: SessionState = status?.type === 'idle' ? 'idle' : 'busy';
      return { kind: 'state', sessionID: id, state };
    }
    default:
      return IGNORE;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/opencode/test/events.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/opencode/tincan-lib/events.ts plugins/opencode/test/events.test.ts
git commit -m "feat(opencode): pure event-to-registry-effect mapping"
```

---

## Task 7: Delivery — build the request, interpret the response

SPEC §7. Three traps live here: the `/api/` prefix, the 200-with-HTML that looks like success, and idempotent replay returning 200 rather than 409.

**Files:**
- Create: `plugins/opencode/tincan-lib/delivery.ts`
- Create: `plugins/opencode/test/delivery.test.ts`

**Interfaces:**
- Consumes: `InboundMessage`, `Transport`, `TransportResponse`, `DeliveryOutcome` from `../tincan-lib/types.js`.
- Produces: `promptUrl(sessionID)`, `promptBody(msg)`, `interpret(res, alreadySent)`, `deliver(transport, msg, alreadySent)`.

- [ ] **Step 1: Write the failing test**

Create `plugins/opencode/test/delivery.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { promptUrl, promptBody, interpret, deliver } from '../tincan-lib/delivery.js';
import type { InboundMessage, Transport, TransportResponse } from '../tincan-lib/types.js';

const envelope = '<peer_message from="billing-api" id="msg_01J8">\nDo the thing.\n</peer_message>';
const msg: InboundMessage = {
  to_session: 'ses_a',
  message_from: 'billing-api',
  text: envelope,
  delivery: 'queue',
  message_id: 'msg_01J8TESTAAAAAAAAAAAAAAAA',
};

const admitted = (seq: number): TransportResponse => ({
  response: { status: 200 },
  data: { data: { admittedSeq: seq, id: msg.message_id, sessionID: 'ses_a', prompt: { text: envelope }, delivery: 'queue', timeCreated: 1 } },
});

describe('promptUrl', () => {
  it('uses the /api prefix — without it opencode returns 200 and SPA HTML', () => {
    expect(promptUrl('ses_a')).toBe('/api/session/ses_a/prompt');
  });
});

describe('promptBody', () => {
  it('passes delivery explicitly and reuses message_id as the idempotency key', () => {
    expect(promptBody(msg)).toEqual({ prompt: { text: envelope }, delivery: 'queue', id: msg.message_id });
  });

  it('passes text through byte-identically', () => {
    const body = promptBody(msg);
    expect(Buffer.from(body.prompt.text)).toEqual(Buffer.from(envelope));
  });

  it('never omits delivery, because opencode would default to steer', () => {
    expect(Object.keys(promptBody({ ...msg, delivery: 'steer' }))).toContain('delivery');
    expect(promptBody({ ...msg, delivery: 'steer' }).delivery).toBe('steer');
  });
});

describe('interpret', () => {
  it('treats a JSON admission as delivered', () => {
    expect(interpret(admitted(16), false)).toEqual({ kind: 'delivered', admittedSeq: 16, replay: false });
  });

  it('flags a previously sent id as a replay', () => {
    expect(interpret(admitted(16), true)).toEqual({ kind: 'delivered', admittedSeq: 16, replay: true });
  });

  it('treats a 200 with SPA HTML as a broken transport, not a delivery', () => {
    const res: TransportResponse = { response: { status: 200 }, data: '<!doctype html>\n<html lang="en">' };
    expect(interpret(res, false)).toEqual({ kind: 'transport-broken', detail: 'html response — wrong route prefix?' });
  });

  it('treats a 200 with no admittedSeq as broken', () => {
    const res: TransportResponse = { response: { status: 200 }, data: { data: {} } };
    expect(interpret(res, false)).toEqual({ kind: 'transport-broken', detail: 'no admittedSeq in 200 response' });
  });

  it('reports a 404 with its tag', () => {
    const res: TransportResponse = { response: { status: 404 }, error: { _tag: 'SessionNotFoundError', sessionID: 'ses_a', message: 'Session not found: ses_a' } };
    expect(interpret(res, false)).toEqual({ kind: 'rejected', status: 404, tag: 'SessionNotFoundError', detail: 'Session not found: ses_a' });
  });

  it('reports a 400 with its tag', () => {
    const res: TransportResponse = { response: { status: 400 }, error: { _tag: 'InvalidRequestError', message: 'Expected a string starting with "msg_"' } };
    expect(interpret(res, false)).toEqual({ kind: 'rejected', status: 400, tag: 'InvalidRequestError', detail: 'Expected a string starting with "msg_"' });
  });

  it('reports a 409 as rejected so the caller can treat it as already delivered', () => {
    const res: TransportResponse = { response: { status: 409 }, error: { _tag: 'ConflictError', message: 'prompt conflict' } };
    expect(interpret(res, false)).toEqual({ kind: 'rejected', status: 409, tag: 'ConflictError', detail: 'prompt conflict' });
  });

  it('falls back to a tagless rejection when the error has no _tag', () => {
    const res: TransportResponse = { response: { status: 401 }, error: {} };
    expect(interpret(res, false)).toEqual({ kind: 'rejected', status: 401, tag: 'unknown', detail: '' });
  });
});

describe('deliver', () => {
  it('posts to the prefixed URL with the documented body', async () => {
    const post = vi.fn().mockResolvedValue(admitted(16));
    const transport = { post, get: vi.fn() } as unknown as Transport;
    const out = await deliver(transport, msg, new Set());
    expect(post).toHaveBeenCalledWith({ url: '/api/session/ses_a/prompt', body: { prompt: { text: envelope }, delivery: 'queue', id: msg.message_id } });
    expect(out).toEqual({ kind: 'delivered', admittedSeq: 16, replay: false });
  });

  it('marks a second send of the same id as a replay', async () => {
    const transport = { post: vi.fn().mockResolvedValue(admitted(16)), get: vi.fn() } as unknown as Transport;
    const sent = new Set<string>();
    await deliver(transport, msg, sent);
    const second = await deliver(transport, msg, sent);
    expect(second).toEqual({ kind: 'delivered', admittedSeq: 16, replay: true });
  });

  it('turns a thrown transport error into transport-broken instead of propagating', async () => {
    const transport = { post: vi.fn().mockRejectedValue(new Error('socket closed')), get: vi.fn() } as unknown as Transport;
    await expect(deliver(transport, msg, new Set())).resolves.toEqual({ kind: 'transport-broken', detail: 'Error: socket closed' });
  });

  it('does not record the id as sent when delivery failed', async () => {
    const transport = { post: vi.fn().mockRejectedValue(new Error('nope')), get: vi.fn() } as unknown as Transport;
    const sent = new Set<string>();
    await deliver(transport, msg, sent);
    expect(sent.has(msg.message_id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/opencode/test/delivery.test.ts`
Expected: FAIL — "Cannot find module '../tincan-lib/delivery.js'".

- [ ] **Step 3: Write minimal implementation**

Create `plugins/opencode/tincan-lib/delivery.ts`:

```ts
import type { DeliveryOutcome, InboundMessage, Transport, TransportResponse } from './types.js';

/**
 * The v2 API is prefixed /api/. Without the prefix opencode returns 200 and
 * the SPA's HTML, so a dropped prefix looks exactly like success. SPEC §3.
 */
export function promptUrl(sessionID: string): string {
  return `/api/session/${sessionID}/prompt`;
}

export interface PromptBody {
  prompt: { text: string };
  delivery: 'queue' | 'steer';
  id: string;
}

export function promptBody(msg: InboundMessage): PromptBody {
  return {
    // Verbatim. The <peer_message> envelope is the only provenance marking on
    // this path and must never be trimmed or reformatted. SPEC §7.
    prompt: { text: msg.text },
    // Always explicit: opencode defaults to "steer", Tin Can defaults to queue.
    delivery: msg.delivery,
    id: msg.message_id,
  };
}

export function interpret(res: TransportResponse, alreadySent: boolean): DeliveryOutcome {
  const status = res.response?.status ?? 0;
  const data: unknown = res.data;

  if (typeof data === 'string' && data.trimStart().toLowerCase().startsWith('<!doctype')) {
    return { kind: 'transport-broken', detail: 'html response — wrong route prefix?' };
  }

  if (status >= 400) {
    const err = (typeof res.error === 'object' && res.error !== null ? res.error : {}) as Record<string, unknown>;
    return {
      kind: 'rejected',
      status,
      tag: typeof err._tag === 'string' ? err._tag : 'unknown',
      detail: typeof err.message === 'string' ? err.message : '',
    };
  }

  const admitted = (data as { data?: { admittedSeq?: unknown } } | undefined)?.data;
  if (typeof admitted?.admittedSeq === 'number') {
    return { kind: 'delivered', admittedSeq: admitted.admittedSeq, replay: alreadySent };
  }
  return { kind: 'transport-broken', detail: 'no admittedSeq in 200 response' };
}

export async function deliver(transport: Transport, msg: InboundMessage, alreadySent: Set<string>): Promise<DeliveryOutcome> {
  const replay = alreadySent.has(msg.message_id);
  let res: TransportResponse;
  try {
    res = await transport.post({ url: promptUrl(msg.to_session), body: promptBody(msg) });
  } catch (e) {
    return { kind: 'transport-broken', detail: String(e) };
  }
  const outcome = interpret(res, replay);
  if (outcome.kind === 'delivered') alreadySent.add(msg.message_id);
  return outcome;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/opencode/test/delivery.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/opencode/tincan-lib/delivery.ts plugins/opencode/test/delivery.test.ts
git commit -m "feat(opencode): prompt delivery with /api prefix and HTML guard"
```

---

## Task 8: Socket server and liveness probe

> **Superseded in execution (2026-09-20).** The reference implementation below
> shipped with three defects, all found by this task's review and all in the
> plan's own sample rather than the implementer's transcription of it:
> `mkdir(…, {mode})` does not tighten an existing directory so the 0700 parent
> was unenforced on reuse; `onError` was itself unguarded; and `close()` hangs
> indefinitely while any connection is open, which would wedge opencode's
> shutdown. See commit `63f51ec` for the corrected implementation — do not
> re-apply the code below verbatim.


SPEC §4 and §6. `node:net` is used rather than `Bun.listen` precisely so this is testable here, under Node.

**Files:**
- Create: `plugins/opencode/tincan-lib/server.ts`
- Create: `plugins/opencode/test/server.test.ts`

**Interfaces:**
- Consumes: `MAX_LINE_BYTES` from `../tincan-lib/wire.js`, `socketPathTooLong` from `../tincan-lib/paths.js`.
- Produces: `listenLines(opts): Promise<ServerHandle>`, `probeSocket(path, timeoutMs?): Promise<boolean>`, interfaces `ServerHandle` and `ListenOptions`.

- [ ] **Step 1: Write the failing test**

Create `plugins/opencode/test/server.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { listenLines, probeSocket, type ServerHandle } from '../tincan-lib/server.js';

let dir: string;
let handle: ServerHandle | null = null;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-sock-')); });
afterEach(async () => { if (handle) { await handle.close(); handle = null; } rmSync(dir, { recursive: true, force: true }); });

function send(path: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = connect(path, () => { c.end(payload); });
    c.on('close', () => resolve());
    c.on('error', reject);
  });
}

const settle = () => new Promise((r) => setTimeout(r, 60));

describe('listenLines', () => {
  it('binds the socket at mode 0600', async () => {
    const path = join(dir, 'inst-a.sock');
    handle = await listenLines({ path, onLine: () => {}, onError: () => {} });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('delivers one newline-terminated line', async () => {
    const path = join(dir, 'inst-a.sock');
    const lines: string[] = [];
    handle = await listenLines({ path, onLine: (l) => lines.push(l), onError: () => {} });
    await send(path, '{"a":1}\n');
    await settle();
    expect(lines).toEqual(['{"a":1}']);
  });

  it('delivers a final line with no trailing newline', async () => {
    const path = join(dir, 'inst-a.sock');
    const lines: string[] = [];
    handle = await listenLines({ path, onLine: (l) => lines.push(l), onError: () => {} });
    await send(path, '{"a":1}');
    await settle();
    expect(lines).toEqual(['{"a":1}']);
  });

  it('splits two lines arriving in one write', async () => {
    const path = join(dir, 'inst-a.sock');
    const lines: string[] = [];
    handle = await listenLines({ path, onLine: (l) => lines.push(l), onError: () => {} });
    await send(path, '{"a":1}\n{"b":2}\n');
    await settle();
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reassembles a line split across two writes', async () => {
    const path = join(dir, 'inst-a.sock');
    const lines: string[] = [];
    handle = await listenLines({ path, onLine: (l) => lines.push(l), onError: () => {} });
    await new Promise<void>((resolve, reject) => {
      const c = connect(path, () => {
        c.write('{"a":');
        setTimeout(() => c.end('1}\n'), 20);
      });
      c.on('close', () => resolve());
      c.on('error', reject);
    });
    await settle();
    expect(lines).toEqual(['{"a":1}']);
  });

  it('drops an oversize line without delivering it and keeps accepting', async () => {
    const path = join(dir, 'inst-a.sock');
    const lines: string[] = [];
    const errors: unknown[] = [];
    handle = await listenLines({ path, onLine: (l) => lines.push(l), onError: (e) => errors.push(e) });
    await send(path, `${'x'.repeat(300 * 1024)}\n`);
    await settle();
    await send(path, '{"ok":1}\n');
    await settle();
    expect(lines).toEqual(['{"ok":1}']);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('survives a handler that throws', async () => {
    const path = join(dir, 'inst-a.sock');
    let second = false;
    handle = await listenLines({
      path,
      onLine: (l) => { if (l === 'boom') throw new Error('handler exploded'); second = true; },
      onError: () => {},
    });
    await send(path, 'boom\n');
    await settle();
    await send(path, 'fine\n');
    await settle();
    expect(second).toBe(true);
  });

  it('unlinks a stale socket file before binding', async () => {
    const path = join(dir, 'inst-a.sock');
    writeFileSync(path, '');
    handle = await listenLines({ path, onLine: () => {}, onError: () => {} });
    expect(existsSync(path)).toBe(true);
    await send(path, 'x\n');
  });

  it('refuses to bind an over-long path', async () => {
    const longDir = join(dir, 'd'.repeat(90));
    await expect(listenLines({ path: join(longDir, 'inst-a.sock'), onLine: () => {}, onError: () => {} }))
      .rejects.toThrow(/socket path too long/);
  });

  it('removes the socket file on close', async () => {
    const path = join(dir, 'inst-a.sock');
    const h = await listenLines({ path, onLine: () => {}, onError: () => {} });
    await h.close();
    expect(existsSync(path)).toBe(false);
  });
});

describe('probeSocket', () => {
  it('is true for a live socket', async () => {
    const path = join(dir, 'inst-a.sock');
    handle = await listenLines({ path, onLine: () => {}, onError: () => {} });
    expect(await probeSocket(path)).toBe(true);
  });

  it('is false for a stale socket file nobody is listening on', async () => {
    const path = join(dir, 'inst-dead.sock');
    const h = await listenLines({ path, onLine: () => {}, onError: () => {} });
    await h.close();
    writeFileSync(path, '');
    expect(await probeSocket(path)).toBe(false);
  });

  it('is false for a path that does not exist', async () => {
    expect(await probeSocket(join(dir, 'nope.sock'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/opencode/test/server.test.ts`
Expected: FAIL — "Cannot find module '../tincan-lib/server.js'".

- [ ] **Step 3: Write minimal implementation**

Create `plugins/opencode/tincan-lib/server.ts`:

```ts
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { socketPathTooLong } from './paths.js';
import { MAX_LINE_BYTES } from './wire.js';

export interface ListenOptions {
  path: string;
  onLine: (line: string) => void;
  onError: (err: unknown) => void;
}

export interface ServerHandle {
  close(): Promise<void>;
}

function frame(socket: Socket, opts: ListenOptions): void {
  socket.setEncoding('utf8');
  let buf = '';
  let overflowed = false;

  const emit = (line: string) => {
    if (line.length === 0) return;
    try {
      opts.onLine(line);
    } catch (e) {
      // A handler failure must never reach the host. SPEC §8.1.
      opts.onError(e);
    }
  };

  socket.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (overflowed) { overflowed = false; continue; }
      if (Buffer.byteLength(line, 'utf8') >= MAX_LINE_BYTES) {
        opts.onError(new Error('oversize line dropped'));
        continue;
      }
      emit(line);
    }
    if (Buffer.byteLength(buf, 'utf8') >= MAX_LINE_BYTES) {
      opts.onError(new Error('oversize line dropped'));
      buf = '';
      overflowed = true;
    }
  });

  socket.on('end', () => {
    if (!overflowed && buf.length > 0) emit(buf);
    buf = '';
  });
  socket.on('error', (e) => opts.onError(e));
}

export async function listenLines(opts: ListenOptions): Promise<ServerHandle> {
  if (socketPathTooLong(opts.path)) {
    throw new Error(`socket path too long (${Buffer.byteLength(opts.path)} bytes): ${opts.path}`);
  }
  await mkdir(dirname(opts.path), { recursive: true, mode: 0o700 });
  try {
    await unlink(opts.path);
  } catch {
    // Nothing there is the common case.
  }

  const server: Server = createServer((socket) => frame(socket, opts));
  server.on('error', (e) => opts.onError(e));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.path, () => resolve());
  });

  // Neither node:net nor Bun.listen honours 0600 on creation. SPEC §4.
  await chmod(opts.path, 0o600);

  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        await unlink(opts.path);
      } catch {
        // Already gone.
      }
    },
  };
}

/** The liveness test the whole staleness model rests on. SPEC §6. */
export function probeSocket(path: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (alive: boolean) => {
      if (done) return;
      done = true;
      try { c.destroy(); } catch { /* already gone */ }
      resolve(alive);
    };
    const c = connect(path);
    c.setTimeout(timeoutMs, () => finish(false));
    c.on('connect', () => finish(true));
    c.on('error', () => finish(false));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/opencode/test/server.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/opencode/tincan-lib/server.ts plugins/opencode/test/server.test.ts
git commit -m "feat(opencode): node:net line server at 0600 and liveness probe"
```

---

## Task 9: Orphan sweep

SPEC §6. The instance id is random per load, so nothing ever reclaims a crashed instance's files.

**The sweep must enumerate sockets directly, not only sockets named by registry records.** Because §5 advertises nothing on load, the most common crash leaves a socket with *no* records pointing at it: `opencode --continue`, never typed in, then `kill -9`. A record-driven sweep would never see it.

**Files:**
- Modify: `plugins/opencode/tincan-lib/registry.ts` (append `sweepOrphans`)
- Modify: `plugins/opencode/test/registry.test.ts` (append a describe block)

**Interfaces:**
- Consumes: a `probeSocket`-shaped function, injected so tests need no real sockets.
- Produces: `sweepOrphans(dir, selfInstance, probe): Promise<string[]>` returning the swept instance ids.

- [ ] **Step 1: Write the failing test**

Append to `plugins/opencode/test/registry.test.ts`:

```ts
import { sweepOrphans } from '../tincan-lib/registry.js';
import { existsSync } from 'node:fs';

describe('sweepOrphans', () => {
  const recFor = (sessionID: string, instance: string) => composeRecord(
    { ...info, id: sessionID },
    'idle',
    { ...ctx, instance_id: instance, socket: join(dir, `${instance}.sock`) },
  );

  it('removes the files and socket of an instance whose socket is refused', async () => {
    await writeRecord(dir, recFor('ses_dead', 'inst-dead'));
    writeFileSync(join(dir, 'inst-dead.sock'), '');
    const swept = await sweepOrphans(dir, 'inst-self', async () => false);
    expect(swept).toEqual(['inst-dead']);
    expect(existsSync(join(dir, 'ses_dead.json'))).toBe(false);
    expect(existsSync(join(dir, 'inst-dead.sock'))).toBe(false);
  });

  it('sweeps a dead socket that has no registry files at all', async () => {
    // The --continue-then-kill-9 case: bound a socket, never advertised.
    writeFileSync(join(dir, 'inst-silent.sock'), '');
    const swept = await sweepOrphans(dir, 'inst-self', async () => false);
    expect(swept).toEqual(['inst-silent']);
    expect(existsSync(join(dir, 'inst-silent.sock'))).toBe(false);
  });

  it('leaves a live sibling instance completely alone', async () => {
    await writeRecord(dir, recFor('ses_live', 'inst-live'));
    writeFileSync(join(dir, 'inst-live.sock'), '');
    const swept = await sweepOrphans(dir, 'inst-self', async () => true);
    expect(swept).toEqual([]);
    expect(existsSync(join(dir, 'ses_live.json'))).toBe(true);
    expect(existsSync(join(dir, 'inst-live.sock'))).toBe(true);
  });

  it('never sweeps our own instance, even when the probe says dead', async () => {
    await writeRecord(dir, recFor('ses_mine', 'inst-self'));
    writeFileSync(join(dir, 'inst-self.sock'), '');
    const swept = await sweepOrphans(dir, 'inst-self', async () => false);
    expect(swept).toEqual([]);
    expect(existsSync(join(dir, 'ses_mine.json'))).toBe(true);
    expect(existsSync(join(dir, 'inst-self.sock'))).toBe(true);
  });

  it('removes an orphan record whose socket file is already gone', async () => {
    await writeRecord(dir, recFor('ses_dead', 'inst-gone'));
    const swept = await sweepOrphans(dir, 'inst-self', async () => false);
    expect(swept).toEqual(['inst-gone']);
    expect(existsSync(join(dir, 'ses_dead.json'))).toBe(false);
  });

  it('returns an empty list for an empty or missing directory', async () => {
    await expect(sweepOrphans(dir, 'inst-self', async () => false)).resolves.toEqual([]);
    await expect(sweepOrphans(join(dir, 'nope'), 'inst-self', async () => false)).resolves.toEqual([]);
  });

  it('ignores unparseable files rather than throwing', async () => {
    writeFileSync(join(dir, 'ses_junk.json'), 'not json');
    await expect(sweepOrphans(dir, 'inst-self', async () => false)).resolves.toEqual([]);
    expect(existsSync(join(dir, 'ses_junk.json'))).toBe(true);
  });

  it('probes each distinct instance only once', async () => {
    await writeRecord(dir, recFor('ses_1', 'inst-dead'));
    await writeRecord(dir, recFor('ses_2', 'inst-dead'));
    writeFileSync(join(dir, 'inst-dead.sock'), '');
    let probes = 0;
    await sweepOrphans(dir, 'inst-self', async () => { probes += 1; return false; });
    expect(probes).toBe(1);
  });

  it('treats a throwing probe as dead', async () => {
    writeFileSync(join(dir, 'inst-boom.sock'), '');
    const swept = await sweepOrphans(dir, 'inst-self', async () => { throw new Error('probe blew up'); });
    expect(swept).toEqual(['inst-boom']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/opencode/test/registry.test.ts`
Expected: FAIL — `sweepOrphans` is not exported from `../tincan-lib/registry.js`.

- [ ] **Step 3: Write minimal implementation**

Append to `plugins/opencode/tincan-lib/registry.ts`:

```ts
/**
 * Delete the socket and registry files of every instance whose socket refuses
 * a connection. The instance id is fresh on every load, so without this a
 * `kill -9` leaves files nobody will ever reclaim. SPEC §6.
 *
 * Sockets are enumerated directly rather than read off records: because the
 * plugin advertises nothing at load (SPEC §5), a crashed instance that never
 * saw a session event leaves a socket with no record pointing at it, and that
 * is the common case, not an edge case.
 */
export async function sweepOrphans(
  dir: string,
  selfInstance: string,
  probe: (socketPath: string) => Promise<boolean>,
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const instances = new Map<string, { files: string[]; socket: string }>();
  const entryFor = (id: string) => {
    let entry = instances.get(id);
    if (!entry) {
      entry = { files: [], socket: join(dir, `${id}.sock`) };
      instances.set(id, entry);
    }
    return entry;
  };

  for (const name of names) {
    if (name.endsWith('.sock')) {
      const id = name.slice(0, -'.sock'.length);
      if (id !== selfInstance) entryFor(id);
      continue;
    }
    if (!name.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(await readFile(join(dir, name), 'utf8')) as RegistryRecord;
      if (typeof rec.instance_id !== 'string' || rec.instance_id === selfInstance) continue;
      entryFor(rec.instance_id).files.push(join(dir, name));
    } catch {
      // Unreadable or unparseable: not ours to delete.
    }
  }

  const swept: string[] = [];
  for (const [instance, entry] of instances) {
    let alive = false;
    try {
      alive = await probe(entry.socket);
    } catch {
      alive = false;
    }
    if (alive) continue;
    for (const file of entry.files) {
      try { await unlink(file); } catch { /* already gone */ }
    }
    try { await unlink(entry.socket); } catch { /* already gone */ }
    swept.push(instance);
  }
  return swept;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/opencode/test/registry.test.ts`
Expected: PASS, 22 tests (13 from Task 5 plus 9 new).

- [ ] **Step 5: Commit**

```bash
git add plugins/opencode/tincan-lib/registry.ts plugins/opencode/test/registry.test.ts
git commit -m "feat(opencode): sweep sockets and files of crashed instances"
```

---

## Task 10: The inbound line handler

The whole delivery path from bytes to injection, isolated from plugin startup so it can be tested without binding a socket or standing up the rest of the plugin.

**Files:**
- Create: `plugins/opencode/tincan-lib/plugin.ts`
- Create: `plugins/opencode/test/line-handler.test.ts`

**Interfaces:**
- Consumes: `parseLine` from `../tincan-lib/wire.js`, `deliver` from `../tincan-lib/delivery.js`, `Logger` from `../tincan-lib/log.js`.
- Produces: `makeLineHandler(deps: LineHandlerDeps): (line: string) => Promise<void>`, interface `LineHandlerDeps { transport: Transport; known: Map<string, RegistryRecord>; sent: Set<string>; log: Logger }`.

- [ ] **Step 1: Write the failing test**

Create `plugins/opencode/test/line-handler.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeLineHandler } from '../tincan-lib/plugin.js';
import { makeLogger } from '../tincan-lib/log.js';
import type { RegistryRecord, Transport } from '../tincan-lib/types.js';

const envelope = '<peer_message from="billing-api" id="msg_01J8">\nDo the thing.\n</peer_message>';
const line = (over: Record<string, unknown> = {}) => JSON.stringify({
  to_session: 'ses_a',
  message_from: 'billing-api',
  text: envelope,
  delivery: 'queue',
  message_id: 'msg_01J8TESTAAAAAAAAAAAAAAAA',
  ...over,
});

const record: RegistryRecord = {
  session_id: 'ses_a', slug: 'nimble-wizard', title: 't', directory: '/repo',
  state: 'idle', socket: '/s.sock', instance_id: 'inst-self', pid: 1,
  plugin_version: '1.0.0', opencode_version: '1.18.31', updated_at: '2026-09-19T14:02:11Z',
};

const admitted = { response: { status: 200 }, data: { data: { admittedSeq: 16 } } };

let logs: string[];
let known: Map<string, RegistryRecord>;
let sent: Set<string>;

beforeEach(() => {
  logs = [];
  known = new Map([['ses_a', record]]);
  sent = new Set();
});

function harness(post: ReturnType<typeof vi.fn>) {
  const transport = { post, get: vi.fn() } as unknown as Transport;
  return makeLineHandler({ transport, known, sent, log: makeLogger((l) => logs.push(l)) });
}

describe('makeLineHandler', () => {
  it('delivers a well-formed line for a known session', async () => {
    const post = vi.fn().mockResolvedValue(admitted);
    await harness(post)(line());
    expect(post).toHaveBeenCalledWith({
      url: '/api/session/ses_a/prompt',
      body: { prompt: { text: envelope }, delivery: 'queue', id: 'msg_01J8TESTAAAAAAAAAAAAAAAA' },
    });
    expect(logs.join('\n')).toContain('event=delivered');
  });

  it('drops a line for a session it never heard announced, without calling the transport', async () => {
    const post = vi.fn();
    await harness(post)(line({ to_session: 'ses_unknown' }));
    expect(post).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('detail=unknown session');
  });

  it('drops malformed JSON without calling the transport', async () => {
    const post = vi.fn();
    await harness(post)('{"to_session":');
    expect(post).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('detail=malformed json');
  });

  it('drops a bad message id without calling the transport', async () => {
    const post = vi.fn();
    await harness(post)(line({ message_id: 'nope' }));
    expect(post).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('detail=bad message_id');
  });

  it('logs the second send of one id as a replay', async () => {
    const handle = harness(vi.fn().mockResolvedValue(admitted));
    await handle(line());
    await handle(line());
    expect(logs.filter((l) => l.includes('event=replay'))).toHaveLength(1);
  });

  it('logs a 404 as rejected with its status and tag', async () => {
    const post = vi.fn().mockResolvedValue({
      response: { status: 404 },
      error: { _tag: 'SessionNotFoundError', message: 'Session not found: ses_a' },
    });
    await harness(post)(line());
    const out = logs.join('\n');
    expect(out).toContain('event=rejected');
    expect(out).toContain('status=404');
    expect(out).toContain('detail=SessionNotFoundError');
  });

  it('logs a 200-with-HTML as a broken transport, not a delivery', async () => {
    const post = vi.fn().mockResolvedValue({ response: { status: 200 }, data: '<!doctype html>' });
    await harness(post)(line());
    expect(logs.join('\n')).toContain('event=transport-broken');
    expect(logs.join('\n')).not.toContain('event=delivered');
  });

  it('never throws, even when the transport rejects', async () => {
    const post = vi.fn().mockRejectedValue(new Error('socket closed'));
    await expect(harness(post)(line())).resolves.toBeUndefined();
  });

  it('never writes message text to the log on any path', async () => {
    const secret = 'TOP SECRET BODY';
    for (const post of [
      vi.fn().mockResolvedValue(admitted),
      vi.fn().mockResolvedValue({ response: { status: 404 }, error: { _tag: 'SessionNotFoundError', message: 'x' } }),
      vi.fn().mockRejectedValue(new Error('boom')),
    ]) {
      await harness(post)(line({ text: secret }));
    }
    await harness(vi.fn())(line({ text: secret, delivery: 'urgent' }));
    expect(logs.join('\n')).not.toContain('TOP SECRET');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/opencode/test/line-handler.test.ts`
Expected: FAIL — "Cannot find module '../tincan-lib/plugin.js'".

- [ ] **Step 3: Write minimal implementation**

Create `plugins/opencode/tincan-lib/plugin.ts`:

```ts
import { deliver } from './delivery.js';
import type { Logger } from './log.js';
import type { RegistryRecord, Transport } from './types.js';
import { parseLine } from './wire.js';

export interface LineHandlerDeps {
  transport: Transport;
  /** Sessions this process heard announced. Anything else is not addressable. */
  known: Map<string, RegistryRecord>;
  sent: Set<string>;
  log: Logger;
}

export function makeLineHandler(deps: LineHandlerDeps): (line: string) => Promise<void> {
  return async (line: string): Promise<void> => {
    try {
      const parsed = parseLine(line);
      if (!parsed.ok) {
        deps.log({ event: 'dropped', detail: parsed.reason });
        return;
      }
      const msg = parsed.message;
      if (!deps.known.has(msg.to_session)) {
        deps.log({
          event: 'dropped',
          session: msg.to_session,
          from: msg.message_from,
          message_id: msg.message_id,
          detail: 'unknown session',
        });
        return;
      }
      const outcome = await deliver(deps.transport, msg, deps.sent);
      deps.log({
        event: outcome.kind === 'delivered' ? (outcome.replay ? 'replay' : 'delivered') : outcome.kind,
        session: msg.to_session,
        from: msg.message_from,
        delivery: msg.delivery,
        message_id: msg.message_id,
        status: outcome.kind === 'rejected' ? outcome.status : undefined,
        detail:
          outcome.kind === 'rejected' ? outcome.tag
          : outcome.kind === 'transport-broken' ? outcome.detail
          : undefined,
      });
    } catch (e) {
      // Nothing here may reach the host. SPEC §8.1.
      deps.log({ event: 'handler.failed', detail: String(e) });
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/opencode/test/line-handler.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/opencode/tincan-lib/plugin.ts plugins/opencode/test/line-handler.test.ts
git commit -m "feat(opencode): inbound line handler with drop-and-log semantics"
```

---

## Task 11: Plugin startup, event wiring and the entry point

The startup self-check makes a future opencode change degrade to "no opencode peers" rather than a crash or a lie.

**Files:**
- Modify: `plugins/opencode/tincan-lib/plugin.ts` (append `startPlugin`)
- Create: `plugins/opencode/test/plugin.test.ts`
- Create: `plugins/opencode/tincan.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–10.
- Produces: `startPlugin(deps: PluginDeps): Promise<PluginHooks>`, interfaces `PluginDeps { dir; instanceId; pid; transport; now; sink }` and `PluginHooks { event; dispose }`.

- [ ] **Step 1: Write the failing test**

Create `plugins/opencode/test/plugin.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPlugin, type PluginDeps } from '../tincan-lib/plugin.js';
import type { Transport, TransportResponse } from '../tincan-lib/types.js';

const info = { id: 'ses_a', slug: 'nimble-wizard', title: 'auth refactor', directory: '/repo', version: '1.18.31' };
const healthy: TransportResponse = { response: { status: 200 }, data: { data: [], cursor: {} } };

let dir: string;
let logs: string[];
let tick: number;

/** An ADVANCING clock. With a frozen one, a redundant rewrite produces
 *  byte-identical output and the no-op test proves nothing. */
const clock = () => new Date(Date.UTC(2026, 8, 19, 14, 2, 11 + tick++));

function deps(over: Partial<PluginDeps> = {}): PluginDeps {
  return {
    dir,
    instanceId: 'inst-self',
    pid: 4242,
    transport: { get: vi.fn().mockResolvedValue(healthy), post: vi.fn() } as unknown as Transport,
    now: clock,
    sink: (l) => logs.push(l),
    ...over,
  };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-plug-')); logs = []; tick = 0; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('startPlugin — startup self-check', () => {
  it('binds the socket when GET /api/session is healthy', async () => {
    const d = deps();
    const hooks = await startPlugin(d);
    expect(d.transport.get).toHaveBeenCalledWith({ url: '/api/session' });
    expect(existsSync(join(dir, 'inst-self.sock'))).toBe(true);
    await hooks.dispose();
  });

  it('binds nothing and advertises nothing when the self-check returns HTML', async () => {
    const d = deps({ transport: { get: vi.fn().mockResolvedValue({ response: { status: 200 }, data: '<!doctype html>' }), post: vi.fn() } as unknown as Transport });
    const hooks = await startPlugin(d);
    expect(existsSync(join(dir, 'inst-self.sock'))).toBe(false);
    await hooks.event({ type: 'session.created', properties: { info } });
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(false);
    await hooks.dispose();
  });

  it('binds nothing when the transport throws', async () => {
    const d = deps({ transport: { get: vi.fn().mockRejectedValue(new Error('gone')), post: vi.fn() } as unknown as Transport });
    const hooks = await startPlugin(d);
    expect(existsSync(join(dir, 'inst-self.sock'))).toBe(false);
    await hooks.dispose();
  });
});

describe('startPlugin — registry lifecycle', () => {
  it('writes nothing on load, because a resumed session is never announced', async () => {
    const hooks = await startPlugin(deps());
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(false);
    await hooks.dispose();
  });

  it('writes a record on session.created', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ type: 'session.created', properties: { info } });
    const rec = JSON.parse(readFileSync(join(dir, 'ses_a.json'), 'utf8'));
    expect(rec.slug).toBe('nimble-wizard');
    expect(rec.state).toBe('idle');
    expect(rec.instance_id).toBe('inst-self');
    expect(rec.pid).toBe(4242);
    expect(rec.opencode_version).toBe('1.18.31');
    await hooks.dispose();
  });

  it('flips state to busy then back to idle', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ type: 'session.created', properties: { info } });
    await hooks.event({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'busy' } } });
    expect(JSON.parse(readFileSync(join(dir, 'ses_a.json'), 'utf8')).state).toBe('busy');
    await hooks.event({ type: 'session.idle', properties: { sessionID: 'ses_a' } });
    expect(JSON.parse(readFileSync(join(dir, 'ses_a.json'), 'utf8')).state).toBe('idle');
    await hooks.dispose();
  });

  it('ignores a state event for a session it never heard announced', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ type: 'session.status', properties: { sessionID: 'ses_unknown', status: { type: 'busy' } } });
    expect(existsSync(join(dir, 'ses_unknown.json'))).toBe(false);
    await hooks.dispose();
  });

  it('removes the record on session.deleted', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ type: 'session.created', properties: { info } });
    await hooks.event({ type: 'session.deleted', properties: { info } });
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(false);
    await hooks.dispose();
  });

  it('does not rewrite the file when nothing but the clock changed', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ type: 'session.created', properties: { info } });
    const first = readFileSync(join(dir, 'ses_a.json'), 'utf8');
    await hooks.event({ type: 'session.updated', properties: { info } });
    // The clock advanced between the two events, so a rewrite WOULD change
    // updated_at. Identical bytes therefore prove the write was skipped.
    expect(readFileSync(join(dir, 'ses_a.json'), 'utf8')).toBe(first);
    await hooks.dispose();
  });

  it('rewrites the file when the title changes', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ type: 'session.created', properties: { info } });
    const first = readFileSync(join(dir, 'ses_a.json'), 'utf8');
    await hooks.event({ type: 'session.updated', properties: { info: { ...info, title: 'PONG' } } });
    const after = readFileSync(join(dir, 'ses_a.json'), 'utf8');
    expect(after).not.toBe(first);
    expect(JSON.parse(after).title).toBe('PONG');
    await hooks.dispose();
  });

  it('never throws out of the event hook on a malformed event', async () => {
    const hooks = await startPlugin(deps());
    await expect(hooks.event(null)).resolves.toBeUndefined();
    await expect(hooks.event({ type: 'session.created', properties: {} })).resolves.toBeUndefined();
    await hooks.dispose();
  });
});

describe('startPlugin — dispose', () => {
  it('removes this instance’s records and the socket', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ type: 'session.created', properties: { info } });
    await hooks.dispose();
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(false);
    expect(existsSync(join(dir, 'inst-self.sock'))).toBe(false);
  });

  it('is safe to call when startup never bound anything', async () => {
    const d = deps({ transport: { get: vi.fn().mockRejectedValue(new Error('gone')), post: vi.fn() } as unknown as Transport });
    const hooks = await startPlugin(d);
    await expect(hooks.dispose()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/opencode/test/plugin.test.ts`
Expected: FAIL — `startPlugin` is not exported from `../tincan-lib/plugin.js`.

- [ ] **Step 3: Write minimal implementation**

Append to `plugins/opencode/tincan-lib/plugin.ts`:

```ts
import { effectOf } from './events.js';
import { makeLogger } from './log.js';
import { socketPath } from './paths.js';
import {
  composeRecord, isoStamp, removeAllForInstance, removeRecord,
  sameIgnoringTimestamp, sweepOrphans, writeRecord, type RecordContext,
} from './registry.js';
import { listenLines, probeSocket, type ServerHandle } from './server.js';
import { PLUGIN_VERSION, type SessionState } from './types.js';

export interface PluginDeps {
  dir: string;
  instanceId: string;
  pid: number;
  transport: Transport;
  now: () => Date;
  sink: (line: string) => void;
}

export interface PluginHooks {
  event: (event: unknown) => Promise<void>;
  dispose: () => Promise<void>;
}

async function selfCheck(transport: Transport, log: Logger): Promise<boolean> {
  try {
    const res = await transport.get({ url: '/api/session' });
    if (typeof res.data === 'string') {
      log({ event: 'selfcheck.failed', detail: 'html response' });
      return false;
    }
    if ((res.response?.status ?? 0) !== 200) {
      log({ event: 'selfcheck.failed', status: res.response?.status });
      return false;
    }
    return true;
  } catch (e) {
    log({ event: 'selfcheck.failed', detail: String(e) });
    return false;
  }
}

export async function startPlugin(deps: PluginDeps): Promise<PluginHooks> {
  const log = makeLogger(deps.sink);
  const known = new Map<string, RegistryRecord>();
  const sent = new Set<string>();
  let server: ServerHandle | null = null;

  const sock = socketPath(deps.dir, deps.instanceId);
  const ctx: RecordContext = {
    socket: sock,
    instance_id: deps.instanceId,
    pid: deps.pid,
    plugin_version: PLUGIN_VERSION,
    now: deps.now,
  };

  const handleLine = makeLineHandler({ transport: deps.transport, known, sent, log });

  if (await selfCheck(deps.transport, log)) {
    try {
      const swept = await sweepOrphans(deps.dir, deps.instanceId, probeSocket);
      if (swept.length > 0) log({ event: 'swept', detail: swept.join(',') });
      server = await listenLines({
        path: sock,
        onLine: (line) => { void handleLine(line); },
        onError: (e) => log({ event: 'socket.error', detail: String(e) }),
      });
      log({ event: 'bound', detail: sock });
    } catch (e) {
      log({ event: 'bind.failed', detail: String(e) });
      server = null;
    }
  }

  /** Write only when something other than the timestamp changed: session.updated
   *  fires repeatedly while the model rewrites the title. SPEC §5. */
  const apply = async (sessionID: string, state: SessionState, incoming?: RegistryRecord): Promise<void> => {
    const base = incoming ?? known.get(sessionID);
    if (!base) return; // Never announced, so not addressable. SPEC §5.
    const candidate: RegistryRecord = { ...base, state, updated_at: isoStamp(ctx.now()) };
    const prev = known.get(sessionID);
    if (prev && sameIgnoringTimestamp(prev, candidate)) return;
    known.set(sessionID, candidate);
    await writeRecord(deps.dir, candidate);
  };

  return {
    event: async (event: unknown): Promise<void> => {
      if (!server) return; // Advertising without a delivery path would be a lie.
      try {
        const effect = effectOf(event);
        switch (effect.kind) {
          case 'upsert': {
            const state = known.get(effect.info.id)?.state ?? 'idle';
            await apply(effect.info.id, state, composeRecord(effect.info, state, ctx));
            return;
          }
          case 'state':
            await apply(effect.sessionID, effect.state);
            return;
          case 'remove':
            known.delete(effect.sessionID);
            await removeRecord(deps.dir, effect.sessionID);
            return;
          default:
            return;
        }
      } catch (e) {
        log({ event: 'event.failed', detail: String(e) });
      }
    },

    dispose: async (): Promise<void> => {
      try {
        await removeAllForInstance(deps.dir, deps.instanceId);
        if (server) await server.close();
      } catch (e) {
        log({ event: 'dispose.failed', detail: String(e) });
      }
    },
  };
}
```

Then widen the existing import at the top of the file so the shared types are available:

```ts
import type { Logger } from './log.js';
import type { RegistryRecord, Transport } from './types.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/opencode/test/plugin.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Write the globbed entry file**

Create `plugins/opencode/tincan.ts`:

```ts
/**
 * Tin Can — opencode plugin.
 *
 * WARNING: opencode's loader invokes EVERY exported function in this file as a
 * plugin, and does not descend into subdirectories. Export exactly one thing,
 * and never a `default`. All logic lives in ./tincan-lib/. See SPEC.md §2.
 */
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { newInstanceId, peersDir } from './tincan-lib/paths.js';
import { startPlugin } from './tincan-lib/plugin.js';
import type { Transport } from './tincan-lib/types.js';

export const TinCan = async (input: { client: { _client?: unknown } }) => {
  const sink = (line: string) => { console.error(line); };
  // The only private-field dependency in the plugin. SPEC §3 explains why it
  // is unavoidable; the self-check inside startPlugin turns a future breakage
  // into "no opencode peers" rather than a crash.
  const transport = input.client?._client;

  if (!transport || typeof (transport as { post?: unknown }).post !== 'function') {
    sink('[tincan] event=selfcheck.failed detail=no transport on client._client');
    return {};
  }

  return startPlugin({
    dir: peersDir(process.env, homedir()),
    instanceId: newInstanceId(() => randomBytes(3).toString('hex')),
    pid: process.pid,
    transport: transport as Transport,
    now: () => new Date(),
    sink,
  });
};
```

- [ ] **Step 6: Run the full suite and the typecheck**

Run: `npm test && npm run typecheck:plugin`
Expected: every suite passes, typecheck clean.

- [ ] **Step 7: Live smoke test — does the assembled plugin actually load?**

Everything up to here ran against a stubbed transport. Prove the real one before writing the acceptance doc:

```bash
mkdir -p ~/.config/opencode/plugin
cp plugins/opencode/tincan.ts ~/.config/opencode/plugin/
cp -r plugins/opencode/tincan-lib ~/.config/opencode/plugin/
opencode            # send one message, then quit with ctrl-C
ls -la ~/.tincan/peers/opencode/
```

Expected: a `ses_*.json` with a populated `slug` appeared while the session was live, and both it and `inst-*.sock` are gone after the quit. If instead the opencode log shows `event=selfcheck.failed detail=no transport on client._client`, the private `_client` field has moved — stop and re-probe before continuing.

- [ ] **Step 8: Commit**

```bash
git add plugins/opencode/tincan.ts plugins/opencode/tincan-lib/plugin.ts plugins/opencode/test/plugin.test.ts
git commit -m "feat(opencode): plugin startup, event wiring and entry point"
```

---

## Task 12: Caller identity — which session is talking to Tin Can

Tin Can hosted inside opencode as an MCP server needs to exclude *itself* from its own peer list. opencode exports no `OPENCODE_SESSION_ID` into tool subprocesses, and `pid`-ancestry only identifies the *instance* — an instance commonly runs several sessions in one directory, so it cannot narrow to a session. Without this task the Tin Can side must over-exclude every session of the host instance, losing sibling-session addressing.

**Verified:** the `tool.execute.before` hook fires for MCP-provided tools with the calling `sessionID`. A stub MCP server registered as `probe` exposing `probe_ping` produced `{ tool: "probe_probe_ping", sessionID: "ses_…", callID: "call_…" }`. Note the tool id is `<server key>_<tool name>`, and the server key is whatever the *user* wrote in their opencode config — so match on the tool-name suffix, never on a `tincan_` prefix.

**Files:**
- Create: `plugins/opencode/tincan-lib/caller.ts`
- Create: `plugins/opencode/test/caller.test.ts`
- Modify: `plugins/opencode/tincan-lib/plugin.ts` (add the hook to `startPlugin`)
- Modify: `plugins/opencode/test/plugin.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `RecordContext` from `../tincan-lib/registry.js`.
- Produces: `callerFile(dir, instanceID)`, `isTincanTool(toolID)`, `composeCaller(sessionID, toolID, ctx)`, `writeCaller(dir, rec)`, interface `CallerRecord`.

- [ ] **Step 1: Write the failing test**

Create `plugins/opencode/test/caller.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callerFile, isTincanTool, composeCaller, writeCaller } from '../tincan-lib/caller.js';
import type { RecordContext } from '../tincan-lib/registry.js';

const ctx: RecordContext = {
  socket: '/p/inst-a91f.sock',
  instance_id: 'inst-a91f',
  pid: 41233,
  plugin_version: '1.0.0',
  now: () => new Date('2026-09-19T14:02:11.000Z'),
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-caller-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('callerFile', () => {
  it('is named by instance and is distinguishable from a session record', () => {
    expect(callerFile('/p', 'inst-a91f')).toBe('/p/inst-a91f.caller.json');
  });
});

describe('isTincanTool', () => {
  it.each(['tincan_peers', 'tincan_send_peer', 'tincan_message_log'])('matches %s', (t) => {
    expect(isTincanTool(t)).toBe(true);
  });

  it('matches when the user named the MCP server something else', () => {
    // The tool id is `<server key>_<tool name>` and the server key is the
    // user's choice, so the prefix cannot be relied on.
    expect(isTincanTool('tc_send_peer')).toBe(true);
    expect(isTincanTool('my_agents_message_log')).toBe(true);
  });

  it.each(['bash', 'read', 'edit', 'probe_probe_ping', 'other_send_peerage'])('rejects %s', (t) => {
    expect(isTincanTool(t)).toBe(false);
  });

  it('rejects a bare tool name with no server prefix', () => {
    // opencode always prefixes MCP tools, so a bare name is a built-in.
    expect(isTincanTool('peers')).toBe(false);
  });
});

describe('composeCaller', () => {
  it('records the session, the tool, the instance and the pid', () => {
    expect(composeCaller('ses_a', 'tincan_send_peer', ctx)).toEqual({
      instance_id: 'inst-a91f',
      session_id: 'ses_a',
      pid: 41233,
      tool: 'tincan_send_peer',
      at: '2026-09-19T14:02:11Z',
    });
  });
});

describe('writeCaller', () => {
  it('writes readable JSON at the caller path', async () => {
    await writeCaller(dir, composeCaller('ses_a', 'tincan_peers', ctx));
    const onDisk = JSON.parse(readFileSync(join(dir, 'inst-a91f.caller.json'), 'utf8'));
    expect(onDisk.session_id).toBe('ses_a');
    expect(onDisk.pid).toBe(41233);
  });

  it('leaves no temp files behind and overwrites in place', async () => {
    await writeCaller(dir, composeCaller('ses_a', 'tincan_peers', ctx));
    await writeCaller(dir, composeCaller('ses_b', 'tincan_peers', ctx));
    expect(readdirSync(dir)).toEqual(['inst-a91f.caller.json']);
    expect(JSON.parse(readFileSync(join(dir, 'inst-a91f.caller.json'), 'utf8')).session_id).toBe('ses_b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/opencode/test/caller.test.ts`
Expected: FAIL — "Cannot find module '../tincan-lib/caller.js'".

- [ ] **Step 3: Write minimal implementation**

Create `plugins/opencode/tincan-lib/caller.ts`:

```ts
import { join } from 'node:path';
import { isoStamp, writeJsonAtomic, type RecordContext } from './registry.js';

/**
 * Which session is currently talking to Tin Can's MCP server.
 *
 * opencode exports no OPENCODE_SESSION_ID into tool subprocesses, and pid
 * ancestry only identifies the instance. The `tool.execute.before` hook does
 * carry the calling sessionID, so the plugin records it here for Tin Can to
 * read when it needs to exclude itself from its own peer list.
 */
export interface CallerRecord {
  instance_id: string;
  session_id: string;
  pid: number;
  tool: string;
  at: string;
}

/** Distinct from a session record, which is always `ses_*.json`. */
export function callerFile(dir: string, instanceID: string): string {
  return join(dir, `${instanceID}.caller.json`);
}

/**
 * opencode names an MCP tool `<server key>_<tool name>`, and the server key is
 * whatever the user put in their opencode config — `tincan`, `tc`, anything.
 * So match the tool-name suffix, never a prefix. A leading `_` is required, so
 * a built-in called `peers` does not match.
 */
const TINCAN_TOOLS = ['peers', 'send_peer', 'message_log'];

export function isTincanTool(toolID: string): boolean {
  return TINCAN_TOOLS.some((name) => toolID.endsWith(`_${name}`));
}

export function composeCaller(sessionID: string, toolID: string, ctx: RecordContext): CallerRecord {
  return {
    instance_id: ctx.instance_id,
    session_id: sessionID,
    pid: ctx.pid,
    tool: toolID,
    at: isoStamp(ctx.now()),
  };
}

export async function writeCaller(dir: string, rec: CallerRecord): Promise<void> {
  await writeJsonAtomic(callerFile(dir, rec.instance_id), rec);
}
```

This needs one shared helper extracted from `registry.ts`. Replace the body of `writeRecord` there and add the export:

```ts
export async function writeJsonAtomic(finalPath: string, value: unknown): Promise<void> {
  const dir = dirname(finalPath);
  // mkdir's `mode` is ignored when the directory already exists — and Tin Can
  // itself may have created ~/.tincan/peers at 0755. chmod unconditionally, or
  // the 0700 parent that closes the bind-to-chmod race in SPEC §8.3 is a
  // fiction.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = `${finalPath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, finalPath);
}

/** Atomic: temp file in the same directory, then rename. SPEC §4. */
export async function writeRecord(dir: string, rec: RegistryRecord): Promise<void> {
  await writeJsonAtomic(sessionFile(dir, rec.session_id), rec);
}
```

and add `dirname` to the `node:path` import at the top of `registry.ts`:

```ts
import { dirname, join } from 'node:path';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run plugins/opencode/test/caller.test.ts plugins/opencode/test/registry.test.ts`
Expected: PASS — 11 caller tests, and all 22 registry tests still green after the refactor.

- [ ] **Step 5: Write the failing test for the hook wiring**

Append to `plugins/opencode/test/plugin.test.ts`:

```ts
describe('startPlugin — caller identity', () => {
  it('records the session that invoked a Tin Can tool', async () => {
    const hooks = await startPlugin(deps());
    await hooks['tool.execute.before']({ tool: 'tincan_send_peer', sessionID: 'ses_caller', callID: 'c1' });
    const rec = JSON.parse(readFileSync(join(dir, 'inst-self.caller.json'), 'utf8'));
    expect(rec.session_id).toBe('ses_caller');
    expect(rec.instance_id).toBe('inst-self');
    expect(rec.pid).toBe(4242);
    await hooks.dispose();
  });

  it('ignores tools that are not Tin Can’s', async () => {
    const hooks = await startPlugin(deps());
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_other', callID: 'c1' });
    expect(existsSync(join(dir, 'inst-self.caller.json'))).toBe(false);
    await hooks.dispose();
  });

  it('writes nothing when startup never bound anything', async () => {
    const d = deps({ transport: { get: vi.fn().mockRejectedValue(new Error('gone')), post: vi.fn() } as unknown as Transport });
    const hooks = await startPlugin(d);
    await hooks['tool.execute.before']({ tool: 'tincan_peers', sessionID: 'ses_caller', callID: 'c1' });
    expect(existsSync(join(dir, 'inst-self.caller.json'))).toBe(false);
    await hooks.dispose();
  });

  it('never throws on a malformed hook input', async () => {
    const hooks = await startPlugin(deps());
    await expect(hooks['tool.execute.before'](null)).resolves.toBeUndefined();
    await expect(hooks['tool.execute.before']({})).resolves.toBeUndefined();
    await hooks.dispose();
  });

  it('dispose removes the caller file along with the records', async () => {
    const hooks = await startPlugin(deps());
    await hooks['tool.execute.before']({ tool: 'tincan_peers', sessionID: 'ses_caller', callID: 'c1' });
    await hooks.dispose();
    expect(existsSync(join(dir, 'inst-self.caller.json'))).toBe(false);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run plugins/opencode/test/plugin.test.ts`
Expected: FAIL — `hooks['tool.execute.before']` is not a function.

- [ ] **Step 7: Wire the hook into `startPlugin`**

In `plugins/opencode/tincan-lib/plugin.ts`, add the import:

```ts
import { composeCaller, isTincanTool, writeCaller } from './caller.js';
```

extend the hooks interface:

```ts
export interface PluginHooks {
  event: (event: unknown) => Promise<void>;
  'tool.execute.before': (input: unknown) => Promise<void>;
  dispose: () => Promise<void>;
}
```

and add the hook to the returned object, alongside `event`:

```ts
    'tool.execute.before': async (input: unknown): Promise<void> => {
      if (!server) return;
      try {
        const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
        if (typeof i.tool !== 'string' || typeof i.sessionID !== 'string') return;
        if (!isTincanTool(i.tool)) return;
        await writeCaller(deps.dir, composeCaller(i.sessionID, i.tool, ctx));
      } catch (e) {
        log({ event: 'caller.failed', detail: String(e) });
      }
    },
```

`dispose` needs no change: `removeAllForInstance` deletes every `.json` carrying this `instance_id`, and the caller file carries it.

- [ ] **Step 8: Run the full suite and the typecheck**

Run: `npm test && npm run typecheck:plugin`
Expected: all green. `plugin.test.ts` is now 18 tests.

- [ ] **Step 9: Commit**

```bash
git add plugins/opencode/tincan-lib/caller.ts plugins/opencode/tincan-lib/registry.ts plugins/opencode/tincan-lib/plugin.ts plugins/opencode/test/caller.test.ts plugins/opencode/test/plugin.test.ts
git commit -m "feat(opencode): record which session invoked a Tin Can tool"
```

---

## Task 13: Live acceptance against SPEC §10

Unit tests cannot prove that opencode's `event` hook fires, that `dispose` runs, or that an injected message reaches a real agent. This is the manual pass.

**Files:**
- Create: `plugins/opencode/test/acceptance.md`
- Create: `plugins/opencode/test/send.py`

- [ ] **Step 1: Write the sender**

`nc -U` behaves inconsistently across macOS builds. Create `plugins/opencode/test/send.py`:

```python
#!/usr/bin/env python3
"""Send one Tin Can wire line to an opencode instance socket.

Usage: send.py <socket> <session-id> <message-id> [text]
"""
import json
import socket
import sys

sock_path, session, message_id = sys.argv[1], sys.argv[2], sys.argv[3]
text = sys.argv[4] if len(sys.argv) > 4 else (
    f'<peer_message from="acceptance" id="{message_id}">\n'
    'Reply with exactly the word GOLDFISH and nothing else.\n'
    '</peer_message>'
)

payload = json.dumps({
    "to_session": session,
    "message_from": "acceptance",
    "text": text,
    "delivery": "queue",
    "message_id": message_id,
})

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sock_path)
s.sendall((payload + "\n").encode())
s.close()
print(f"sent {message_id} -> {session}")
```

- [ ] **Step 2: Write the acceptance checklist**

Create `plugins/opencode/test/acceptance.md`:

````markdown
# Live acceptance — SPEC §10

Verified target: **opencode 1.18.31**.

## Install

```bash
mkdir -p ~/.config/opencode/plugin
cp plugins/opencode/tincan.ts ~/.config/opencode/plugin/
cp -r plugins/opencode/tincan-lib ~/.config/opencode/plugin/
```

`tincan.ts` must sit **directly** in `plugin/` — the loader globs one level only,
so a nested `plugin/tincan/tincan.ts` would never load, while `plugin/tincan-lib/`
is correctly ignored.

## Checks

Record pass/fail for each. Do not mark the task complete with a failing row.

1. **Registry file appears.** Start a plain `opencode`, send one message.
   A `~/.tincan/peers/opencode/ses_*.json` appears within a second, with `slug`
   populated and `state` set.

2. **Injection lands.** From another shell, with `SES` and `SOCK` taken from that
   file:
   `python3 plugins/opencode/test/send.py "$SOCK" "$SES" msg_acceptance0000000001`
   The enveloped text appears in the session's context and the agent acts on it.

3. **State flips.** While the agent works, `state` reads `busy`; after it
   finishes, `idle`.

4. **Clean exit clears up.** Quit with `q`, then repeat and quit with ctrl-C.
   Both times the registry file and the socket are gone.

5. **`kill -9` leaves a refused socket.** Files remain, and
   `python3 plugins/opencode/test/send.py "$SOCK" "$SES" msg_x` fails with
   connection refused.

6. **Next start sweeps the orphan.** Start any new opencode instance; the files
   and socket left by check 5 are gone.

7. **Silent crash is swept too.** `opencode --continue`, do **not** type, then
   `kill -9`. A socket file remains with no `.json` beside it. Start a new
   instance; the socket is gone. (This is the case a record-driven sweep would
   miss.)

8. **`--continue` advertises nothing until active.** `opencode --continue` and do
   not type: no registry file. Expected behaviour per SPEC §5, not a bug.

9. **…then it appears.** Send one message in that resumed session; the registry
   file appears and is correct.

10. **Socket permissions.** `stat -f %Sp` on the socket reads `srw-------`, and
    `stat -f %Sp` on `~/.tincan/peers/opencode` reads `drwx------`.

11. **No message text in logs.** Search opencode's log for a distinctive string
    from check 2's envelope. No match.

12. **Caller identity.** With Tin Can registered as an MCP server in this
    opencode (see the Change Notice §5), invoke any Tin Can tool from the
    session. `~/.tincan/peers/opencode/inst-*.caller.json` appears, its
    `session_id` matches the session that made the call, and its `pid` is the
    opencode process. Quit; the file is gone.
````

- [ ] **Step 3: Run the checklist**

Work through all twelve checks against a real TUI. Record failures as issues.

- [ ] **Step 4: Commit**

```bash
git add plugins/opencode/test/acceptance.md plugins/opencode/test/send.py
git commit -m "test(opencode): live acceptance checklist and wire sender"
```

---

## Task 14: README

**Files:**
- Create: `plugins/opencode/README.md`

- [ ] **Step 1: Write the README**

Create `plugins/opencode/README.md` covering, in this order:

1. **What it does** — one paragraph, plus the fact that without it there are no opencode peers.
2. **Requirements** — opencode **1.18.31** (verified; other versions untested), Tin Can 0.4.0+.
3. **Install** — copy `tincan.ts` to `~/.config/opencode/plugin/tincan.ts` and `tincan-lib/` to `~/.config/opencode/plugin/tincan-lib/`. Explain that the loader globs one level only: that is why `tincan.ts` must sit directly in `plugin/`, why `tincan-lib/` is safely ignored, and why the helper directory is name-spaced rather than called `lib/` — `plugin/` is shared with every other opencode plugin. Note `plugins/` is an equally valid directory name.
4. **Verify** — start opencode, send a message, confirm a file appears in `~/.tincan/peers/opencode/`.
5. **Uninstall** — delete both paths, then `rm -rf ~/.tincan/peers/opencode`.
6. **Troubleshooting**, as a table:
   - *No files appear* → check the opencode log for `event=selfcheck.failed`; likely an opencode version change moved `client._client`.
   - *No file after `--continue`* → expected; send one message. Link SPEC §5.
   - *`event=bind.failed detail=socket path too long`* → `TINCAN_HOME` is too deep; macOS caps the path near 103 bytes.
   - *Messages accepted but nothing happens* → `event=transport-broken detail=html response`; the `/api/` prefix was lost.
   - *Stale peers listed in Tin Can* → an instance was `kill -9`'d; the next opencode start sweeps them.
7. **Known limits** — replay detection is per-process, so after an opencode restart a re-sent `message_id` logs as a fresh delivery even though opencode still de-duplicates it; the log wording is approximate, the behaviour is not.
8. **What it deliberately does not do** — no outbound send path, no rate limiting, no message logging, no `/tui/append-prompt`. Link SPEC §11.

- [ ] **Step 2: Commit**

```bash
git add plugins/opencode/README.md
git commit -m "docs(opencode): plugin install and troubleshooting guide"
```

---

## Self-review notes

**Spec coverage.** §1 → Tasks 11, 13. §2 layout and export shape → Tasks 1, 11. §3 transport, `/api/` prefix, HTML guard, self-check → Tasks 7, 10, 11. §4 registry layout, atomic write, socket mode, directory mode, path cap → Tasks 3, 5, 8. §5 events, status mapping, no-op detection, advertise-nothing-on-load → Tasks 6, 11. §6 liveness probe, orphan sweep → Tasks 8, 9. §7 wire format, five rules → Tasks 4, 7, 10. §8 all six non-negotiables → Tasks 2 (logging), 5 (atomic, 0700), 8 (0600, never crash), 10 (drop-and-log), 11 (wiring); §8.5 and §8.6 are satisfied by omission and asserted in Task 14's README. §9 test list → Tasks 2–12. §10 → Task 13. §11 → Task 14. §12 open questions → Task 14 §7 records the one that affects users. Change Notice §4 self-exclusion → Task 12.

**Accepted limitations, recorded rather than fixed.**

1. *Replay detection is per-process.* `sent` is an in-memory `Set`, so after an opencode restart a re-sent `message_id` logs as a fresh delivery even though opencode returns the existing row. Affects log wording only; opencode's idempotency still does the real work. Documented in the README.
2. *`sameIgnoringTimestamp` compares `JSON.stringify` output*, so it depends on key order. Every record is built through `composeRecord` or a spread of one, so order is stable today. If a second construction path ever appears, switch to a field-by-field comparison.
3. *No end-to-end test of an over-long `TINCAN_HOME`.* Task 8 covers the `listenLines` rejection and Task 11 covers `bind.failed` being logged, but no test drives a genuinely >103-byte path through `startPlugin` — `mkdtemp` paths are already long on macOS and the combination is fragile. Row 3 of Task 14's troubleshooting table documents the behaviour.

**Deliberate ordering.** The live smoke test is Task 11 Step 7, not Task 13, so a wiring mistake against the real `client._client` surfaces before anyone invests in the full acceptance pass.
