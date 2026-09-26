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
    expect(line).toBe('[tincan] event=rejected detail="line one line two"');
  });

  it('collapses U+2028 and U+2029, which are line terminators too', () => {
    // A log viewer, a terminal and JavaScript itself all break a line on
    // these; \r\n alone is not the whole set.
    const line = formatLog({ event: 'rejected', detail: 'one\u2028two\u2029three' });
    expect(line).toBe('[tincan] event=rejected detail="one two three"');
    expect(line).not.toContain('\u2028');
    expect(line).not.toContain('\u2029');
  });

  it('quotes a value containing a space so its parts cannot read as fields', () => {
    expect(formatLog({ event: 'dropped', detail: 'unknown session' }))
      .toBe('[tincan] event=dropped detail="unknown session"');
  });

  it('leaves a value with nothing to confuse a reader unquoted', () => {
    expect(formatLog({ event: 'rejected', detail: 'SessionNotFoundError' }))
      .toBe('[tincan] event=rejected detail=SessionNotFoundError');
  });

  it('stops a peer-controlled from= forging other fields', () => {
    // message_from is whatever the sender called itself. Unquoted, this
    // reads as three fields to anyone — human or grep — parsing the line
    // during an incident.
    const line = formatLog({ event: 'delivered', session: 'ses_real', from: 'x delivery=steer session=ses_victim' });
    expect(line).toBe('[tincan] event=delivered session=ses_real from="x delivery=steer session=ses_victim"');
    // A reader that respects quotes sees exactly one session field, and it
    // is ours; the forgery is contained inside from=.
    const fields = line.slice('[tincan] '.length).match(/\w+=(?:"(?:[^"\\]|\\.)*"|\S*)/g) ?? [];
    expect(fields.filter((f) => f.startsWith('session='))).toEqual(['session=ses_real']);
    expect(fields).toContain('from="x delivery=steer session=ses_victim"');
  });

  it('escapes an embedded quote rather than ending the value early', () => {
    const line = formatLog({ event: 'delivered', from: 'say "hi"' });
    expect(line).toBe('[tincan] event=delivered from="say \\"hi\\""');
  });

  it('truncates hostile over-long values in whitelisted fields', () => {
    const longBody = 'a'.repeat(256);
    const line = formatLog({ event: 'delivered', session: longBody });
    expect(line).toContain('session=');
    expect(line).toContain('…');
    // Confirm truncation at exactly 120 characters, with ellipsis
    const sessionPart = line.split(' ').find((p) => p.startsWith('session='));
    const valueWithEllipsis = sessionPart?.substring('session='.length);
    expect(valueWithEllipsis).toBe('a'.repeat(120) + '…');
  });
});

describe('makeLogger', () => {
  it('writes formatted lines to the sink', () => {
    const seen: string[] = [];
    const log = makeLogger((l) => seen.push(l));
    log({ event: 'dropped', detail: 'bad json' });
    expect(seen).toEqual(['[tincan] event=dropped detail="bad json"']);
  });

  it('never throws when the sink throws', () => {
    const log = makeLogger(() => { throw new Error('sink exploded'); });
    expect(() => log({ event: 'bound' })).not.toThrow();
  });
});
