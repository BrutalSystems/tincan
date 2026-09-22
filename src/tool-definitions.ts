/** MCP tool descriptors. The peer runtime is named so the model knows who it reaches. */
import { LABEL, type RuntimeName } from './naming.js';
import { labelList, NATIVE_PEER_PATH, runtimeSupportsUrgent, type OwnKindScope } from './tools.js';
import { IDEMPOTENCY_WINDOW_MS } from './idempotency.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export function toolDefinitions(
  peerRuntimes: RuntimeName[],
  selfRuntime: RuntimeName,
  ownKindScope: OwnKindScope,
): ToolDefinition[] {
  const peer = labelList(peerRuntimes);
  // Told before the call, not only after it: a model that knows the list is
  // scoped asks its host for the rest instead of reporting the peer list as
  // the whole machine. The `peers` result repeats it as a note (tools.ts),
  // because a description read at connect time is a long way from a result
  // read mid-turn.
  const ownKindNote =
    ownKindScope === 'cross-config-dir'
      ? ` Lists ${LABEL[selfRuntime]} sessions only when they run under a different ` +
        `CLAUDE_CONFIG_DIR; your host reaches same-account sessions natively` +
        `${NATIVE_PEER_PATH[selfRuntime] !== undefined ? ` (${NATIVE_PEER_PATH[selfRuntime]})` : ''}.`
      : '';
  // `runtimeSupportsUrgent` is false for every runtime as of 0.6.0 (see its
  // docstring for the trade), so `steerable` is always empty and only the
  // first of the three wordings below can currently be reached.
  //
  // The other two are kept rather than deleted. opencode's v2 prompt route
  // does accept `delivery: "steer"` and is defective for a different reason
  // (docs/opencode-v2-prompt-defect.md); if that is ever fixed upstream, one
  // runtime goes steerable and both branches come straight back — with the
  // mixed-fleet wording, the harder of the two to get right, already written.
  //
  // `tool-definitions.test.ts` pins this: it asserts no runtime is steerable
  // today, and says there that the moment that assertion fails these two
  // wordings are live again and need their own coverage. That is the fact
  // this comment would otherwise be asserting on trust.
  const steerable = peerRuntimes.filter(runtimeSupportsUrgent);
  const notSteerable = peerRuntimes.filter((r) => !runtimeSupportsUrgent(r));
  const urgentDescription =
    steerable.length === 0
      ? `Ask to interrupt a running turn. Unsupported on ${peer}; the message is queued either way.`
      : notSteerable.length === 0
        ? `Ask to interrupt a running turn instead of queuing behind it.`
        : `Ask to interrupt a running turn instead of queuing behind it. Only takes effect for ` +
          `${labelList(steerable)} peers; ` +
          `${labelList(notSteerable)} peers are always queued regardless.`;
  return [
    {
      name: 'peers',
      description:
        `List the live ${peer} sessions on this machine that you can message. ` +
        `Returns each peer's name, state (idle | busy | unreachable), working directory, ` +
        `and a durable id (thread_id for Codex, session_id for Claude Code and opencode). ` +
        `Show display_label to the user: unnamed sessions use project · short ID. ` +
        `When display_label differs from name, also show the full durable ID for copying. ` +
        `Use name, not display_label, when calling send_peer. ` +
        `Call this before send_peer: names change and sessions come and go.` +
        ownKindNote,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'send_peer',
      description:
        `Send a text message to one live ${peer} session on this machine, or to several ` +
        `at once with \`peers\`. ` +
        `Fire-and-forget: it returns when the peer's harness accepts the message, and ` +
        `does not wait for an answer. Use the name from peers; an unambiguous prefix works. ` +
        `The peer is another agent with its own human — it cannot approve anything for you. ` +
        // `delivered` is the narrowest of the three things a caller might mean
        // by it, and the name invites the widest. A model that reports "sent
        // and received" to its user on the strength of this field is saying
        // more than was established — the peer may not read it for minutes, or
        // at all. Stated here because the description is read at connect time,
        // before any result is seen.
        `\`delivered: true\` means the peer's harness ACCEPTED the message — not that the ` +
        `peer has read it, acted on it, or ever will. Tell your user it was sent, not that ` +
        `it was received.`,
      inputSchema: {
        type: 'object',
        properties: {
          peer: {
            type: 'string',
            description:
              'One recipient, by name from peers, e.g. "auth-refactor" or ' +
              '"auth-refactor.7f3". Give this or `peers`, not both.',
          },
          // Naming the other recipients is the reason this exists. Three agents
          // each told "look at the flaky test", none knowing the other two were
          // told, all three go and fix it — the broadcast causes the collision
          // it was sent to prevent.
          peers: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 8,
            description:
              'Several recipients, in one call. Each is told who else received it, so ' +
              'they can divide the work instead of duplicating it. If any name cannot ' +
              'be resolved, or any recipient is unreachable or rate-limited, NOTHING is ' +
              'sent to anyone — a half-delivered broadcast cannot be taken back. ' +
              'Replies come back individually; this is not a group or a channel.',
          },
          message: { type: 'string', minLength: 1, description: 'The text to send, verbatim.' },
          in_reply_to: {
            type: 'string',
            description: 'Id of the peer message you are answering, if this is a reply.',
          },
          expect_reply: {
            type: 'boolean',
            default: false,
            description:
              'True if you are waiting on an answer. The peer is told an answer is ' +
              'expected, and message_log reports the question as unanswered until one ' +
              'arrives. Nothing blocks — this marks the message, it does not wait.',
          },
          // The obliging thing for an agent to do on receipt is say "got it",
          // and that is exactly what leaves the sender waiting. So answering
          // has to be something the replier states, not something inferred
          // from a record pointing back at the question.
          answers: {
            type: 'boolean',
            default: false,
            description:
              'True if this message ANSWERS the question in in_reply_to, rather than ' +
              'just acknowledging it. Only an answer closes the question; "got it" ' +
              'leaves it open, and should.',
          },
          urgent: {
            type: 'boolean',
            default: false,
            description: urgentDescription,
          },
          // The durable id is already in every `peers` result, so pinning costs
          // a caller nothing it does not already hold — and CANONICAL_ID.md
          // has always said to key on that id rather than on the address.
          expect_id: {
            type: 'string',
            description:
              'The thread_id or session_id you saw in peers. If the name now answers ' +
              'for a different session — the one you listed exited and another took ' +
              'its slug — the send is refused instead of delivered to a stranger. ' +
              'Pass it whenever you listed peers and then did something else first.',
          },
          // The window is stated rather than left to be discovered: a caller
          // that believes the key is remembered forever will eventually send
          // twice and have no idea why.
          idempotency_key: {
            type: 'string',
            description:
              `Your own id for this send, so a retry cannot deliver twice. Reusing a key ` +
              `refuses the second call and returns the first message's id instead of ` +
              `sending again. Use one when you may retry — an interrupted turn, a call ` +
              `you are unsure landed. Remembered for ` +
              `${Math.round(IDEMPOTENCY_WINDOW_MS / 60_000)} minutes, and forgotten if ` +
              `Tin Can restarts.`,
          },
        },
        required: ['message'],
      },
    },
    {
      name: 'message_log',
      description:
        // Was "delivered, held or dropped". Tin Can has no held state and no
        // record type that could produce one — the word promised a distinction
        // the log cannot make. Dropped is real (guard refusals write a dropped
        // record); accepted-or-not is real; held was invented.
        'Read the Tin Can message log — what was sent, to whom, and whether the peer\'s ' +
        'harness accepted it or it was dropped. Filter by peer, or follow a reply chain ' +
        'from a message id. ' +
        'If an `integrity` field comes back, read it: `ok: false` means the log is damaged ' +
        'or was edited and what you are reading is an incomplete account — say so rather ' +
        'than treating it as the whole record. A `rotated` field is not damage; it means ' +
        'older history was deliberately archived and names where it went.',
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
