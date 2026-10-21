/**
 * `tincan mcp install | uninstall | status` — register Tin Can with Claude Code.
 *
 * The name is the point. Claude Code names an MCP server's tools
 * `mcp__<server>__<tool>`, so registering at user scope under `tincan` gives
 * the short `mcp__tincan__send_peer` in every project. The Claude Code plugin
 * also bundles the server (plugins/claude-code/.mcp.json), for installs with no
 * global binary, and Claude Code registers that one under a plugin-qualified
 * name, `mcp__plugin_tincan_tincan__*`. This command is the route to the short
 * name. A session should have one or the other: with both it runs two servers.
 *
 * Writes go through `claude mcp add` / `claude mcp remove`, never into Claude
 * Code's config directly: that file is Claude Code's, and its CLI is the
 * supported way to change it. Reads look at the file, because `claude mcp get`
 * health-checks the server it describes — it would start a Tin Can to answer
 * "is one registered?" — and prints for humans rather than for a comparison.
 *
 * `CLAUDE_CONFIG_DIR` is respected without any effort here: the `claude` child
 * inherits it, and `claudeUserConfigPath` reads the same file it writes.
 */
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { USAGE_EXIT } from './send-cli.js';
import { mcpHelpText } from './version.js';

/** The server name, and so the `mcp__tincan__` tool prefix. */
export const SERVER_NAME = 'tincan';

/**
 * What `claude mcp add --scope user tincan -- tincan` writes. Bare `tincan`
 * with no arguments is what starts the server (`classifyArgv([])` is `serve`),
 * and the binary is on PATH once installed, so no path is baked in.
 */
export const SERVER_DEFINITION = {
  type: 'stdio',
  command: 'tincan',
  args: [] as string[],
  env: {} as Record<string, string>,
} as const;

export const ADD_ARGS: readonly string[] = ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', 'tincan'];
export const REMOVE_ARGS: readonly string[] = ['mcp', 'remove', '--scope', 'user', SERVER_NAME];

export const MCP_ACTIONS = ['install', 'uninstall', 'status'] as const;
export type McpAction = (typeof MCP_ACTIONS)[number];

/** Every flag `mcp` takes, for the help/argv parity check in version.test.ts. */
export const MCP_FLAGS: readonly string[] = ['--force'];

const HELP_FLAGS = ['--help', '-h'] as const;

export type McpCliParse =
  | { ok: true; help: true }
  | { ok: true; help?: undefined; action: McpAction; force: boolean }
  | { ok: false; error: string };

/** The result of one `claude` invocation. `notFound` means it is not on PATH. */
export interface ClaudeResult {
  notFound?: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Parse `mcp`'s arguments. Strict for the same reason `parseSendArgs` is: a
 * guessed `tincan mcp peers list` must be refused, not read as something else.
 */
export function parseMcpArgs(argv: string[]): McpCliParse {
  if (argv.some((a) => (HELP_FLAGS as readonly string[]).includes(a))) {
    return { ok: true, help: true };
  }
  const [action, ...rest] = argv;
  if (action === undefined) {
    return { ok: false, error: `tincan mcp: needs an action: ${MCP_ACTIONS.join(', ')}.` };
  }
  if (!(MCP_ACTIONS as readonly string[]).includes(action)) {
    return {
      ok: false,
      error: `tincan mcp: unrecognised action '${action}'. Actions: ${MCP_ACTIONS.join(', ')}.`,
    };
  }
  let force = false;
  for (const token of rest) {
    if (token === '--force' && action === 'install' && !force) {
      force = true;
      continue;
    }
    const accepted = action === 'install' ? '--force' : 'none';
    return {
      ok: false,
      error: `tincan mcp ${action}: unrecognised argument '${token}'. Accepted: ${accepted}.`,
    };
  }
  return { ok: true, action: action as McpAction, force };
}

/** Where Claude Code keeps user-scope MCP servers for this profile. */
export function claudeUserConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir !== undefined && dir.length > 0 ? join(dir, '.claude.json') : join(home, '.claude.json');
}

type Registration =
  | { state: 'absent' }
  | { state: 'present'; definition: unknown }
  | { state: 'unreadable'; error: string };

