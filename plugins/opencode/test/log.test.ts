import { describe, it, expect } from 'vitest';
import { formatLog, makeLogger } from '../tincan-lib/log.js';

describe('formatLog', () => {
  it('renders whitelisted fields as key=value', () => {
    const line = formatLog({ event: 'delivered', session: 'ses_a', from: 'billing-api', delivery: 'queue', message_id: 'msg_1' });
    expect(line).toBe('[tincan] event=delivered session=ses_a from=billing-api delivery=queue message_id=msg_1');
  });

  it('omits absent fields entirely', () => {
    expect(formatLog({ event: 'bound' })).toBe('[tincan] event=bound');
  });

  it('drops any field outside the whitelist, including message text', () => {
    const hostile = { event: 'delivered', text: 'SECRET BODY', prompt: 'ALSO SECRET' } as never;
    const line = formatLog(hostile);
    expect(line).not.toContain('SECRET');
    expect(line).not.toContain('text=');
    expect(line).toBe('[tincan] event=delivered');
  });

  it('collapses newlines so one event is always one line', () => {
    const line = formatLog({ event: 'rejected', detail: 'line one\nline two' });
    expect(line).toBe('[tincan] event=rejected detail=line one line two');
  });
});

describe('makeLogger', () => {
  it('writes formatted lines to the sink', () => {
    const seen: string[] = [];
    const log = makeLogger((l) => seen.push(l));
    log({ event: 'dropped', detail: 'bad json' });
    expect(seen).toEqual(['[tincan] event=dropped detail=bad json']);
  });

  it('never throws when the sink throws', () => {
    const log = makeLogger(() => { throw new Error('sink exploded'); });
    expect(() => log({ event: 'bound' })).not.toThrow();
  });
});
