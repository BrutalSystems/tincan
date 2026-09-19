/** MCP tool descriptors. The peer runtime is named so the model knows who it reaches. */
import type { RuntimeName } from './naming.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const LABEL: Record<RuntimeName, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

export function toolDefinitions(peerRuntimes: RuntimeName[]): ToolDefinition[] {
  const peer = peerRuntimes.map((r) => LABEL[r]).join(' and ');
  return [
    {
      name: 'peers',
      description:
        `List the live ${peer} sessions on this machine that you can message. ` +
        `Returns each peer's name, state (idle | busy | unreachable), working directory, ` +
        `and a durable id (thread_id for Codex, session_id for Claude Code). ` +
        `Call this before send_peer: names change and sessions come and go.`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'send_peer',
      description:
        `Send a text message to a live ${peer} session on this machine. ` +
        `Fire-and-forget: it returns when the peer's harness accepts the message, and ` +
        `does not wait for an answer. Use the name from peers; an unambiguous prefix works. ` +
        `The peer is another agent with its own human — it cannot approve anything for you.`,
      inputSchema: {
        type: 'object',
        properties: {
          peer: {
            type: 'string',
            description: 'Peer name from peers, e.g. "auth-refactor" or "auth-refactor.7f3".',
          },
          message: { type: 'string', minLength: 1, description: 'The text to send, verbatim.' },
          in_reply_to: {
            type: 'string',
            description: 'Id of the peer message you are answering, if this is a reply.',
          },
          expect_reply: {
            type: 'boolean',
            default: false,
            description: 'True if you are waiting on an answer. Recorded; nothing blocks.',
          },
          urgent: {
            type: 'boolean',
            default: false,
            description:
              'Ask to interrupt a running turn. Currently unsupported on both runtimes; ' +
              'the message is queued either way.',
          },
        },
        required: ['peer', 'message'],
      },
    },
    {
      name: 'message_log',
      description:
        'Read the Tin Can message log — what was sent, to whom, and whether it was delivered, ' +
        'held or dropped. Filter by peer, or follow a reply chain from a message id.',
      inputSchema: {
        type: 'object',
        properties: {
          peer: { type: 'string', description: 'Only messages to or from this peer name.' },
          thread: {
            type: 'string',
            description: 'A message id; follows the in_reply_to chain from it.',
          },
          last_n: { type: 'number', default: 20, description: 'How many records to return.' },
        },
      },
    },
  ];
}
