import { describe, it, expect } from 'vitest';
import { effectOf } from '../tincan-lib/events.js';

const info = {
  id: 'ses_a',
  slug: 'nimble-wizard',
  title: 'auth refactor',
  directory: '/repo',
  version: '1.18.31',
  projectID: 'global',
  extra: 'ignored',
};

describe('effectOf', () => {
  it('upserts on session.created, keeping only the fields we use', () => {
    expect(effectOf({ type: 'session.created', properties: { info } })).toEqual({
      kind: 'upsert',
      info: { id: 'ses_a', slug: 'nimble-wizard', title: 'auth refactor', directory: '/repo', version: '1.18.31' },
    });
  });

  it('upserts on session.updated', () => {
    const e = effectOf({ type: 'session.updated', properties: { info: { ...info, title: 'PONG' } } });
    expect(e).toEqual({
      kind: 'upsert',
      info: { id: 'ses_a', slug: 'nimble-wizard', title: 'PONG', directory: '/repo', version: '1.18.31' },
    });
  });

  it('removes on session.deleted', () => {
    expect(effectOf({ type: 'session.deleted', properties: { info } })).toEqual({ kind: 'remove', sessionID: 'ses_a' });
  });

  it('removes on session.deleted even when the payload carries nothing but an id', () => {
    // A delete needs only the id. Holding it to the create/update shape means
    // a payload missing `version` (or slug, or title) is ignored, the record
    // survives, and Tin Can keeps routing to a session that no longer exists.
    const { version: _v, slug: _s, title: _t, directory: _d, ...idOnly } = info;
    expect(effectOf({ type: 'session.deleted', properties: { info: idOnly } })).toEqual({ kind: 'remove', sessionID: 'ses_a' });
  });

  it('ignores a session.deleted with no id at all', () => {
    expect(effectOf({ type: 'session.deleted', properties: { info: {} } })).toEqual({ kind: 'ignore' });
    expect(effectOf({ type: 'session.deleted', properties: {} })).toEqual({ kind: 'ignore' });
  });

  it('sets idle on session.idle', () => {
    expect(effectOf({ type: 'session.idle', properties: { sessionID: 'ses_a' } })).toEqual({ kind: 'state', sessionID: 'ses_a', state: 'idle' });
  });

  it('maps status idle to idle', () => {
    expect(effectOf({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'idle' } } })).toEqual({ kind: 'state', sessionID: 'ses_a', state: 'idle' });
  });

  it.each(['busy', 'retry'])('maps status %s to busy', (type) => {
    expect(effectOf({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type } } })).toEqual({ kind: 'state', sessionID: 'ses_a', state: 'busy' });
  });

  it('maps an unknown future status to busy rather than dropping it', () => {
    expect(effectOf({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'hibernating' } } })).toEqual({ kind: 'state', sessionID: 'ses_a', state: 'busy' });
  });

  it.each([
    'session.diff',
    'message.updated',
    'message.part.delta',
    'plugin.added',
    'catalog.updated',
  ])('ignores %s', (type) => {
    expect(effectOf({ type, properties: { sessionID: 'ses_a' } })).toEqual({ kind: 'ignore' });
  });

  it('ignores a session event with no info', () => {
    expect(effectOf({ type: 'session.created', properties: {} })).toEqual({ kind: 'ignore' });
  });

  it('ignores an info payload missing a slug', () => {
    const { slug: _drop, ...noSlug } = info;
    expect(effectOf({ type: 'session.created', properties: { info: noSlug } })).toEqual({ kind: 'ignore' });
  });

  it('ignores malformed input without throwing', () => {
    expect(effectOf(null)).toEqual({ kind: 'ignore' });
    expect(effectOf(undefined)).toEqual({ kind: 'ignore' });
    expect(effectOf('session.created')).toEqual({ kind: 'ignore' });
    expect(effectOf({})).toEqual({ kind: 'ignore' });
  });
});
