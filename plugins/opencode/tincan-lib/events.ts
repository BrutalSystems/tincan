import type { SessionInfo, SessionState } from './types.js';

export type EventEffect =
  | { kind: 'upsert'; info: SessionInfo }
  | { kind: 'state'; sessionID: string; state: SessionState }
  | { kind: 'remove'; sessionID: string }
  | { kind: 'ignore' };

const IGNORE: EventEffect = { kind: 'ignore' };

function readInfo(v: unknown): SessionInfo | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (
    typeof o.id !== 'string' ||
    typeof o.slug !== 'string' ||
    typeof o.title !== 'string' ||
    typeof o.directory !== 'string' ||
    typeof o.version !== 'string'
  ) {
    return null;
  }
  return { id: o.id, slug: o.slug, title: o.title, directory: o.directory, version: o.version };
}

export function effectOf(event: unknown): EventEffect {
  if (typeof event !== 'object' || event === null) return IGNORE;
  const e = event as Record<string, unknown>;
  const props = (typeof e.properties === 'object' && e.properties !== null ? e.properties : {}) as Record<string, unknown>;

  switch (e.type) {
    case 'session.created':
    case 'session.updated': {
      const info = readInfo(props.info);
      return info ? { kind: 'upsert', info } : IGNORE;
    }
    case 'session.deleted': {
      // Read leniently: a delete needs nothing but the id. Demanding the full
      // create/update shape here means a payload missing (say) `version`
      // returns `ignore`, so the record is never removed — and Tin Can then
      // sees a peer whose socket is alive, so its liveness prune never fires
      // and every message to it is dropped as `unknown session`. A peer that
      // looks healthy and swallows input is worse than a stale one.
      const id = (props.info as { id?: unknown } | undefined)?.id;
      return typeof id === 'string' ? { kind: 'remove', sessionID: id } : IGNORE;
    }
    case 'session.idle': {
      const id = props.sessionID;
      return typeof id === 'string' ? { kind: 'state', sessionID: id, state: 'idle' } : IGNORE;
    }
    case 'session.status': {
      const id = props.sessionID;
      if (typeof id !== 'string') return IGNORE;
      const status = props.status as { type?: unknown } | undefined;
      // Only 'idle' is idle. 'busy', 'retry' and anything opencode adds later
      // are all "the agent is not free". SPEC §5.
      const state: SessionState = status?.type === 'idle' ? 'idle' : 'busy';
      return { kind: 'state', sessionID: id, state };
    }
    default:
      return IGNORE;
  }
}
