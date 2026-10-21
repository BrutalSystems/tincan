import type { Envelope } from '../envelope.js';
import type { RuntimeName } from '../naming.js';
export type InboxIdentity = { runtime: RuntimeName; id: string };
export type ItemState = 'quarantined' | 'eligible' | 'released';
export type PolicyView =
  | { enabled: false }
  | { enabled: true; generation: string; receiver: InboxIdentity };
export type InboxItem = {
  envelope: Envelope;
  state: ItemState;
  expiresAt: number;
  sequence?: number;
  urgent: boolean;
  sender?: InboxIdentity;
};
export type InboxKeyRecord = {
  namespace: string;
  keyHash: string;
  fingerprint: string;
  messageId: string;
  expiresAt: number;
};
export type InboxSnapshot = {
  version: 1;
  enabled: boolean;
  generation: string;
  receiver: InboxIdentity;
  grants: InboxIdentity[];
  nextSequence: number;
  items: InboxItem[];
  keys: InboxKeyRecord[];
};
export type ReadArgs = { cursor?: string; limit?: number };
export type ReadResult =
  | { enabled: false; messages: []; notice: string }
  | {
      enabled: true;
      messages: InboxItem[];
      next_cursor: string;
      has_more: boolean;
    };
export type EnqueueArgs = {
  receiver: InboxIdentity;
  generation: string;
  envelope: Envelope;
  sender?: InboxIdentity;
  key?: string;
  namespace: string;
  urgent: boolean;
};
export type EnqueueResult = {
  message_id: string;
  inbox_state: 'queued' | 'quarantined';
  duplicate: boolean;
};
export type InboxErrorCode =
  | 'invalid_identity'
  | 'policy_corrupt'
  | 'policy_changed'
  | 'locked'
  | 'queue_full'
  | 'cursor_invalid'
  | 'key_reused'
  | 'commit_unknown'
  | 'storage_failed'
  | 'item_unknown';
export class InboxError extends Error {
  constructor(public readonly code: InboxErrorCode) {
    super(code);
    this.name = 'InboxError';
  }
}
export const INBOX_TTL_MS = 24 * 60 * 60 * 1000;
export const INBOX_MAX_ITEMS = 500;
export const INBOX_MAX_BYTES = 10 * 1024 * 1024;
export const QUARANTINE_MAX_ITEMS = 100;
export const QUARANTINE_MAX_BYTES = 2 * 1024 * 1024;
export const READ_MAX_BYTES = 1024 * 1024;
export const READ_DEFAULT_LIMIT = 20;
export const READ_MAX_LIMIT = 100;
