import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageLog } from '../src/log.js';
import { buildEnvelope } from '../src/envelope.js';
import { CODEX_LIMITS, CLAUDE_LIMITS } from '../src/guard.js';
import { createTools, type Side, type SidePeer } from '../src/tools.js';
import {
  kindOf,
  mailRoutingFromEnv,
  parseRecipient,
  readConfig,
  routingOff,
  type FileResult,
  type MailItem,
  type MailRouting,
  type Recipient,
} from '../src/mail-routing.js';

const RECIPIENT_ID = '11111111-2222-4333-8444-555555555555';
const RECIPIENT_LINE = `lead-a1.555 claude-code:lead-a1.${RECIPIENT_ID} 4242\n`;
const SENDER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let dir: string;
let log: MessageLog;

const lead = (): SidePeer => ({
  runtime: 'claude-code',
  rawName: 'lead-a1',
  uuid: RECIPIENT_ID,
  cwd: '/src/lead',
  state: 'idle',
  canReply: true,
});
const other = (): SidePeer => ({
  runtime: 'claude-code',
  rawName: 'other-b2',
  uuid: '99999999-8888-4777-8666-555555555555',
  cwd: '/src/other',
  state: 'idle',
  canReply: true,
});

function makeSide(over: Partial<Side> = {}) {
  const delivered: string[] = [];
  const side: Side = {
    selfRuntime: 'claude-code',
    resolveSelf: async () => ({ sessionId: undefined }),
    selfName: async () => 'tincan-6c',
    selfDurableId: async () => ({ session_id: SENDER_ID }),
    selfCwd: '/src/tincan',
    peerRuntimes: ['claude-code'],
    limitsFor: (r) => (r === 'codex' ? CODEX_LIMITS : CLAUDE_LIMITS),
    listPeers: async () => ({ peers: [lead(), other()] }),
    deliver: async (_self, _name, p, _id, text) => {
      delivered.push(`${p.rawName}: ${text}`);
      return { delivered: true, method: 'inbox' as const };
    },
    ...over,
  };
  return { side, delivered };
}

/** A router with a fixed recipient that records what it filed. */
function fakeMail(recipient: Recipient | undefined, result: FileResult = { ok: true, mailId: '7' }) {
  const filed: MailItem[] = [];
  const mail: MailRouting = {
    recipient: () => recipient,
    commandName: () => 'test-inbox',
    deliverPrefixes: () => ['HANDOFF-'],
    commandSender: () => 'test-inbox',
    file: async (item) => {
      filed.push(item);
      return result;
    },
  };
  return { mail, filed };
}

