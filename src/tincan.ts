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
import { detectRuntime, buildSide, claudeRegistryDir } from './runtime.js';
import { toolDefinitions } from './tool-definitions.js';
import { createTools, type SendPeerArgs, type MessageLogArgs } from './tools.js';
import { MessageLog, messagesPath } from './log.js';
import { VERSION, versionLine, helpText, classifyArgv, unknownArgText } from './version.js';

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
  const side = buildSide(runtime, {
    registryDir: claudeRegistryDir(),
    pid: process.pid,
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
    try {
      switch (name) {
        case 'peers':
          return text(await tools.peers());
        case 'send_peer':
          return text(await tools.send_peer(args as SendPeerArgs));
        case 'message_log':
          return text(await tools.message_log(args as MessageLogArgs));
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
