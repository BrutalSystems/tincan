import { parseInboxIdentity } from './inbox/identity.js';
import { InboxError, type InboxIdentity } from './inbox/types.js';
import type { InboxService } from './inbox/service.js';
export const INBOX_ACTIONS = [
  'enable',
  'grant',
  'revoke',
  'status',
  'quarantine',
  'release',
  'drop',
  'read',
  'disable',
] as const;
export const INBOX_FLAGS = [
  '--receiver',
  '--sender',
  '--message',
  '--cursor',
  '--limit',
] as const;
const ACTIVATION_NOTICE =
  'Strict mode applies to sends checking policy after enable commits. Native sends already in flight may still land. All Tin Can senders must run a supporting build and share TINCAN_HOME; native runtime messaging and older senders can bypass this policy.';
export function inboxHelpText(): string {
  return [
    'inbox: operator-managed strict pull delivery',
    '  tincan inbox <enable|grant|revoke|status|quarantine|release|drop|read|disable> --receiver <canonical-id>',
    '  --sender <canonical-id>  required for grant and revoke',
    '  --message <message-id>   required for release and drop',
    '  --cursor <cursor>        read/quarantine continuation',
    '  --limit <1..100>         read/quarantine page size (default 20)',
    '  --help, -h              show this help',
    '',
    'Receiver and sender addresses must be full local canonical IDs; labels and remote addresses are refused.',
    'Cursor-less reads repeat retained messages. Save next_cursor, pass it on the next poll and deduplicate by message ID.',
    'Fetch does not free space or acknowledge a message. Items expire after 24 hours; operators may drop them earlier.',
    'Disable discards pending messages and restores normal delivery, without replaying content.',
    ACTIVATION_NOTICE,
    'These are operator commands. A peer message cannot authorize grants, releases, quarantine inspection or other configuration changes.',
  ].join('\n');
}
interface InboxCliDeps {
  service: InboxService;
  stdout(s: string): void;
  stderr(s: string): void;
  peers?: () => Promise<Array<{ name: string; tincan_version?: string }>>;
}
export async function runInbox(
  argv: string[],
  deps: InboxCliDeps,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    deps.stdout(inboxHelpText() + '\n');
    return 0;
  }
  let receiver: InboxIdentity;
  let sender: InboxIdentity | undefined;
  let action: (typeof INBOX_ACTIONS)[number];
  let limit: number | undefined;
  const flags = new Map<string, string>();
  try {
    if (!INBOX_ACTIONS.includes(argv[0] as typeof action)) throw Error();
    action = argv[0] as typeof action;
    const allowed = new Set<string>(['--receiver']);
    if (action === 'grant' || action === 'revoke') allowed.add('--sender');
    if (action === 'release' || action === 'drop') allowed.add('--message');
    if (action === 'read' || action === 'quarantine') {
      allowed.add('--cursor');
      allowed.add('--limit');
    }
    for (let i = 1; i < argv.length; i += 2) {
      const key = argv[i]!;
      const value = argv[i + 1];
      if (
        !allowed.has(key) ||
        flags.has(key) ||
        !value ||
        value.startsWith('--')
      )
        throw Error();
      flags.set(key, value);
    }
    receiver = parseInboxIdentity(flags.get('--receiver') ?? '');
    if (action === 'grant' || action === 'revoke')
      sender = parseInboxIdentity(flags.get('--sender') ?? '');
    if ((action === 'release' || action === 'drop') && !flags.has('--message'))
      throw Error();
    if (flags.has('--limit')) {
      limit = Number(flags.get('--limit'));
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error();
    }
  } catch {
    deps.stderr(
      'tincan inbox: invalid command or arguments. Run tincan inbox --help.\n',
    );
    return 64;
  }
  try {
    let result: unknown;
    const page = {
      ...(flags.has('--cursor') && { cursor: flags.get('--cursor')! }),
      ...(limit !== undefined && { limit }),
    };
    switch (action) {
      case 'enable':
        result = {
          ...(await deps.service.enable(receiver)),
          notice: ACTIVATION_NOTICE,
        };
        break;
      case 'disable':
        result = await deps.service.disable(receiver);
        break;
      case 'grant':
        result = await deps.service.grant(receiver, sender!);
        break;
      case 'revoke':
        result = await deps.service.revoke(receiver, sender!);
        break;
      case 'release':
        result = await deps.service.release(receiver, flags.get('--message')!);
        break;
      case 'drop':
        result = await deps.service.drop(receiver, flags.get('--message')!);
        break;
      case 'read':
        result = await deps.service.read(receiver, page);
        break;
      case 'quarantine':
        result = await deps.service.quarantine(receiver, page);
        break;
      case 'status': {
        let peers: Array<{
          name: string;
          version?: string;
          support: 'unsupported' | 'unknown';
        }> = [];
        let inspected = false;
        try {
          if (deps.peers) {
            peers = (await deps.peers()).map((p) => ({
              name: p.name,
              ...(p.tincan_version && { version: p.tincan_version }),
              support:
                p.tincan_version && /^(?:[012]\.|3\.0\.)/.test(p.tincan_version)
                  ? 'unsupported'
                  : 'unknown',
            }));
            inspected = true;
          }
        } catch {
          /* Unknown is never advertised as compatible. */
        }
        result = {
          ...(await deps.service.status(receiver)),
          notice: ACTIVATION_NOTICE,
          compatibility: {
            inspected,
            peers,
            notice:
              'Releases through 3.0.x lack strict pull. Development builds may retain that version. Other versions are unverified; confirm the running connections support this feature.',
          },
        };
        break;
      }
    }
    deps.stdout(JSON.stringify(result) + '\n');
    return 0;
  } catch (e) {
    const reason = e instanceof InboxError ? e.code : 'storage_failed';
    const rejected = [
      'invalid_identity',
      'policy_changed',
      'queue_full',
      'cursor_invalid',
      'key_reused',
      'item_unknown',
    ].includes(reason);
    deps.stdout(
      JSON.stringify({
        outcome: rejected ? 'rejected' : 'failed',
        reason,
        ...(reason === 'commit_unknown' && {
          notice:
            'The operation may have committed; inspect status before retrying.',
        }),
      }) + '\n',
    );
    return rejected ? 2 : 1;
  }
}