function readRegistration(path: string): Registration {
  if (!existsSync(path)) return { state: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { state: 'unreadable', error: e instanceof Error ? e.message : String(e) };
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (servers === undefined || servers === null || typeof servers !== 'object') return { state: 'absent' };
  const definition = (servers as Record<string, unknown>)[SERVER_NAME];
  return definition === undefined ? { state: 'absent' } : { state: 'present', definition };
}

/**
 * Whether a registration is the one install writes. Defaults are filled in
 * first: an entry written without `type`, `args` or `env` starts the same
 * server, and calling it different would make `--force` the only way past a
 * registration that was already right.
 */
export function isOurDefinition(definition: unknown): boolean {
  if (definition === null || typeof definition !== 'object') return false;
  const d = definition as Record<string, unknown>;
  const normalised = { type: 'stdio', args: [], env: {}, ...d };
  return isDeepStrictEqual(normalised, SERVER_DEFINITION);
}

const show = (v: unknown) => JSON.stringify(v);

const NOT_ON_PATH =
  'tincan mcp: `claude` (the Claude Code CLI) is not on PATH, and registering an ' +
  'MCP server goes through it. Install Claude Code, or put `claude` on PATH, ' +
  'then run this again.';

/** Run `claude` for real. The test seam is `runMcp`'s `run`. */
export function runClaude(args: readonly string[]): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    execFile('claude', [...args], { encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => {
      if (err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ notFound: true, code: null, stdout: '', stderr: '' });
        return;
      }
      const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

/** Run one `tincan mcp ...` and answer with an exit code: 0 ok, 1 failed, 2 refused, 64 usage. */
export async function runMcp(
  argv: string[],
  io: {
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    env: NodeJS.ProcessEnv;
    home: string;
    run: (args: readonly string[]) => Promise<ClaudeResult>;
  },
): Promise<number> {
  const parsed = parseMcpArgs(argv);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\nRun 'tincan mcp --help' for usage.\n`);
    return USAGE_EXIT;
  }
  if (parsed.help === true) {
    io.stdout(`${mcpHelpText()}\n`);
    return 0;
  }

  const path = claudeUserConfigPath(io.env, io.home);
  const where = `Claude Code user scope (${path})`;
  const fail = (msg: string): number => {
    io.stderr(`${msg}\n`);
    return 1;
  };

  const current = readRegistration(path);
  if (current.state === 'unreadable') {
    return fail(`tincan mcp: cannot read ${path} as JSON (${current.error}). Nothing was changed.`);
  }

  if (parsed.action === 'status') {
    if (current.state === 'absent') {
      io.stdout(`tincan is not registered at ${where}. Run 'tincan mcp install'.\n`);
      return 1;
    }
    if (isOurDefinition(current.definition)) {
      io.stdout(`tincan is registered at ${where}: ${show(current.definition)}\n`);
      return 0;
    }
    io.stdout(
      `tincan is registered at ${where}, but not as 'tincan mcp install' would register it:\n` +
        `  registered: ${show(current.definition)}\n` +
        `  install:    ${show(SERVER_DEFINITION)}\n` +
        `Run 'tincan mcp install --force' to replace it.\n`,
    );
    return 1;
  }

  // Both writing actions need `claude`. Checked before deciding anything, so a
  // machine without it gets one clear answer rather than one that depends on
  // what happens to be in the config.
  const probe = await io.run(['--version']);
  if (probe.notFound === true) return fail(NOT_ON_PATH);

  const claude = async (args: readonly string[]): Promise<string | undefined> => {
    const r = await io.run(args);
    if (r.notFound === true) return NOT_ON_PATH;
    if (r.code === 0) return undefined;
    const detail = (r.stderr || r.stdout).trim();
    return `tincan mcp: \`claude ${args.join(' ')}\` failed (exit ${r.code ?? 'signal'})${detail ? `: ${detail}` : '.'}`;
  };

  if (parsed.action === 'uninstall') {
    if (current.state === 'absent') {
      io.stdout(`tincan is not registered at ${where}. Nothing to remove.\n`);
      return 0;
    }
    const error = await claude(REMOVE_ARGS);
    if (error !== undefined) return fail(error);
    io.stdout(
      `Removed tincan from ${where} (was ${show(current.definition)}). ` +
        `Restart Claude Code sessions to drop it.\n`,
    );
    return 0;
  }

  // install
  if (current.state === 'present' && isOurDefinition(current.definition)) {
    io.stdout(`tincan is already registered at ${where}: ${show(current.definition)}. Nothing changed.\n`);
    return 0;
  }
  if (current.state === 'present' && !parsed.force) {
    io.stderr(
      `tincan mcp: a different 'tincan' server is already registered at ${where}:\n` +
        `  registered: ${show(current.definition)}\n` +
        `  install:    ${show(SERVER_DEFINITION)}\n` +
        `Nothing was changed. Run 'tincan mcp install --force' to replace it.\n`,
    );
    return 2;
  }
  if (current.state === 'present') {
    const error = await claude(REMOVE_ARGS);
    if (error !== undefined) return fail(error);
  }
  const error = await claude(ADD_ARGS);
  if (error !== undefined) return fail(error);

  // Confirm it landed where we look. If Claude Code ever moves this file, the
  // add succeeds and status reports nothing — better to say so now.
  const after = readRegistration(path);
  if (after.state !== 'present' || !isOurDefinition(after.definition)) {
    return fail(
      `tincan mcp: \`claude ${ADD_ARGS.join(' ')}\` succeeded, but ${path} does not show ` +
        `the registration. Check with 'claude mcp get tincan'.`,
    );
  }

  const verb =
    current.state === 'present'
      ? `Replaced tincan at ${where} (was ${show(current.definition)}) with`
      : `Registered tincan at ${where}:`;
  io.stdout(
    `${verb} ${show(SERVER_DEFINITION)}\n` +
      `Restart Claude Code sessions to load it; its tools appear as mcp__tincan__*.\n`,
  );
  return 0;
}
