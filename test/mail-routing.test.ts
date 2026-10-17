import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MessageLog } from '../src/log.js';
import { buildEnvelope } from '../src/envelope.js';
import { CODEX_LIMITS, CLAUDE_LIMITS } from '../src/guard.js';
import { createTools, type Side, type SidePeer } from '../src/tools.js';
import {
  kindOf,
  mailRoutingFromEnv,
  parseSeat,
  routingOff,
  type FileResult,
  type MailItem,
  type MailRouting,
  type Seat,
} from '../src/mail-routing.js';

const SEAT_ID = '757a3805-184a-499e-86f0-c041ee195d30';
const SEAT_LINE = `mikewilliams-aa.d30 claude-code:mikewilliams-aa.${SEAT_ID} 39324\n`;
const WORKER_ID = 'ccaba4c6-4b0d-43ae-b68a-bc99b6f5c836';

let dir: string;
let log: MessageLog;

const chief = (): SidePeer => ({
  runtime: 'claude-code',
  rawName: 'mikewilliams-aa',
  uuid: SEAT_ID,
  cwd: '/Users/mike',
  state: 'idle',
  canReply: true,
});
const other = (): SidePeer => ({
  runtime: 'claude-code',
  rawName: 'claude-fleet',
  uuid: 'dc1c1161-9bc9-4679-805d-48b7df247408',
  cwd: '/src/fleet',
  state: 'idle',
  canReply: true,
});

function makeSide(over: Partial<Side> = {}) {
  const delivered: string[] = [];
  const side: Side = {
    selfRuntime: 'claude-code',
    resolveSelf: async () => ({ sessionId: undefined }),
    selfName: async () => 'tincan-6c',
    selfDurableId: async () => ({ session_id: WORKER_ID }),
    selfCwd: '/src/tincan',
    peerRuntimes: ['claude-code'],
    limitsFor: (r) => (r === 'codex' ? CODEX_LIMITS : CLAUDE_LIMITS),
    listPeers: async () => ({ peers: [chief(), other()] }),
    deliver: async (_self, _name, p, _id, text) => {
      delivered.push(`${p.rawName}: ${text}`);
      return { delivered: true, method: 'inbox' as const };
    },
    ...over,
  };
  return { side, delivered };
}

/** A router with a fixed seat that records what it filed. */
function fakeMail(seat: Seat | undefined, result: FileResult = { ok: true, mailId: '7' }) {
  const filed: MailItem[] = [];
  const mail: MailRouting = {
    seat: () => seat,
    file: async (item) => {
      filed.push(item);
      return result;
    },
  };
  return { mail, filed };
}

const SEAT = parseSeat(SEAT_LINE)!;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tincan-mail-'));
  log = new MessageLog(join(dir, 'messages.jsonl'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseSeat', () => {
  test('reads the name and canonical id, and takes the durable id from the canonical id', () => {
    expect(SEAT).toEqual({
      name: 'mikewilliams-aa.d30',
      canonicalId: `claude-code:mikewilliams-aa.${SEAT_ID}`,
      id: SEAT_ID,
    });
  });

  test('an empty or one-field seat file seats nobody', () => {
    expect(parseSeat('')).toBeUndefined();
    expect(parseSeat('only-a-name\n')).toBeUndefined();
  });
});

describe('kindOf', () => {
  test('a leading report kind files as that kind', () => {
    expect(kindOf('DONE: PR #12 merged')).toBe('DONE');
    expect(kindOf('  BLOCKED — needs approval')).toBe('BLOCKED');
  });

  test('anything else is STATUS, and REQUEST/ALERT are never inferred', () => {
    expect(kindOf('done, merged')).toBe('STATUS');
    expect(kindOf('DONEISH')).toBe('STATUS');
    expect(kindOf('REQUEST: may I push?')).toBe('STATUS');
    expect(kindOf('ALERT x')).toBe('STATUS');
  });
});

