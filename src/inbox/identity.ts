import { InboxError, type InboxIdentity } from './types.js';
/** Slugs are descriptive; only local runtime/full ID is an authorization key. */
export function parseInboxIdentity(address: string): InboxIdentity {
  const m = /^(codex|claude-code|opencode):[a-z0-9-]+\.([^@]+)$/.exec(
    address.toLowerCase(),
  );
  if (!m) throw new InboxError('invalid_identity');
  const runtime = m[1] as InboxIdentity['runtime'];
  const id = m[2]!;
  if (
    runtime === 'opencode'
      ? !/^ses_[a-z0-9_-]+$/.test(id)
      : !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
  )
    throw new InboxError('invalid_identity');
  return { runtime, id };
}
export function identityKey(identity: InboxIdentity): string {
  const normalized = parseInboxIdentity(
    `${identity.runtime}:session.${identity.id}`,
  );
  return `${normalized.runtime}:${normalized.id}`;
}
export function senderNamespace(
  identity: InboxIdentity | undefined,
  externalLabel?: string,
): string {
  return identity
    ? `agent:${identityKey(identity)}`
    : externalLabel !== undefined
      ? `external:${externalLabel}`
      : 'unknown-agent';
}
