/** Exercise the metadata boundary through the built stdio server. */
import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const a = '00000000-0000-0000-0000-000000000aaa';
const b = '00000000-0000-0000-0000-000000000bbb';

test('the MCP server binds concurrent calls to host metadata, never tool arguments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tincan-mcp-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
if (process.argv[2] !== 'app-server') process.exit(0);
const rl = require('node:readline').createInterface({input: process.stdin});
rl.on('line', line => {
  const m = JSON.parse(line);
  const result = m.method === 'thread/list' ? {data: [
    {id: '${a}', name: 'Alpha', cwd: '/src/alpha'},
    {id: '${b}', name: 'Beta', cwd: '/src/beta'}
  ]} : {};
  process.stdout.write(JSON.stringify({id: m.id, result}) + '\\n');
});
rl.on('close', () => process.exit(0));
`, {mode: 0o755});
  // Keep this fixture away from live process discovery on the test machine.
  for (const name of ['ps', 'lsof']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'dist/tincan.js')],
    env: {PATH: bin, HOME: dir, CODEX_HOME: join(dir, 'codex'), TINCAN_HOME: join(dir, 'tincan'), CLAUDE_CONFIG_DIR: join(dir, 'claude')},
    stderr: 'pipe',
  });
  const client = new Client({name: 'identity-test', version: '1.0.0'});
  try {
    await client.connect(transport);
    const results = await Promise.all([a,b].map(threadId => client.callTool({
      name: 'peers', arguments: {threadId: a}, _meta: {threadId},
    })));
    const selves = results.map(result => {
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{type: string; text: string}>;
      return JSON.parse(content[0]!.text).self;
    });
    expect(selves[0]).toMatchObject({thread_id: a, name: 'alpha.aaa', cwd: '/src/alpha'});
    expect(selves[1]).toMatchObject({thread_id: b, name: 'beta.bbb', cwd: '/src/beta'});
    const invalid = await client.callTool({name: 'peers', _meta: {threadId: 'invalid'}});
    expect(invalid.isError).toBe(true);
    const unknown = await client.callTool({name: 'send_peer', arguments: {peer: 'beta', message: 'probe', threadId: a}});
    expect(JSON.parse((unknown.content as Array<{text: string}>)[0]!.text)).toMatchObject({outcome: 'rejected', refusal: 'self_unknown'});
  } finally {
    await client.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
