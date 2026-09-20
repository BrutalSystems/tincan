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
