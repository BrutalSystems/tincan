import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseMcpArgs,
  runMcp,
  claudeUserConfigPath,
  SERVER_NAME,
  SERVER_DEFINITION,
  ADD_ARGS,
  REMOVE_ARGS,
  type ClaudeResult,
} from '../src/mcp-cli.js';
import { USAGE_EXIT } from '../src/send-cli.js';

/**
 * `tincan mcp install | uninstall | status` — registering Tin Can with Claude
 * Code under the short name `tincan`, so its tools are `mcp__tincan__*`.
 *
 * No test here touches a real Claude config. The unit tests stub `claude` with a
 * function that edits a temp `.claude.json` the way the real CLI does; the
 * binary tests put a fake `claude` script first on PATH and point
 * CLAUDE_CONFIG_DIR at a temp directory.
 */
describe('mcp CLI argument parsing', () => {
  test('accepts the three actions', () => {
    expect(parseMcpArgs(['install'])).toEqual({ ok: true, action: 'install', force: false });
    expect(parseMcpArgs(['uninstall'])).toEqual({ ok: true, action: 'uninstall', force: false });
    expect(parseMcpArgs(['status'])).toEqual({ ok: true, action: 'status', force: false });
  });

  test('takes --force on install only', () => {
    expect(parseMcpArgs(['install', '--force'])).toEqual({ ok: true, action: 'install', force: true });
    expect(parseMcpArgs(['uninstall', '--force']).ok).toBe(false);
    expect(parseMcpArgs(['status', '--force']).ok).toBe(false);
  });

  test('answers --help before any other complaint', () => {
    expect(parseMcpArgs(['--help'])).toEqual({ ok: true, help: true });
    expect(parseMcpArgs(['nonsense', '-h'])).toEqual({ ok: true, help: true });
  });

  test('refuses a missing action rather than guessing one', () => {
    const r = parseMcpArgs([]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('install');
  });

  // The guessed CLI `classifyArgv` was written to refuse must stay refused now
  // that `mcp` is a real word: `tincan mcp peers list` is not a peer listing.
  test('refuses an action it does not know', () => {
    const r = parseMcpArgs(['peers', 'list']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("'peers'");
    expect(r.error).toContain('install, uninstall, status');
  });

  test('refuses unknown flags', () => {
    expect(parseMcpArgs(['install', '--scope', 'project']).ok).toBe(false);
  });
});

describe('the Claude Code user config path', () => {
  test('follows CLAUDE_CONFIG_DIR when it is set', () => {
    expect(claudeUserConfigPath({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/u')).toBe('/cfg/.claude.json');
  });
  test('falls back to ~/.claude.json', () => {
    expect(claudeUserConfigPath({}, '/home/u')).toBe('/home/u/.claude.json');
    expect(claudeUserConfigPath({ CLAUDE_CONFIG_DIR: '' }, '/home/u')).toBe('/home/u/.claude.json');
  });
});

describe('the registration it asks Claude Code for', () => {
  // Bare `tincan` with no arguments is what starts the server (classifyArgv
  // returns `serve` for an empty argv), and it is the shape `claude mcp add`
  // writes for `-- tincan`.
  test('is a stdio server running bare `tincan`', () => {
    expect(SERVER_NAME).toBe('tincan');
    expect(SERVER_DEFINITION).toEqual({ type: 'stdio', command: 'tincan', args: [], env: {} });
    expect(ADD_ARGS).toEqual(['mcp', 'add', '--scope', 'user', 'tincan', '--', 'tincan']);
    expect(REMOVE_ARGS).toEqual(['mcp', 'remove', '--scope', 'user', 'tincan']);
  });
});

/** A stand-in for the `claude` CLI that edits a temp `.claude.json` as the real one does. */
function fakeClaude(configPath: string, opts: { missing?: boolean; failAdd?: boolean } = {}) {
  const calls: (readonly string[])[] = [];
  const read = (): Record<string, unknown> =>
    existsSync(configPath) ? (JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>) : {};
  const write = (j: Record<string, unknown>) => writeFileSync(configPath, JSON.stringify(j, null, 2));
  const run = async (args: readonly string[]): Promise<ClaudeResult> => {
    calls.push(args);
    if (opts.missing) return { notFound: true, code: null, stdout: '', stderr: '' };
    if (args[0] === '--version') return { code: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' };
    const j = read();
    const servers = (j.mcpServers ?? {}) as Record<string, unknown>;
    if (args[1] === 'add') {
      if (opts.failAdd) return { code: 1, stdout: '', stderr: 'boom\n' };
      if (servers.tincan !== undefined) {
        return { code: 1, stdout: '', stderr: 'MCP server tincan already exists in user config\n' };
      }
      servers.tincan = { type: 'stdio', command: 'tincan', args: [], env: {} };
      write({ ...j, mcpServers: servers });
      return { code: 0, stdout: 'Added stdio MCP server tincan\n', stderr: '' };
    }
    if (args[1] === 'remove') {
      if (servers.tincan === undefined) return { code: 1, stdout: '', stderr: 'No MCP server named "tincan"\n' };
      delete servers.tincan;
      write({ ...j, mcpServers: servers });
      return { code: 0, stdout: 'Removed\n', stderr: '' };
    }
    return { code: 2, stdout: '', stderr: `unexpected ${args.join(' ')}\n` };
  };
  return { run, calls, read, write };
}

describe('runMcp', () => {
  let dir: string;
  let configPath: string;
  let out: string;
  let err: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tincan-mcpcli-'));
    configPath = join(dir, '.claude.json');
    out = '';
    err = '';
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const io = (run: (args: readonly string[]) => Promise<ClaudeResult>) => ({
    stdout: (s: string) => {
      out += s;
    },
    stderr: (s: string) => {
      err += s;
    },
    env: { CLAUDE_CONFIG_DIR: dir } as NodeJS.ProcessEnv,
    home: '/nonexistent-home',
    run,
  });

  const mutations = (calls: (readonly string[])[]) => calls.filter((c) => c[0] === 'mcp');

  describe('install', () => {
    test('registers tincan at user scope when it is absent', async () => {
      const claude = fakeClaude(configPath);
      const code = await runMcp(['install'], io(claude.run));
      expect(code).toBe(0);
      expect(mutations(claude.calls)).toEqual([ADD_ARGS]);
      expect((claude.read().mcpServers as Record<string, unknown>).tincan).toEqual(SERVER_DEFINITION);
      expect(out).toContain('Registered');
      expect(out).toContain(configPath);
      expect(out).toMatch(/restart/i);
    });

    test('changes nothing when the same definition is already there', async () => {
      const claude = fakeClaude(configPath);
      // Written without `env`, as an older hand registration may have been: the
      // same server, and must read as the same.
      claude.write({ mcpServers: { tincan: { type: 'stdio', command: 'tincan', args: [] } } });
      const code = await runMcp(['install'], io(claude.run));
      expect(code).toBe(0);
      expect(mutations(claude.calls)).toEqual([]);
      expect(out).toMatch(/already registered/i);
      expect(out).toMatch(/nothing changed/i);
    });

    test('refuses to replace a different definition without --force', async () => {
      const claude = fakeClaude(configPath);
      const other = { type: 'stdio', command: 'node', args: ['/x/dist/tincan.js'] };
      claude.write({ mcpServers: { tincan: other } });
      const code = await runMcp(['install'], io(claude.run));
      expect(code).toBe(2);
      expect(mutations(claude.calls)).toEqual([]);
      expect(err).toContain('/x/dist/tincan.js');
      expect(err).toContain('--force');
      expect((claude.read().mcpServers as Record<string, unknown>).tincan).toEqual(other);
    });

    test('replaces a different definition with --force', async () => {
      const claude = fakeClaude(configPath);
      claude.write({ mcpServers: { tincan: { type: 'stdio', command: 'node', args: ['/x/dist/tincan.js'] } } });
      const code = await runMcp(['install', '--force'], io(claude.run));
      expect(code).toBe(0);
      expect(mutations(claude.calls)).toEqual([REMOVE_ARGS, ADD_ARGS]);
      expect((claude.read().mcpServers as Record<string, unknown>).tincan).toEqual(SERVER_DEFINITION);
      expect(out).toContain('Replaced');
      expect(out).toContain('/x/dist/tincan.js');
    });

    test('leaves other servers alone', async () => {
      const claude = fakeClaude(configPath);
      claude.write({ keep: 1, mcpServers: { other: { type: 'stdio', command: 'x', args: [] } } });
      await runMcp(['install'], io(claude.run));
      const j = claude.read();
      expect(j.keep).toBe(1);
      expect((j.mcpServers as Record<string, unknown>).other).toBeDefined();
    });

    test('fails clearly when claude is not on PATH', async () => {
      const claude = fakeClaude(configPath, { missing: true });
      const code = await runMcp(['install'], io(claude.run));
      expect(code).toBe(1);
      expect(err).toMatch(/`claude`.*not on PATH/);
      expect(existsSync(configPath)).toBe(false);
    });

    test('reports claude’s own error when the add fails', async () => {
      const claude = fakeClaude(configPath, { failAdd: true });
      const code = await runMcp(['install'], io(claude.run));
      expect(code).toBe(1);
      expect(err).toContain('boom');
    });

    test('refuses to guess when the config file is not JSON', async () => {
      writeFileSync(configPath, '{ not json');
      const claude = fakeClaude(configPath);
      const code = await runMcp(['install'], io(claude.run));
      expect(code).toBe(1);
      expect(mutations(claude.calls)).toEqual([]);
      expect(err).toContain(configPath);
    });
  });

  describe('uninstall', () => {
    test('removes it when present', async () => {
      const claude = fakeClaude(configPath);
      claude.write({ mcpServers: { tincan: SERVER_DEFINITION } });
      const code = await runMcp(['uninstall'], io(claude.run));
      expect(code).toBe(0);
      expect(mutations(claude.calls)).toEqual([REMOVE_ARGS]);
      expect((claude.read().mcpServers as Record<string, unknown>).tincan).toBeUndefined();
      expect(out).toContain('Removed');
    });

    test('is a no-op with a message when absent', async () => {
      const claude = fakeClaude(configPath);
      const code = await runMcp(['uninstall'], io(claude.run));
      expect(code).toBe(0);
      expect(mutations(claude.calls)).toEqual([]);
      expect(out).toMatch(/not registered/i);
    });

    test('fails clearly when claude is not on PATH', async () => {
      const claude = fakeClaude(configPath, { missing: true });
      const code = await runMcp(['uninstall'], io(claude.run));
      expect(code).toBe(1);
      expect(err).toMatch(/not on PATH/);
    });
  });

  describe('status', () => {
    test('says when it is registered as install would register it', async () => {
      const claude = fakeClaude(configPath);
      claude.write({ mcpServers: { tincan: SERVER_DEFINITION } });
      const code = await runMcp(['status'], io(claude.run));
      expect(code).toBe(0);
      expect(out).toMatch(/registered/i);
      expect(out).toContain('"command":"tincan"');
      expect(mutations(claude.calls)).toEqual([]);
    });

    test('exits non-zero when absent', async () => {
      const claude = fakeClaude(configPath);
      const code = await runMcp(['status'], io(claude.run));
      expect(code).toBe(1);
      expect(out).toMatch(/not registered/i);
      expect(out).toContain('tincan mcp install');
    });

    test('exits non-zero and shows both when the definition differs', async () => {
      const claude = fakeClaude(configPath);
      claude.write({ mcpServers: { tincan: { type: 'stdio', command: 'node', args: ['/x'] } } });
      const code = await runMcp(['status'], io(claude.run));
      expect(code).toBe(1);
      expect(out).toContain('"command":"node"');
      expect(out).toContain('--force');
    });
  });

  test('a usage error exits 64 and touches nothing', async () => {
    const claude = fakeClaude(configPath);
    const code = await runMcp(['peers', 'list'], io(claude.run));
    expect(code).toBe(USAGE_EXIT);
    expect(claude.calls).toEqual([]);
    expect(out).toBe('');
  });

  test('--help prints on stdout and exits 0', async () => {
    const claude = fakeClaude(configPath);
    const code = await runMcp(['--help'], io(claude.run));
    expect(code).toBe(0);
    expect(out).toContain('tincan mcp install');
    expect(claude.calls).toEqual([]);
  });
});

/**
 * The built binary, with a fake `claude` first on PATH. Proves the real
 * `execFile` path: argv reaches `claude` intact, and a missing `claude` is
 * reported rather than crashing.
 */
describe('the built binary', () => {
  let dir: string;
  let bin: string;
  let cfg: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tincan-mcpbin-'));
    bin = join(dir, 'bin');
    cfg = join(dir, 'cfg');
    mkdirSync(bin);
    mkdirSync(cfg);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[], path: string): Promise<{ code: number; out: string; err: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [join(process.cwd(), 'dist', 'tincan.js'), ...args], {
        env: { PATH: path, HOME: dir, TINCAN_HOME: dir, CLAUDE_CONFIG_DIR: cfg },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    });

  test('install runs `claude mcp add --scope user tincan -- tincan`', async () => {
    // Records its argv and writes the entry the real CLI would.
    const log = join(dir, 'calls.log');
    const script = [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${log}'`,
      'if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then',
      `  printf '%s' '{"mcpServers":{"tincan":{"type":"stdio","command":"tincan","args":[],"env":{}}}}' > "$CLAUDE_CONFIG_DIR/.claude.json"`,
      'fi',
      'exit 0',
      '',
    ].join('\n');
    writeFileSync(join(bin, 'claude'), script);
    chmodSync(join(bin, 'claude'), 0o755);

    const r = await run(['mcp', 'install'], `${bin}:/usr/bin:/bin`);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('mcp add --scope user tincan -- tincan');

    const again = await run(['mcp', 'install'], `${bin}:/usr/bin:/bin`);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/already registered/i);
  });

  test('install fails clearly with no claude on PATH', async () => {
    const r = await run(['mcp', 'install'], bin);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not on PATH/);
  });

  // The refusal classifyArgv exists for: a guessed `tincan mcp peers list` must
  // exit non-zero instead of starting a server that prints nothing.
  test('a guessed `tincan mcp peers list` is refused, not served', async () => {
    const r = await run(['mcp', 'peers', 'list'], bin);
    expect(r.code).toBe(USAGE_EXIT);
    expect(r.out).toBe('');
    expect(r.err).toContain("'peers'");
  });
});
