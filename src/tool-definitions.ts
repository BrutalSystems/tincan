/** MCP tool descriptors. The peer runtime is named so the model knows who it reaches. */
import { PEER_STATES } from './claude/discover.js';
import { type RuntimeName } from './naming.js';
import {
  DEFAULT_LAST_N,
  labelList,
  MAX_FANOUT,
  MAX_REPLAY_MINUTES,
  runtimeSupportsUrgent,
} from './tools.js';
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

export function toolDefinitions(peerRuntimes: RuntimeName[]): ToolDefinition[] {
  const peer = labelList(peerRuntimes);
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
        `Returns each peer's name, state (${PEER_STATES.join(' | ')}), working directory, ` +
        `and a durable id (thread_id for Codex, session_id for Claude Code and opencode). ` +
        `A peer carrying \`status_unreadable\` is reported busy as a safe default, not ` +
        `because it was observed busy — treat it as busy, and do not report its state as ` +
        `a fact. ` +
        `Show display_label to the user: unnamed sessions use project · short ID. ` +
        `When display_label differs from name, also show the full durable ID for copying. ` +
        `Use name, not display_label, when calling send_peer. ` +
        `Also returns tincan_version: the Tin Can serving this call, and per peer the ` +
        `version its own Tin Can recorded — report those rather than shelling out to ` +
        `\`tincan --version\`, which reports whatever is on PATH instead of what is running. ` +
        `Call this before send_peer: names change and sessions come and go.`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'reregister',
      description:
        `Re-publish this session's Tin Can registration so peers can see it can reply. ` +
        `Tin Can does this automatically; call it when a peer reports this session as ` +
        `unreachable, or when an arriving message claims this session has no send_peer to ` +
        `answer with — that claim is the symptom of a stale registration, not a fact about ` +
        `your tools. Returns the session id it now holds, and the one it replaced if it had ` +
        `drifted. Safe to call at any time: it writes only when something has actually moved.`,
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
        // The three states are named rather than left to a boolean because the
        // caller's correct next move differs for each, and a model that cannot
        // tell them apart retries the one case where retrying cannot work.
        `Returns \`outcome\`: \`accepted\` means the peer's harness took the message — NOT ` +
        `that the peer has read it, acted on it, or ever will, so tell your user it was ` +
        `sent, not that it was received. \`rejected\` means nothing was sent and something ` +
        `about the call needs fixing (see \`refusal\`); sending it again unchanged will fail ` +
        `the same way. \`failed\` means it was attempted and the peer or transport did not ` +
        `take it; nothing you did is wrong and later may work. ` +
        `For \`peers\`, you get \`requested\` and \`accepted\` counts plus a \`results\` entry ` +
        `per recipient instead.`,
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
            maxItems: MAX_FANOUT,
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
          // Stated as opt-in, with its precondition, because both halves are
          // silent when wrong: nothing is replayed by default, and a duration
          // without expect_id records an attempt that will never be collected.
          replay_for_minutes: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_REPLAY_MINUTES,
            description:
              `If the peer cannot be reached, leave this message for it to collect when ` +
              `it comes back, for this many minutes. Nothing is replayed unless you ask: ` +
              `without this, a send to a session that is down is recorded and never ` +
              `offered again. Set it to how long the message stays worth acting on — an ` +
              `instruction like "rebase onto main" is worthless an hour later, so prefer ` +
              `a short value. Requires expect_id, which is what says WHICH session it was ` +
              `for; a name alone is not enough, because a restarted session answers to ` +
              `its predecessor's name. At most ${MAX_REPLAY_MINUTES}.`,
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
        'Read the Tin Can message log — what was sent, to whom, and what became of it. ' +
        'Each record carries an `outcome`: `accepted` (the peer\'s harness took it), ' +
        '`failed` (it was attempted and refused), or `indeterminate` — written out, with ' +
        'nothing ever observed about what happened next, which is what a crash mid-send ' +
        'leaves behind. Do not report `indeterminate` as either success or failure; it ' +
        'means nobody knows. A record with `kind: "unsent"` is a send that never became a ' +
        'message — the peer was unknown, unreachable, or had been replaced by another ' +
        'session of the same name — and carries `to_address` and `reason`. It is how you ' +
        'find that someone tried to reach a session while it was down. ' +
        'Filter by peer, or follow a reply chain from a message id. ' +
        'If an `integrity` field comes back, read it: `ok: false` means the log is damaged ' +
        'or was edited and what you are reading is an incomplete account — say so rather ' +
        'than treating it as the whole record. A `rotated` field is not damage; it means ' +
        'older history was deliberately archived and names where it went — and the ' +
        'archive IS searched when a query comes up short, so rotation does not hide ' +
        'history from you. If `rotated.complete` is false, only part of the archive was ' +
        'read and something absent from your result may simply be further back; do not ' +
        'report it as never sent. Neither is ' +
        '`interleaved`, which counts records written by concurrent sessions appending to ' +
        'this one machine-global log: nothing is missing on account of it, and it never ' +
        'makes `ok` false. An empty result with `ok: true` means nothing was sent — it is ' +
        'not evidence that something was lost.',
      inputSchema: {
        type: 'object',
        properties: {
          // Scoped by default because the log is machine-global: without it a
          // session asking what it was told is handed other projects' traffic.
          all_projects: {
            type: 'boolean',
            default: false,
            description:
              'By default you see only messages where one end is this project (by working ' +
              'directory). Set true to read every conversation on the machine, including ' +
              'other projects. If a result is empty, check `scope_note` before concluding ' +
              'nothing was sent.',
          },
          peer: { type: 'string', description: 'Only messages to or from this peer name.' },
          thread: {
            type: 'string',
            description: 'A message id; follows the in_reply_to chain from it.',
          },
          last_n: {
            type: 'number',
            default: DEFAULT_LAST_N,
            description: 'How many records to return.',
          },
          // The only way a returning session learns it missed anything:
          // nothing can be pushed to a session at startup, so it has to ask.
          missed: {
            type: 'boolean',
            default: false,
            description:
              'Messages someone tried to send you while you were not reachable, that they ' +
              'asked to have held for you and that are still in date. Worth calling if ' +
              'this session was restarted or resumed and may have been unreachable for a ' +
              'while. Returns nothing unless a sender explicitly left something, so an ' +
              'empty result means nobody did — not that nobody tried.',
          },
        },
      },
    },
  ];
}
