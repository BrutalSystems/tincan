import { describe, it, expect } from 'vitest';
import { effectOfV2 } from '../tincan-lib/events-v2.js';

// Payloads below are trimmed captures from opencode 2.0.24 (`opencode run`
// against a probe plugin, 2026-10-07): `data` instead of v1's `properties`,
// the session id at `data.sessionID`, the directory under `location`, and
// execution events carrying no `location` at all.
const DIR = '/repo';
const created = {
  id: 'evt_1',
  created: 1791391533500,
  type: 'session.created',
  durable: { aggregateID: 'ses_a', seq: 0, version: 1 },
  location: { directory: DIR },
  data: {
    sessionID: 'ses_a',
    projectID: 'global',
    location: { directory: DIR },
    subpath: '',
    slug: 'swift-eagle',
    version: '2.0.24',
  },
};

describe('effectOfV2', () => {
  it('upserts on session.created, reading the directory from data.location', () => {
    expect(effectOfV2(created, DIR)).toEqual({
      kind: 'upsert',
      info: { id: 'ses_a', slug: 'swift-eagle', title: '', directory: DIR, version: '2.0.24' },
    });
  });

  it('ignores a session created in another directory — the event stream is server-wide', () => {
    const elsewhere = {
      ...created,
      location: { directory: '/other' },
      data: { ...created.data, location: { directory: '/other' } },
    };
    expect(effectOfV2(elsewhere, DIR)).toEqual({ kind: 'ignore' });
  });

  it('ignores a session.created missing the slug, which every address is built from', () => {
    const { slug: _slug, ...noSlug } = created.data;
    expect(effectOfV2({ ...created, data: noSlug }, DIR)).toEqual({ kind: 'ignore' });
  });

  it('renames on session.renamed — the title arrives after the create', () => {
    const e = { type: 'session.renamed', location: { directory: DIR }, data: { sessionID: 'ses_a', title: 'OK' } };
    expect(effectOfV2(e, DIR)).toEqual({ kind: 'rename', sessionID: 'ses_a', title: 'OK' });
  });

  it('marks busy on session.execution.started, which carries no location', () => {
    const e = { type: 'session.execution.started', durable: {}, data: { sessionID: 'ses_a' } };
    expect(effectOfV2(e, DIR)).toEqual({ kind: 'state', sessionID: 'ses_a', state: 'busy' });
  });

  it.each(['succeeded', 'failed', 'interrupted'])('marks idle on session.execution.%s', (outcome) => {
    const e = { type: `session.execution.${outcome}`, data: { sessionID: 'ses_a' } };
    expect(effectOfV2(e, DIR)).toEqual({ kind: 'state', sessionID: 'ses_a', state: 'idle' });
  });

  it('removes on session.deleted', () => {
    const e = { type: 'session.deleted', location: { directory: DIR }, data: { sessionID: 'ses_a' } };
    expect(effectOfV2(e, DIR)).toEqual({ kind: 'remove', sessionID: 'ses_a' });
  });

  it('ignores v1-shaped events, which 2.x never publishes', () => {
    expect(effectOfV2({ type: 'session.idle', properties: { sessionID: 'ses_a' } }, DIR)).toEqual({ kind: 'ignore' });
  });

  it.each([null, undefined, 'x', 42, {}, { type: 'session.created' }, { type: 'session.deleted', data: {} }])(
    'ignores malformed input %#',
    (e) => {
      expect(effectOfV2(e, DIR)).toEqual({ kind: 'ignore' });
    },
  );
});
