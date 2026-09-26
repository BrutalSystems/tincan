import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSendArgs,
  exitCodeFor,
  sendCliLine,
  USAGE_EXIT,
  MAX_FROM_LENGTH,
} from '../src/send-cli.js';
import type { SendPeerResult } from '../src/tools.js';

/**
 * The contract birddog is building against, pinned here because it is a
 * contract with a caller that cannot read our prose: a Go binary parses one
 * JSON line and branches on `refusal`. Every test in this file exists because
 * birddog named the case, and the comment says which promise it holds.
 */
describe('send CLI argument parsing', () => {
  const good = ['--to', 'muster-59', '--from', 'bd-8bcbebb485fa', '--message', 'disk 91%'];

  test('accepts the documented invocation', () => {
    const r = parseSendArgs(good);
    expect(r.ok).toBe(true);
    // Narrows past the `help` variant of the union, which carries no args.
    if (!r.ok || r.help === true) return;
    expect(r.args).toMatchObject({
      to: 'muster-59',
      from: 'bd-8bcbebb485fa',
      message: 'disk 91%',
    });
    // Absent rather than empty: an idempotency key the caller did not give
    // must not become a key it did.
    expect(r.args.idempotencyKey).toBeUndefined();
    expect(r.args.replyVia).toBeUndefined();
  });

  test('carries the optional idempotency key and reply hint', () => {
    const r = parseSendArgs([
      ...good,
      '--idempotency-key',
      'bd-8bcbebb485fa:7:disk',
      '--reply-via',
      'birddog ack --instance bd-8bcbebb485fa --incident 7',
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok || r.help === true) return;
    expect(r.args.idempotencyKey).toBe('bd-8bcbebb485fa:7:disk');
    expect(r.args.replyVia).toBe('birddog ack --instance bd-8bcbebb485fa --incident 7');
  });

  test.each([
    ['--to', ['--from', 'bd-1', '--message', 'x']],
    ['--from', ['--to', 'muster-59', '--message', 'x']],
    ['--message', ['--to', 'muster-59', '--from', 'bd-1']],
  ])('refuses a call with no %s', (missing, argv) => {
    const r = parseSendArgs(argv);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(missing);
  });

  test('refuses an empty message rather than sending a blank alert', () => {
    const r = parseSendArgs(['--to', 'muster-59', '--from', 'bd-1', '--message', '']);
    expect(r.ok).toBe(false);
  });

  test('refuses a flag it does not know instead of ignoring it', () => {
    // An ignored flag is the failure mode classifyArgv exists to prevent, one
    // level down: `--urgent` silently dropped looks like a delivered urgent.
    const r = parseSendArgs([...good, '--urgent']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('--urgent');
  });

  test('refuses a flag given without a value', () => {
    const r = parseSendArgs(['--to', 'muster-59', '--from', 'bd-1', '--message']);
    expect(r.ok).toBe(false);
  });
});

/**
 * birddog: "don't slugify silently, refuse instead, because a silently-rewritten
 * sender name is a wrong address that looks right." The name goes in the
 * envelope's `from=`, and `assignNames` slugifies every name it shows, so a
 * `from=` that is not already slug-shaped is an address no peer can type back.
 */
describe('--from is refused rather than rewritten', () => {
  test.each([
    ['an uppercase name', 'BD-8bcbebb485fa'],
    ['a name with spaces', 'bird dog'],
    ['a name with an underscore', 'bird_dog'],
    ['a leading hyphen', '-birddog'],
    ['a trailing hyphen', 'birddog-'],
    ['a name with a quote', 'bird"dog'],
    ['an empty name', ''],
  ])('refuses %s', (_why, from) => {
    const r = parseSendArgs(['--to', 'muster-59', '--from', from, '--message', 'x']);
    expect(r.ok, `${from} should be refused, not rewritten`).toBe(false);
  });

  test('refuses a name longer than the cap instead of truncating it', () => {
    const from = 'b'.repeat(MAX_FROM_LENGTH + 1);
    const r = parseSendArgs(['--to', 'muster-59', '--from', from, '--message', 'x']);
    expect(r.ok).toBe(false);
  });

  test('accepts the slug shapes a harness-less sender actually uses', () => {
    for (const from of ['birddog', 'bd-8bcbebb485fa', 'bd1', 'a', 'b'.repeat(MAX_FROM_LENGTH)]) {
      expect(parseSendArgs(['--to', 'm', '--from', from, '--message', 'x']).ok, from).toBe(true);
    }
  });
});

/**
 * "A non-zero exit must still print the JSON line. If JSON only appears on
 * success, birddog cannot tell peer_unknown from delivery_failed, and those map
 * to opposite behaviours." This is the single condition birddog called most
 * important, so it is asserted on the refusal and failure paths, not just the
 * happy one.
 */
describe('the JSON line', () => {
  const parse = (r: SendPeerResult) => JSON.parse(sendCliLine(r)) as Record<string, unknown>;

  test('is exactly one line with no trailing newline of its own', () => {
    const line = sendCliLine({ outcome: 'accepted', message_id: 'msg_1', peer_state: 'idle' });
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toBeTypeOf('object');
  });

  test('carries the four fields birddog reads, and nothing else', () => {
    const got = parse({
      outcome: 'accepted',
      message_id: 'msg_1',
      peer_state: 'busy',
      method: 'inbox',
      detail: 'prose a Go caller must never need',
      notice: 'also not part of the contract',
    });
    expect(got).toEqual({
      outcome: 'accepted',
      message_id: 'msg_1',
      peer_state: 'busy',
    });
  });

  test('carries the refusal verbatim from the enum on a rejection', () => {
    const got = parse({ outcome: 'rejected', refusal: 'peer_unknown', detail: 'no such peer' });
    expect(got.outcome).toBe('rejected');
    expect(got.refusal).toBe('peer_unknown');
  });

  test('distinguishes a peer that never resolved from one that would not take it', () => {
    // The two birddog maps to opposite behaviours: NoRecipient sends the
    // operator to the configuration, Failed retries the transport.
    expect(parse({ outcome: 'rejected', refusal: 'peer_unknown' }).refusal).toBe('peer_unknown');
    expect(parse({ outcome: 'failed', refusal: 'delivery_failed' }).refusal).toBe(
      'delivery_failed',
    );
  });

  test('omits a field it has no value for rather than emitting null', () => {
    // `json.Unmarshal` into a string field turns null into "", which reads as
    // a refusal code of "" rather than as no refusal at all.
    const got = parse({ outcome: 'accepted', message_id: 'msg_1' });
    expect('refusal' in got).toBe(false);
    expect('peer_state' in got).toBe(false);
  });
});

/**
 * "Exit code carrying only accepted/rejected/failed is fine and I won't depend
 * on it." Pinned anyway: the mapping is part of the published contract, and a
 * silent change to it would break a caller that did come to depend on it.
 */
describe('exit codes', () => {
  test('maps the three outcomes onto three distinct codes', () => {
    expect(exitCodeFor('accepted')).toBe(0);
    expect(exitCodeFor('failed')).toBe(1);
    expect(exitCodeFor('rejected')).toBe(2);
  });

  test('keeps a usage error out of the outcome codes', () => {
    // A malformed command line is not a send outcome: nothing was attempted,
    // there is no message_id, and no Refusal in the enum describes it. It gets
    // its own code so a caller never reads it as a peer problem.
    expect(USAGE_EXIT).toBe(64);
    expect([0, 1, 2]).not.toContain(USAGE_EXIT);
  });
});

/**
 * The contract's one condition that a unit test cannot establish: what a real
 * process actually puts on its two streams.
 *
 * birddog calls this the single most important thing — "if JSON only appears on
 * success, birddog cannot tell peer_unknown from delivery_failed, and those map
 * to opposite behaviours." A stray diagnostic on stdout, or a JSON line skipped
 * on the failure path, is invisible to every test above and fatal to the caller.
 *
 * Spawns `dist/tincan.js` the way a Go binary would, so it also proves the thing
 * the whole subcommand exists for: that this works with no harness in the
 * environment at all.
 */
describe('the built binary, run as a harness-less process would run it', () => {
  const run = (args: string[]): Promise<{ code: number; out: string; err: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [join(process.cwd(), 'dist', 'tincan.js'), ...args], {
        // No CLAUDE_CODE_MESSAGING_SOCKET, no OPENCODE, no harness of any kind —
        // and a HOME of its own so it cannot find this machine's real sessions.
        env: { PATH: process.env.PATH ?? '', HOME: home, TINCAN_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    });

  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tincan-sendcli-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test('prints one JSON line on stdout when the peer does not exist', async () => {
    // The failure path, which is the one that matters: an empty machine means
    // the address cannot resolve, so this exercises "non-zero exit still prints".
    const r = await run([
      'send',
      '--to',
      'nobody-here',
      '--from',
      'bd-8bcbebb485fa',
      '--message',
      'disk 91%',
    ]);

    expect(r.code).not.toBe(0);
    const lines = r.out.split('\n').filter((l) => l.trim() !== '');
    expect(lines, `stdout was: ${JSON.stringify(r.out)}`).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.outcome).toBe('rejected');
    // Machine-readable, and specifically the code that tells birddog to look at
    // its configuration rather than retry the transport.
    expect(parsed.refusal).toBe('peer_unknown');
  });

  test('keeps every diagnostic off stdout', async () => {
    const r = await run(['send', '--to', 'nobody-here', '--from', 'bd-1', '--message', 'x']);
    // The prose exists — it is just not on the channel being parsed.
    expect(r.err.length).toBeGreaterThan(0);
    expect(r.out).not.toContain('[tincan]');
    expect(() => JSON.parse(r.out.trim())).not.toThrow();
  });

  test('exits 64 with no JSON when the command line itself is wrong', async () => {
    const r = await run(['send', '--to', 'nobody-here', '--message', 'x']);
    expect(r.code).toBe(USAGE_EXIT);
    expect(r.out).toBe('');
    expect(r.err).toContain('--from');
  });

  test('refuses a --from it would have to rewrite, before sending anything', async () => {
    const r = await run(['send', '--to', 'nobody-here', '--from', 'Bird Dog', '--message', 'x']);
    expect(r.code).toBe(USAGE_EXIT);
    expect(r.out).toBe('');
    // Naming the value that would have worked is the difference between an
    // error a caller can fix and one it has to guess at.
    expect(r.err).toContain('bird-dog');
  });

  test('never starts the MCP server on the send path', async () => {
    // A server would hold the process open on stdin rather than exiting, and
    // would write its banner to stderr. The exit is the assertion.
    const r = await run(['send', '--to', 'nobody-here', '--from', 'bd-1', '--message', 'x']);
    expect(r.code).not.toBe(-1);
    expect(r.err).not.toContain('hosted in');
  });

  test('writes no pointer record, because it is not a session', async () => {
    // A record here would advertise a Tin Can that can be replied to, at a pid
    // that has already exited by the time anything reads it.
    await run(['send', '--to', 'nobody-here', '--from', 'bd-1', '--message', 'x']);
    const pointers = join(home, '.tincan', 'peers', 'claude-code');
    expect(existsSync(pointers) && readdirSync(pointers).length > 0).toBe(false);
  });
});

/**
 * `--idempotency-key` across separate invocations — which is the only kind
 * there is.
 *
 * `IdempotencyStore` is in-memory, and its docstring scopes it correctly for a
 * hosted server: "a retry minutes later in the same session". A CLI invocation
 * IS the restart, every time, so for this path that store is a map that never
 * survives to be read and the flag silently did nothing. Found by birddog, which
 * retries `Deliver` under a bounded attempt count with a stable key precisely so
 * a retried alert is not delivered twice — so the inert flag turned its retry
 * path into the alert storm the key exists to prevent.
 *
 * Three processes, because two cannot tell the two refusals apart.
 */
describe('a retry across processes, which is what a CLI retry is', () => {
  let home: string;
  let sockDir: string;
  let received: string[];
  let server: import('node:net').Server;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'tincan-idem-'));
    sockDir = mkdtempSync(join(tmpdir(), 'tincan-idem-sock-'));
    received = [];
    const reg = join(home, 'peers', 'opencode');
    mkdirSync(reg, { recursive: true });
    const sock = join(sockDir, 'i.sock');
    server = createServer((c) => {
      let buf = '';
      c.on('data', (d) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim() !== '') received.push(line);
          c.write('{"ok":true}\n');
        }
      });
      c.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(sock, r));
    writeFileSync(
      join(reg, 'ses_i.json'),
      JSON.stringify({
        session_id: 'ses_i',
        slug: 'nimble-wizard',
        directory: '/repo',
        state: 'idle',
        socket: sock,
        instance_id: 'inst-i',
        pid: 4242,
      }),
    );
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(home, { recursive: true, force: true });
    rmSync(sockDir, { recursive: true, force: true });
  });

  const send = (message: string): Promise<{ code: number; json: Record<string, unknown> }> =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          join(process.cwd(), 'dist', 'tincan.js'),
          'send',
          '--to',
          'nimble-wizard',
          '--from',
          'bd-1',
          '--message',
          message,
          '--idempotency-key',
          'bd-1:7:disk',
        ],
        {
          // A minimal PATH on purpose: no `codex` to shell out to, so the run
          // is fast and this test is about the key, not about discovery.
          env: { PATH: '/usr/bin:/bin', HOME: home, TINCAN_HOME: home },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.resume();
      child.on('exit', (code) =>
        resolve({ code: code ?? -1, json: JSON.parse(out.trim()) as Record<string, unknown> }),
      );
    });

  test('the same key, peer and text sends once and is then refused duplicate_send', async () => {
    const first = await send('disk 91%');
    expect(first.json.outcome).toBe('accepted');

    const second = await send('disk 91%');
    expect(second.json.outcome).toBe('rejected');
    expect(second.json.refusal).toBe('duplicate_send');
    // The id of the message that DID go out, so the retry can correlate it.
    expect(second.json.message_id).toBe(first.json.message_id);

    // The assertion that matters to the caller: one alert, not two.
    expect(received).toHaveLength(1);
  }, 20000);

  test('the same key with different text is refused key_reused and sends nothing', async () => {
    const first = await send('disk 91%');
    expect(first.json.outcome).toBe('accepted');

    const reused = await send('cpu 98%');
    expect(reused.json.refusal).toBe('key_reused');
    expect(reused.json.message_id).toBe(first.json.message_id);
    expect(received).toHaveLength(1);
  }, 20000);

  test('a key is not burned by a send that never landed', async () => {
    // The rule the in-memory store already had, which a durable one must keep:
    // recording on attempt would turn one transient failure into a permanent
    // refusal, and the caller's correct response to a failure is to retry under
    // the same key. Here the peer does not resolve, so nothing landed.
    const missed = await new Promise<Record<string, unknown>>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          join(process.cwd(), 'dist', 'tincan.js'),
          'send',
          '--to',
          'nobody-here',
          '--from',
          'bd-1',
          '--message',
          'disk 91%',
          '--idempotency-key',
          'bd-1:7:disk',
        ],
        { env: { PATH: '/usr/bin:/bin', HOME: home, TINCAN_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.resume();
      child.on('exit', () => resolve(JSON.parse(out.trim()) as Record<string, unknown>));
    });
    expect(missed.refusal).toBe('peer_unknown');

    // The key must still be usable.
    const retry = await send('disk 91%');
    expect(retry.json.outcome).toBe('accepted');
    expect(received).toHaveLength(1);
  }, 20000);
});