describe('send_peer to the seated chief of staff', () => {
  test('files it in the mailbox and does not deliver it into the session', async () => {
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(SEAT);
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'mikewilliams-aa',
      message: 'DONE: PR #50 merged',
    });

    expect(delivered).toEqual([]);
    expect(r.outcome).toBe('accepted');
    expect(r.method).toBe('cos-mail');
    expect(r.notice).toMatch(/mailbox \(cos-mail #7\)/);
    expect(filed).toEqual([
      {
        to: WORKER_ID,
        kind: 'DONE',
        text: 'DONE: PR #50 merged',
        from: 'tincan-6c',
        sessionId: WORKER_ID,
        replyTo: `claude-code:tincan-6c.${WORKER_ID}`,
        urgent: false,
        key: `tincan:${r.message_id}`,
      },
    ]);
  });

  test('a message to anyone else is delivered as before', async () => {
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(SEAT);
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'claude-fleet',
      message: 'hello',
    });
    expect(r.method).toBe('inbox');
    expect(filed).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  test.each(['SCOTTY-UPDATE: hand off now', 'HANDOFF-ACK ready', '  SCOTTY-HANDOFF x'])(
    'the handoff protocol line %j is delivered',
    async (message) => {
      const { side, delivered } = makeSide();
      const { mail, filed } = fakeMail(SEAT);
      const r = await createTools(side, log, undefined, mail).send_peer({
        peer: 'mikewilliams-aa',
        message,
      });
      expect(r.method).toBe('inbox');
      expect(filed).toEqual([]);
      expect(delivered).toHaveLength(1);
    },
  );

  const fromChief = (id: string, expectReply: boolean) =>
    log.appendMessage(
      buildEnvelope({
        id,
        from: { runtime: 'claude-code', name: 'mikewilliams-aa', session_id: SEAT_ID },
        to: { runtime: 'claude-code', name: 'tincan-6c', session_id: WORKER_ID },
        method: 'inbox',
        expect_reply: expectReply,
        reply_tool: true,
        text: 'which kind should a plain message file as?',
      }),
      true,
    );

  test('a reply to a question the chief of staff is waiting on is delivered', async () => {
    fromChief('msg_question', true);
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(SEAT);
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'mikewilliams-aa',
      message: 'STATUS is the default',
      in_reply_to: 'msg_question',
      answers: true,
    });
    expect(r.method).toBe('inbox');
    expect(filed).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  test('a reply to a message that asked nothing still goes to the mailbox', async () => {
    fromChief('msg_fyi', false);
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(SEAT);
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'mikewilliams-aa',
      message: 'ack',
      in_reply_to: 'msg_fyi',
    });
    expect(r.method).toBe('cos-mail');
    expect(filed).toHaveLength(1);
    expect(delivered).toEqual([]);
  });

  test('an urgent message is filed as urgent mail (cos-mail sends the ping)', async () => {
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(SEAT, { ok: true, mailId: '7', pinged: true });
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'mikewilliams-aa',
      message: 'BLOCKED: prod is down',
      urgent: true,
    });
    expect(delivered).toEqual([]);
    expect(filed[0]).toMatchObject({ kind: 'BLOCKED', urgent: true });
    expect(r.notice).toMatch(/urgent, and it was pinged/);
  });

  test("urgent mail whose ping did not land is delivered directly as well", async () => {
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(SEAT, { ok: true, mailId: '7', pinged: false });
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'mikewilliams-aa',
      message: 'BLOCKED: prod is down',
      urgent: true,
    });
    expect(filed).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(r.method).toBe('inbox');
    expect(r.notice).toMatch(/urgent mail #7, but cos-mail's ping did not land.*delivered directly/);
  });

  test("cos-mail's own ping is delivered, or urgent mail would never reach the session", async () => {
    const { side, delivered } = makeSide({
      selfRuntime: 'external',
      selfName: async () => 'cos-mail',
      selfDurableId: async () => undefined,
    });
    const { mail, filed } = fakeMail(SEAT);
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'mikewilliams-aa',
      message: 'mail: 1 urgent — cos-mail read',
    });
    expect(r.method).toBe('inbox');
    expect(filed).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  test('another external sender is mailed, with its reply-via in the text', async () => {
    const { side, delivered } = makeSide({
      selfRuntime: 'external',
      selfName: async () => 'nightly-job',
      selfDurableId: async () => undefined,
      replyVia: 'file an issue',
    });
    const { mail, filed } = fakeMail(SEAT);
    await createTools(side, log, undefined, mail).send_peer({
      peer: 'mikewilliams-aa',
      message: 'backup finished',
    });
    expect(delivered).toEqual([]);
    expect(filed[0]).toMatchObject({
      to: 'nightly-job',
      from: 'nightly-job',
      text: 'backup finished (reply via: file an issue)',
    });
    expect(filed[0]).not.toHaveProperty('replyTo');
  });

  test('nobody seated (or routing off): delivered as before', async () => {
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(undefined);
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'mikewilliams-aa',
      message: 'DONE',
    });
    expect(r.method).toBe('inbox');
    expect(filed).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  test('when cos-mail cannot file it, it is delivered, and the sender is told why', async () => {
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(SEAT, { ok: false, error: 'cos-mail: not found' });
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'mikewilliams-aa',
      message: 'DONE',
    });
    expect(filed).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(r.outcome).toBe('accepted');
    expect(r.method).toBe('inbox');
    expect(r.notice).toMatch(/did not complete \(cos-mail: not found\).*delivered directly/);
  });

  test('a fan-out mails the chief of staff and delivers to the rest', async () => {
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(SEAT);
    const r = await createTools(side, log, undefined, mail).send_peer({
      peers: ['mikewilliams-aa', 'claude-fleet'],
      message: 'heads up',
    });
    expect(r.results?.map((x) => x.method)).toEqual(['cos-mail', 'inbox']);
    expect(filed).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/^claude-fleet: /);
  });
});

