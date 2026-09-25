#!/usr/bin/env node
/**
 * Tin Can — peer messaging between two already-running attended agent sessions
 * on one machine. One binary, hosted as a stdio MCP server inside each.
 *
 * stdout is the MCP transport: never write to it (§8.1).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { detectRuntime, buildSide, claudeRegistryDirs } from './runtime.js';
import { startSelfPointerRefresh, syncSelfPointer } from './claude/self.js';
import { toolDefinitions } from './tool-definitions.js';
import { createTools, type SendPeerArgs, type MessageLogArgs } from './tools.js';
import { MessageLog, messagesPath } from './log.js';
import { VERSION, versionLine, helpText, classifyArgv, unknownArgText } from './version.js';

/**
 * Test seam, and an operator's escape hatch if the default is ever wrong.
 * Floored rather than trusted: a zero or a negative would spin the event loop,
 * and this runs in every session on the machine.
 */
function refreshMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.TINCAN_SELF_REFRESH_MS;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(250, n) : undefined;
}

function diag(msg: string): void {
  process.stderr.write(`[tincan] ${msg}\n`);
}

/**
 * `--version` and `--help` must print to stdout and exit WITHOUT starting the
 * server. stdout is the MCP transport (§8.1), so writing to it is only safe
 * here, where no transport is ever connected.
 */
function handleArgv(argv: string[]): boolean {
  const intent = classifyArgv(argv);
  switch (intent.kind) {
    case 'version':
      process.stdout.write(`${versionLine()}\n`);
      return true;
    case 'help':
      process.stdout.write(`${helpText()}\n`);
      return true;
    case 'unknown':
      // stderr, and a non-zero exit: a caller that guessed at a CLI must not
      // mistake silence for an empty result.
      process.stderr.write(`${unknownArgText(intent.arg)}\n`);
      process.exitCode = 2;
      return true;
    case 'serve':
      return false;
  }
}

async function main(): Promise<void> {
  if (handleArgv(process.argv.slice(2))) return;

  const runtime = detectRuntime(process.env);

  // Announce which config dir we are in, so another Tin Can can find sessions
  // its own CLAUDE_CONFIG_DIR hides. Claude Code only: no other runtime
  // partitions its registry this way.
  //
  // 'exit' only, deliberately. Registering a SIGINT or SIGTERM listener
  // suppresses Node's default disposition, and calling process.exit() from one
  // would cut short an in-flight MessageLog write. There is nothing to gain by
  // it either: readPointers already prunes any record whose pid is dead, so a
  // record left behind by a kill costs a listing nothing.
  if (runtime === 'claude-code') {
    // Refreshed on an interval, not written once. Claude Code assigns this
    // session's real id moments AFTER spawning us, so a single write at
    // startup records the boot id and is wrong almost every time — which
    // advertises this session to every peer as unable to reply. The interval
    // is unref'd, so it never holds the process open.
    const unregister = startSelfPointerRefresh(process.env, process.ppid, {
      ...(refreshMs(process.env) !== undefined && { intervalMs: refreshMs(process.env) }),
    });
    process.on('exit', unregister);
  }
  const side = buildSide(runtime, {
    registryDirs: () => claudeRegistryDirs(process.env),
    pid: process.pid,
    // The session's pid, not ours: the record the harness keeps there is the
    // only current statement of which session we are inside.
    ppid: process.ppid,
    cwd: process.cwd(),
  });

  const log = new MessageLog(messagesPath(process.env));
  const tools = createTools(side, log);
  const definitions = toolDefinitions(side.peerRuntimes);

  const server = new Server(
    { name: 'tincan', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    // Belt to the interval's braces, and free: any tool call is a moment we
    // know we are alive, so it is a moment to confirm the registration still
    // names the session we are actually in.
    if (runtime === 'claude-code') {
      try {
        syncSelfPointer(process.env, process.ppid);
      } catch {
        /* never fail a tool call over the pointer */
      }
    }
    try {
      switch (name) {
        case 'peers':
          return text(await tools.peers());
        case 'send_peer':
          return text(await tools.send_peer(args as SendPeerArgs));
        case 'message_log':
          return text(await tools.message_log(args as MessageLogArgs));
        case 'reregister':
          return text(await tools.reregister());
        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      diag(`${name} failed: ${message}`);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });

  diag(
    `hosted in ${runtime} as "${await side.selfName(await side.resolveSelf())}"; ` +
      `peers are ${side.peerRuntimes.join(' + ')} sessions`,
  );
  await server.connect(new StdioServerTransport());
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

main().catch((e: unknown) => {
  diag(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