/**
 * `tincan send --help` exits 0, which is the only stable way for a caller to
 * ask whether this tincan can send at all.
 *
 * Before this, a caller had to distinguish the two builds by matching prose on
 * stderr — `unrecognised argument`, which is documentation, not an interface:
 *
 *   1.9.2   tincan send   exit 2   "tincan: unrecognised argument 'send'"
 *   1.10.1  tincan send   exit 64  "tincan send: --to is required."
 *
 * Both non-zero, nothing on stdout, so the discriminator was a sentence nobody
 * had promised to keep. Reword it and every caller doing that silently starts
 * accepting a tincan that cannot deliver. Reported by birddog, which probes at
 * startup so a missing capability surfaces then rather than when the first
 * worker blocks.
 *
 * A zero exit is the thing no rewording can erase: every build without the
 * subcommand exits non-zero on it, because `send` itself is the unrecognised
 * argument there.
 */
describe('send --help, the capability probe', () => {
  test('is recognised as a request for help rather than a malformed send', () => {
    const r = parseSendArgs(['--help']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.help).toBe(true);
  });

  test('accepts the short form too', () => {
    const r = parseSendArgs(['-h']);
    expect(r.ok && r.help).toBe(true);
  });

  test('wins over missing required flags, which is the whole point', () => {
    // A probe cannot be expected to supply --to and --message just to ask
    // whether --to and --message exist.
    const r = parseSendArgs(['--help']);
    expect(r.ok).toBe(true);
  });

  test('help anywhere in the arguments still asks for help', () => {
    expect(parseSendArgs(['--to', 'x', '--help']).ok).toBe(true);
    expect(parseSendArgs(['--to', 'x', '--from', 'y', '--message', 'z', '--help']).ok).toBe(true);
  });

  test('is not triggered by the word help appearing as a value', () => {
    // `--message --help` is caught as a flag-without-a-value, but a legitimate
    // message that merely CONTAINS the word must still send.
    const r = parseSendArgs(['--to', 'x', '--from', 'y', '--message', 'run --help first']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.help).toBeUndefined();
    expect(r.args?.message).toBe('run --help first');
  });
});