describe('mailRoutingFromEnv', () => {
  const stateHome = () => join(dir, 'state');
  const writeSeat = () => {
    mkdirSync(join(stateHome(), 'my-handler'), { recursive: true });
    writeFileSync(join(stateHome(), 'my-handler', 'seat'), SEAT_LINE);
  };
  const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    XDG_STATE_HOME: stateHome(),
    TINCAN_HOME: join(dir, 'tincan'),
    ...over,
  });

  test('reads the seat live from $XDG_STATE_HOME/my-handler/seat', () => {
    const r = mailRoutingFromEnv(env(), dir);
    expect(r.seat()).toBeUndefined();
    writeSeat();
    expect(r.seat()?.id).toBe(SEAT_ID);
  });

  test('TINCAN_MAIL_ROUTING=off seats nobody', () => {
    writeSeat();
    expect(routingOff(env({ TINCAN_MAIL_ROUTING: 'off' }), dir)).toBe(true);
    expect(mailRoutingFromEnv(env({ TINCAN_MAIL_ROUTING: 'off' }), dir).seat()).toBeUndefined();
  });

  test('$TINCAN_HOME/mail-routing-off seats nobody, with no restart', () => {
    writeSeat();
    const r = mailRoutingFromEnv(env(), dir);
    expect(r.seat()).toBeDefined();
    mkdirSync(join(dir, 'tincan'), { recursive: true });
    writeFileSync(join(dir, 'tincan', 'mail-routing-off'), '');
    expect(r.seat()).toBeUndefined();
  });

  test('files through the cos-mail it is given, and reads back the mail number', async () => {
    const argvFile = join(dir, 'argv');
    const fake = join(dir, 'fake-cos-mail');
    writeFileSync(
      fake,
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${argvFile}'\necho "mail #42: DONE from tincan-6c"\n`,
    );
    chmodSync(fake, 0o755);
    const r = mailRoutingFromEnv(env({ TINCAN_COS_MAIL: fake }), dir);
    const res = await r.file({
      to: WORKER_ID,
      kind: 'DONE',
      text: 'shipped',
      from: 'tincan-6c',
      sessionId: WORKER_ID,
      replyTo: `claude-code:tincan-6c.${WORKER_ID}`,
      urgent: true,
      key: 'tincan:msg_1',
    });
    // Urgent, and the fake printed no "pinged" line: reported as not pinged.
    expect(res).toEqual({ ok: true, mailId: '42', pinged: false });
    expect(readFileSync(argvFile, 'utf8').trim().split('\n')).toEqual([
      'send', WORKER_ID, 'DONE', 'shipped',
      '--from', 'tincan-6c',
      '--session-id', WORKER_ID,
      '--reply-to', `claude-code:tincan-6c.${WORKER_ID}`,
      '--key', 'tincan:msg_1',
      '--urgent',
    ]);
  });

  test('a failed first try is retried under the same key, so a stalled filing is not filed twice', async () => {
    const calls = join(dir, 'calls');
    const fake = join(dir, 'flaky-cos-mail');
    // First call: "files" and dies. Second: what cos-mail says for a key it already has.
    writeFileSync(
      fake,
      `#!/bin/sh\necho "$@" >> '${calls}'\n` +
        `if [ "$(wc -l < '${calls}')" -eq 1 ]; then exit 1; fi\n` +
        `echo "mail #9: already sent (key tincan:msg_2)"\n`,
    );
    chmodSync(fake, 0o755);
    const r = mailRoutingFromEnv(env({ TINCAN_COS_MAIL: fake }), dir);
    const res = await r.file({ to: 'x', kind: 'STATUS', text: 't', from: 'x', urgent: false, key: 'tincan:msg_2' });
    expect(res).toEqual({ ok: true, mailId: '9' });
    const lines = readFileSync(calls, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(lines[1]);
    expect(lines[1]).toContain('--key tincan:msg_2');
  });

  test('a missing cos-mail is a failure to file, not a throw', async () => {
    const r = mailRoutingFromEnv(env({ TINCAN_COS_MAIL: join(dir, 'nope') }), dir);
    const res = await r.file({ to: 'x', kind: 'STATUS', text: 't', from: 'x', urgent: false, key: 'k' });
    expect(res.ok).toBe(false);
  });

  // The real cos-mail, against a throwaway state dir: proves the item is in its
  // own format. Skipped where it is not installed (CI).
  const realCosMail = (() => {
    try {
      return execFileSync('sh', ['-c', 'command -v cos-mail'], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  })();
  test.skipIf(realCosMail === '')('the real cos-mail writes the item in its own format', async () => {
    const mailFile = join(dir, 'mail.jsonl');
    const r = mailRoutingFromEnv(
      env({
        TINCAN_COS_MAIL: realCosMail,
        PATH: process.env.PATH,
      }),
      dir,
    );
    // cos-mail reads its paths from its own environment, which execFile inherits.
    const saved = { ...process.env };
    Object.assign(process.env, {
      COS_MAIL: mailFile,
      COS_ACTIVITY: join(dir, 'activity.jsonl'),
      COS_LEDGER: join(dir, 'ledger.json'),
      XDG_STATE_HOME: stateHome(),
      COS_MAIL_TINCAN: 'true',
    });
    try {
      const res = await r.file({
        to: WORKER_ID,
        kind: 'STATUS',
        text: 'hello chief',
        from: 'tincan-6c',
        sessionId: WORKER_ID,
        replyTo: `claude-code:tincan-6c.${WORKER_ID}`,
        urgent: false,
        key: 'tincan:msg_real',
      });
      expect(res).toEqual({ ok: true, mailId: '1' });
    } finally {
      process.env = saved;
    }
    expect(existsSync(mailFile)).toBe(true);
    const item = JSON.parse(readFileSync(mailFile, 'utf8').trim());
    expect(item).toMatchObject({
      id: 1,
      from: 'tincan-6c',
      session_id: WORKER_ID,
      reply_to: `claude-code:tincan-6c.${WORKER_ID}`,
      kind: 'STATUS',
      text: 'hello chief',
      urgent: false,
      read: false,
      key: 'tincan:msg_real',
    });
  });

  test.skipIf(realCosMail === '')(
    'urgent: the real cos-mail files it urgent and pings the seat through tincan send --from cos-mail',
    async () => {
      writeSeat();
      const pingArgs = join(dir, 'ping-argv');
      const fakeTincan = join(dir, 'fake-tincan');
      writeFileSync(
        fakeTincan,
        `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${pingArgs}'\necho '{"outcome":"accepted"}'\n`,
      );
      chmodSync(fakeTincan, 0o755);
      const mailFile = join(dir, 'mail.jsonl');
      const r = mailRoutingFromEnv(env({ TINCAN_COS_MAIL: realCosMail }), dir);
      const saved = { ...process.env };
      Object.assign(process.env, {
        COS_MAIL: mailFile,
        COS_ACTIVITY: join(dir, 'activity.jsonl'),
        COS_LEDGER: join(dir, 'ledger.json'),
        XDG_STATE_HOME: stateHome(),
        COS_MAIL_TINCAN: fakeTincan,
        CLAUDE_CODE_SESSION_ID: WORKER_ID,
      });
      let res: FileResult;
      try {
        res = await r.file({
          to: WORKER_ID,
          kind: 'BLOCKED',
          text: 'prod is down',
          from: 'tincan-6c',
          sessionId: WORKER_ID,
          urgent: true,
          key: 'tincan:msg_urgent',
        });
      } finally {
        process.env = saved;
      }
      expect(res).toEqual({ ok: true, mailId: '1', pinged: true });
      expect(JSON.parse(readFileSync(mailFile, 'utf8').trim())).toMatchObject({ urgent: true });
      const argv = readFileSync(pingArgs, 'utf8').trim().split('\n');
      expect(argv.slice(0, 5)).toEqual(['send', '--to', SEAT.canonicalId, '--from', 'cos-mail']);
      expect(argv[6]).toMatch(/^mail: 1 urgent — cos-mail read$/);
      // ...and that ping, from `cos-mail`, is one routing delivers: see
      // "cos-mail's own ping is delivered" above.
    },
  );
});
