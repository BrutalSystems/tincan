import { describe, it, expect } from 'vitest';
import { peersDir, sessionFile, socketPath, socketPathTooLong, newInstanceId, MAX_UNIX_PATH } from '../tincan-lib/paths.js';

describe('peersDir', () => {
  it('defaults to ~/.tincan/peers/opencode', () => {
    expect(peersDir({}, '/Users/mike')).toBe('/Users/mike/.tincan/peers/opencode');
  });

  it('honours TINCAN_HOME', () => {
    expect(peersDir({ TINCAN_HOME: '/srv/tc' }, '/Users/mike')).toBe('/srv/tc/peers/opencode');
  });

  it('ignores an empty TINCAN_HOME', () => {
    expect(peersDir({ TINCAN_HOME: '' }, '/Users/mike')).toBe('/Users/mike/.tincan/peers/opencode');
  });
});

describe('file and socket paths', () => {
  it('names a session file by session id', () => {
    expect(sessionFile('/p', 'ses_abc')).toBe('/p/ses_abc.json');
  });

  it('names a socket by instance id', () => {
    expect(socketPath('/p', 'inst-a91f')).toBe('/p/inst-a91f.sock');
  });
});

describe('socketPathTooLong', () => {
  it('accepts a realistic default path', () => {
    const p = socketPath(peersDir({}, '/Users/mike'), 'inst-a91f2c');
    expect(p.length).toBeLessThan(MAX_UNIX_PATH);
    expect(socketPathTooLong(p)).toBe(false);
  });

  it('rejects a path at or beyond the limit', () => {
    expect(socketPathTooLong('/' + 'x'.repeat(MAX_UNIX_PATH))).toBe(true);
  });

  it('measures bytes, not characters', () => {
    // 'é' is two bytes in UTF-8; a path of 60 of them exceeds 103 bytes.
    expect(socketPathTooLong('/' + 'é'.repeat(60))).toBe(true);
  });
});

describe('newInstanceId', () => {
  it('prefixes the supplied random hex', () => {
    expect(newInstanceId(() => 'a91f2c')).toBe('inst-a91f2c');
  });
});