const RECIPIENT = parseRecipient(RECIPIENT_LINE)!;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tincan-mail-'));
  log = new MessageLog(join(dir, 'messages.jsonl'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseRecipient', () => {
  test('reads the name and canonical id, and takes the durable id from the canonical id', () => {
    expect(RECIPIENT).toEqual({
      name: 'lead-a1.555',
      canonicalId: `claude-code:lead-a1.${RECIPIENT_ID}`,
      id: RECIPIENT_ID,
    });
  });

  test('an empty or one-field recipient file names nobody', () => {
    expect(parseRecipient('')).toBeUndefined();
    expect(parseRecipient('only-a-name\n')).toBeUndefined();
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

describe('send_peer to the configured mail recipient', () => {
  test('files it in the mailbox and does not deliver it into the session', async () => {
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(RECIPIENT);
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'lead-a1',
      message: 'DONE: PR #50 merged',
    });

    expect(delivered).toEqual([]);
    expect(r.outcome).toBe('accepted');
    expect(r.method).toBe('mailbox');
    expect(r.notice).toMatch(/mailbox \(test-inbox #7\)/);
    expect(filed).toEqual([
      {
        to: SENDER_ID,
        kind: 'DONE',
        text: 'DONE: PR #50 merged',
        from: 'tincan-6c',
        sessionId: SENDER_ID,
        replyTo: `claude-code:tincan-6c.${SENDER_ID}`,
        urgent: false,
        key: `tincan:${r.message_id}`,
      },
    ]);
  });

  test('a message to anyone else is delivered as before', async () => {
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(RECIPIENT);
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'other-b2',
      message: 'hello',
    });
    expect(r.method).toBe('inbox');
    expect(filed).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  test('text with an unconfigured prefix is still filed', async () => {
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(RECIPIENT);
    await createTools(side, log, undefined, mail).send_peer({ peer: 'lead-a1', message: 'RELAY-x' });
    expect(filed).toHaveLength(1);
    expect(delivered).toEqual([]);
  });

  test.each(['HANDOFF-ACK ready', '  HANDOFF-READY x'])(
    'a configured deliver-prefix line %j is delivered',
    async (message) => {
      const { side, delivered } = makeSide();
      const { mail, filed } = fakeMail(RECIPIENT);
      const r = await createTools(side, log, undefined, mail).send_peer({
        peer: 'lead-a1',
        message,
      });
      expect(r.method).toBe('inbox');
      expect(filed).toEqual([]);
      expect(delivered).toHaveLength(1);
    },
  );

  const fromLead = (id: string, expectReply: boolean) =>
    log.appendMessage(
      buildEnvelope({
        id,
        from: { runtime: 'claude-code', name: 'lead-a1', session_id: RECIPIENT_ID },
        to: { runtime: 'claude-code', name: 'tincan-6c', session_id: SENDER_ID },
        method: 'inbox',
        expect_reply: expectReply,
        reply_tool: true,
        text: 'which kind should a plain message file as?',
      }),
      true,
    );

  test('a reply to a question the recipient is waiting on is delivered', async () => {
    fromLead('msg_question', true);
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(RECIPIENT);
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'lead-a1',
      message: 'STATUS is the default',
      in_reply_to: 'msg_question',
      answers: true,
    });
    expect(r.method).toBe('inbox');
    expect(filed).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  test('a reply to a message that asked nothing still goes to the mailbox', async () => {
    fromLead('msg_fyi', false);
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(RECIPIENT);
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'lead-a1',
      message: 'ack',
      in_reply_to: 'msg_fyi',
    });
    expect(r.method).toBe('mailbox');
    expect(filed).toHaveLength(1);
    expect(delivered).toEqual([]);
  });

  test('an urgent message is filed as urgent mail (test-inbox notifies)', async () => {
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(RECIPIENT, { ok: true, mailId: '7', notified: true });
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'lead-a1',
      message: 'BLOCKED: prod is down',
      urgent: true,
    });
    expect(delivered).toEqual([]);
    expect(filed[0]).toMatchObject({ kind: 'BLOCKED', urgent: true });
    expect(r.notice).toMatch(/urgent, and it was notified/);
  });

  test("urgent mail whose notification was not reported is delivered directly as well", async () => {
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(RECIPIENT, { ok: true, mailId: '7', notified: false });
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'lead-a1',
      message: 'BLOCKED: prod is down',
      urgent: true,
    });
    expect(filed).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(r.method).toBe('inbox');
    expect(r.notice).toMatch(/urgent mail #7, but test-inbox did not report notifying the recipient.*delivered directly/);
  });

  test("the inbox command's own notification is delivered, or urgent mail would never reach the session", async () => {
    const { side, delivered } = makeSide({
      selfRuntime: 'external',
      selfName: async () => 'test-inbox',
      selfDurableId: async () => undefined,
    });
    const { mail, filed } = fakeMail(RECIPIENT);
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'lead-a1',
      message: 'mail: 1 urgent',
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
    const { mail, filed } = fakeMail(RECIPIENT);
    await createTools(side, log, undefined, mail).send_peer({
      peer: 'lead-a1',
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

  test('no recipient (or routing off): delivered as before', async () => {
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(undefined);
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'lead-a1',
      message: 'DONE',
    });
    expect(r.method).toBe('inbox');
    expect(filed).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  test('when test-inbox cannot file it, it is delivered, and the sender is told why', async () => {
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(RECIPIENT, { ok: false, error: 'test-inbox: not found' });
    const r = await createTools(side, log, undefined, mail).send_peer({
      peer: 'lead-a1',
      message: 'DONE',
    });
    expect(filed).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(r.outcome).toBe('accepted');
    expect(r.method).toBe('inbox');
    expect(r.notice).toMatch(/did not complete \(test-inbox: not found\).*delivered directly/);
  });

  test('a fan-out mails the recipient and delivers to the rest', async () => {
    const { side, delivered } = makeSide();
    const { mail, filed } = fakeMail(RECIPIENT);
    const r = await createTools(side, log, undefined, mail).send_peer({
      peers: ['lead-a1', 'other-b2'],
      message: 'heads up',
    });
    expect(r.results?.map((x) => x.method)).toEqual(['mailbox', 'inbox']);
    expect(filed).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/^other-b2: /);
  });
});

describe('mailRoutingFromEnv', () => {
  const home = () => join(dir, 'tincan');
  const writeRecipient = (path = join(home(), 'mail-recipient')) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, RECIPIENT_LINE);
  };
  const writeConfig = (config: unknown) => {
    mkdirSync(home(), { recursive: true });
    writeFileSync(join(home(), 'mail-routing.json'), JSON.stringify(config));
  };
  const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ TINCAN_HOME: home(), ...over });

  test('with no configuration, the recipient is read live from $TINCAN_HOME/mail-recipient', () => {
    const r = mailRoutingFromEnv(env(), dir);
    expect(r.recipient()).toBeUndefined();
    writeRecipient();
    expect(r.recipient()?.id).toBe(RECIPIENT_ID);
  });

  test('defaults: tincan-mailbox, no deliver prefixes, the command as its own sender', () => {
    expect(readConfig(env(), dir)).toEqual({
      recipientFile: join(home(), 'mail-recipient'),
      command: 'tincan-mailbox',
      commandSender: 'tincan-mailbox',
      deliverPrefixes: [],
    });
  });

  test('mail-routing.json sets the recipient file, command, sender and prefixes; ~ is the home dir', () => {
    writeConfig({
      recipientFile: '~/state/recipient',
      command: '/opt/bin/my-inbox',
      deliverPrefixes: ['HANDOFF-', 7, ''],
    });
    expect(readConfig(env(), dir)).toEqual({
      recipientFile: join(dir, 'state', 'recipient'),
      command: '/opt/bin/my-inbox',
      commandSender: 'my-inbox',
      deliverPrefixes: ['HANDOFF-'],
    });
    const r = mailRoutingFromEnv(env(), dir);
    expect(r.recipient()).toBeUndefined();
    writeRecipient(join(dir, 'state', 'recipient'));
    expect(r.recipient()?.id).toBe(RECIPIENT_ID);
    expect(r.commandName()).toBe('my-inbox');
    expect(r.commandSender()).toBe('my-inbox');
    expect(r.deliverPrefixes()).toEqual(['HANDOFF-']);
  });

  test('the default sender is a usable --from name, derived from the command', () => {
    writeConfig({ command: '/opt/bin/My_Mailbox.py' });
    expect(readConfig(env(), dir).commandSender).toBe('my-mailbox');
  });

  test('a malformed mail-routing.json is all defaults, not a throw', () => {
    mkdirSync(home(), { recursive: true });
    writeFileSync(join(home(), 'mail-routing.json'), '{nope');
    expect(readConfig(env(), dir).command).toBe('tincan-mailbox');
  });

  test('$TINCAN_MAIL_ROUTING_CONFIG points at another file', () => {
    const other = join(dir, 'elsewhere.json');
    writeFileSync(other, JSON.stringify({ command: 'elsewhere-inbox' }));
    expect(readConfig(env({ TINCAN_MAIL_ROUTING_CONFIG: other }), dir).command).toBe('elsewhere-inbox');
  });

  test('TINCAN_MAIL_ROUTING=off names nobody', () => {
    writeRecipient();
    expect(routingOff(env({ TINCAN_MAIL_ROUTING: 'off' }), dir)).toBe(true);
    expect(mailRoutingFromEnv(env({ TINCAN_MAIL_ROUTING: 'off' }), dir).recipient()).toBeUndefined();
  });

  test('$TINCAN_HOME/mail-routing-off names nobody, with no restart', () => {
    writeRecipient();
    const r = mailRoutingFromEnv(env(), dir);
    expect(r.recipient()).toBeDefined();
    writeFileSync(join(home(), 'mail-routing-off'), '');
    expect(r.recipient()).toBeUndefined();
  });

  test('files through the configured command, and reads back the mail number', async () => {
    const argvFile = join(dir, 'argv');
    const fake = join(dir, 'fake-inbox');
    writeFileSync(
      fake,
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${argvFile}'\necho "mail #42: DONE from tincan-6c"\n`,
    );
    chmodSync(fake, 0o755);
    writeConfig({ command: fake });
    const r = mailRoutingFromEnv(env(), dir);
    const res = await r.file({
      to: SENDER_ID,
      kind: 'DONE',
      text: 'shipped',
      from: 'tincan-6c',
      sessionId: SENDER_ID,
      replyTo: `claude-code:tincan-6c.${SENDER_ID}`,
      urgent: true,
      key: 'tincan:msg_1',
    });
    // Urgent, and the fake printed no "notified" line: reported as not notified.
    expect(res).toEqual({ ok: true, mailId: '42', notified: false });
    expect(readFileSync(argvFile, 'utf8').trim().split('\n')).toEqual([
      'send', SENDER_ID, 'DONE', 'shipped',
      '--from', 'tincan-6c',
      '--session-id', SENDER_ID,
      '--reply-to', `claude-code:tincan-6c.${SENDER_ID}`,
      '--key', 'tincan:msg_1',
      '--urgent',
    ]);
  });

  test.each(['notified lead-a1', 'pinged lead-a1'])('urgent mail whose command prints %j was notified', async (line) => {
    const fake = join(dir, 'notifying-inbox');
    writeFileSync(fake, `#!/bin/sh\necho "mail #3"\necho "${line}"\n`);
    chmodSync(fake, 0o755);
    writeConfig({ command: fake });
    const res = await mailRoutingFromEnv(env(), dir).file({
      to: 'x', kind: 'BLOCKED', text: 't', from: 'x', urgent: true, key: 'k',
    });
    expect(res).toEqual({ ok: true, mailId: '3', notified: true });
  });

  test('a failed first try is retried under the same key, so a stalled filing is not filed twice', async () => {
    const calls = join(dir, 'calls');
    const fake = join(dir, 'flaky-inbox');
    // First call: "files" and dies. Second: what the command says for a key it already has.
    writeFileSync(
      fake,
      `#!/bin/sh\necho "$@" >> '${calls}'\n` +
        `if [ "$(wc -l < '${calls}')" -eq 1 ]; then exit 1; fi\n` +
        `echo "mail #9: already sent (key tincan:msg_2)"\n`,
    );
    chmodSync(fake, 0o755);
    writeConfig({ command: fake });
    const r = mailRoutingFromEnv(env(), dir);
    const res = await r.file({ to: 'x', kind: 'STATUS', text: 't', from: 'x', urgent: false, key: 'tincan:msg_2' });
    expect(res).toEqual({ ok: true, mailId: '9' });
    const lines = readFileSync(calls, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(lines[1]);
    expect(lines[1]).toContain('--key tincan:msg_2');
  });

  test('a missing command is a failure to file, not a throw', async () => {
    writeConfig({ command: join(dir, 'nope') });
    const r = mailRoutingFromEnv(env(), dir);
    const res = await r.file({ to: 'x', kind: 'STATUS', text: 't', from: 'x', urgent: false, key: 'k' });
    expect(res.ok).toBe(false);
  });
});
