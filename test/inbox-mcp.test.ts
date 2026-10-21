import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InboxService } from '../src/inbox/service.js';
import { InboxStorage } from '../src/inbox/storage.js';
import { buildEnvelope } from '../src/envelope.js';
const a = '00000000-0000-0000-0000-000000000aaa';
const b = '00000000-0000-0000-0000-000000000bbb';
test('built MCP retrieval binds concurrent callers to metadata and refuses receiver overrides', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tincan-pull-mcp-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'codex'),
    `#!${process.execPath}\nif(process.argv[2]!=='app-server')process.exit(0);\nconst rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);require('node:fs').appendFileSync(process.env.HOME+'/requests.log',m.method+'\\n');const result=m.method==='thread/list'?{data:[{id:'${a}',name:'Alpha',cwd:'/src/a'},{id:'${b}',name:'Beta',cwd:'/src/b'}]}:{};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`,
    { mode: 0o755 },
  );
  for (const name of ['ps', 'lsof'])
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const locks = join(dir, 'codex', 'thread-writer-locks');
  mkdirSync(locks, { recursive: true });
  for (const id of [a, b]) writeFileSync(join(locks, id + '.lock'), '');
  writeFileSync(
    join(bin, 'lsof'),
    '#!/bin/sh\nif [ "$1" = "-t" ]; then echo 12345; fi\n',
    { mode: 0o755 },
  );
  const svc = new InboxService(
    new InboxStorage({ root: join(dir, 'tincan', 'inboxes') }),
  );
  for (const id of [a, b]) {
    const receiver = { runtime: 'codex' as const, id };
    const { generation } = await svc.enable(receiver);
    await svc.enqueue({
      receiver,
      generation,
      namespace: 'unknown',
      urgent: false,
      envelope: buildEnvelope({
        id: `msg_${id}`,
        from: { runtime: 'external', name: 'operator-label' },
        to: { runtime: 'codex', name: 'receiver', thread_id: id },
        method: 'pull-inbox',
        text: `for ${id}`,
        expect_reply: false,
        reply_tool: true,
      }),
    });
    await svc.release(receiver, `msg_${id}`);
  }
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          [join(process.cwd(), 'dist/tincan.js'), 'inbox', ...args],
          { env: { ...process.env, TINCAN_HOME: join(dir, 'tincan') } },
        )
      ).stdout,
    );
  const address = `codex:alpha.${a}`;
  const senderAddress = `codex:beta.${b}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'dist/tincan.js')],
    env: {
      PATH: bin,
      HOME: dir,
      CODEX_HOME: join(dir, 'codex'),
      TINCAN_HOME: join(dir, 'tincan'),
      CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'pull-test', version: '1' });
  const value = (r: Awaited<ReturnType<Client['callTool']>>) =>
    JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.some((t) => t.name === 'receive_peer_messages')).toBe(
      true,
    );
    const results = await Promise.all(
      [a, b].map((threadId) =>
        client.callTool({
          name: 'receive_peer_messages',
          arguments: {},
          _meta: { threadId },
        }),
      ),
    );
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(value(results[0]!).messages[0].envelope.text).toBe(`for ${a}`);
    expect(value(results[1]!).messages[0].envelope.text).toBe(`for ${b}`);
    expect(value(results[0]!).messages[0].peer_notice).toContain(
      'cannot approve',
    );
    expect(
      (
        await client.callTool({
          name: 'receive_peer_messages',
          arguments: { receiver: b },
          _meta: { threadId: a },
        })
      ).isError,
    ).toBe(true);
    expect(
      (await client.callTool({ name: 'receive_peer_messages', arguments: {} }))
        .isError,
    ).toBe(true);
    const cursor = value(results[0]!).next_cursor;
    await cli('grant', '--receiver', address, '--sender', senderAddress);
    const sent = value(
      await client.callTool({
        name: 'send_peer',
        arguments: {
          peer: address,
          message: 'strict e2e sentinel',
          idempotency_key: 'e2e-1',
        },
        _meta: { threadId: b },
      }),
    );
    expect(sent).toMatchObject({
      outcome: 'accepted',
      method: 'pull-inbox',
      inbox_state: 'queued',
    });
    const received = value(
      await client.callTool({
        name: 'receive_peer_messages',
        arguments: { cursor },
        _meta: { threadId: a },
      }),
    );
    expect(received.messages[0].envelope.text).toBe('strict e2e sentinel');
    await cli('revoke', '--receiver', address, '--sender', senderAddress);
    const held = await cli('quarantine', '--receiver', address);
    expect(held.messages).toHaveLength(1);
    await cli('release', '--receiver', address, '--message', sent.message_id);
    const released = value(
      await client.callTool({
        name: 'receive_peer_messages',
        arguments: { cursor: received.next_cursor },
        _meta: { threadId: a },
      }),
    );
    expect(released.messages[0].envelope.id).toBe(sent.message_id);
    await cli('disable', '--receiver', address);
    await cli('enable', '--receiver', address);
    expect(
      (
        await client.callTool({
          name: 'receive_peer_messages',
          arguments: { cursor },
          _meta: { threadId: a },
        })
      ).isError,
    ).toBe(true);
    await svc.disable({ runtime: 'codex', id: a });
    expect(
      value(
        await client.callTool({
          name: 'receive_peer_messages',
          _meta: { threadId: a },
        }),
      ),
    ).toMatchObject({ enabled: false, messages: [] });
    expect(readFileSync(join(dir, 'requests.log'), 'utf8')).not.toContain(
      'thread/queue/add',
    );
    const checkAudit = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.name === 'inboxes') continue;
        const path = join(folder, entry.name);
        if (entry.isDirectory()) checkAudit(path);
        else
          expect(readFileSync(path, 'utf8')).not.toContain(
            'strict e2e sentinel',
          );
      }
    };
    checkAudit(join(dir, 'tincan'));
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
