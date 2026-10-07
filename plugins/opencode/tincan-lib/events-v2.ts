import type { EventEffect } from './events.js';

const IGNORE: EventEffect = { kind: 'ignore' };

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * opencode 2.x events, mapped onto the same effects the 1.x `event` hook
 * produces. Verified against 2.0.24; see SPEC.md §5.1.
 *
 * Three differences from 1.x drive the shape of this:
 *
 * - The body is under `data`, not `properties`, and a session is named by
 *   `data.sessionID`, not `properties.info.id`.
 * - `session.status` and `session.idle` are never published. Busy and idle
 *   come from the execution lifecycle instead.
 * - One plugin instance is loaded per directory, but the event stream is
 *   server-wide: a 2.x background service hosts every directory its TUIs
 *   have open. So a create is only ours when its directory is ours, or every
 *   instance would advertise every session. Execution events carry no
 *   location; they are safe to pass through because a state change for a
 *   session this instance never announced is already dropped.
 */
export function effectOfV2(event: unknown, directory: string): EventEffect {
  const e = record(event);
  const data = record(e?.data);
  if (!e || !data) return IGNORE;
  const sessionID = data.sessionID;
  if (typeof sessionID !== 'string') return IGNORE;

  switch (e.type) {
    case 'session.created': {
      const dir = record(data.location)?.directory;
      if (dir !== directory) return IGNORE;
      if (typeof data.slug !== 'string' || typeof data.version !== 'string') return IGNORE;
      // No title yet: it arrives as session.renamed once the model names it.
      return {
        kind: 'upsert',
        info: { id: sessionID, slug: data.slug, title: '', directory: dir, version: data.version },
      };
    }
    case 'session.renamed':
      return typeof data.title === 'string' ? { kind: 'rename', sessionID, title: data.title } : IGNORE;
    case 'session.execution.started':
      return { kind: 'state', sessionID, state: 'busy' };
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted':
      return { kind: 'state', sessionID, state: 'idle' };
    case 'session.deleted':
      return { kind: 'remove', sessionID };
    default:
      return IGNORE;
  }
}
