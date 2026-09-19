/**
 * Drives test/fixtures/canonical-id.json, the frozen description of Tin Can's
 * address format. The fixture is copied verbatim by other tools, so a change to
 * an expected value here is a change to a published contract — see
 * CANONICAL_ID.md, "Changing this format".
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { slugify, suffixOf, assignNames, resolvePeer, type PeerBase } from '../src/naming.js';

interface Fixture {
  tincan_version: string;
  slugify: { case: string; input: string; output: string }[];
  suffix: { case: string; input: string; output: string }[];
  assign: { case: string; peers: PeerBase[]; expect: { display: string; canonicalId: string }[] }[];
  resolve: {
    case: string;
    peers: PeerBase[];
    input: string;
    expect:
      | { ok: true; canonicalId: string }
      | { ok: false; reason: string; candidates: string[] };
  }[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'canonical-id.json'), 'utf8'),
);

describe('fixture', () => {
  test('declares the Tin Can version it describes', () => {
    expect(fixture.tincan_version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('matches the version in package.json, so the contract cannot silently drift', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    );
    expect(fixture.tincan_version).toBe(pkg.version);
  });
});

describe('slugify', () => {
  for (const c of fixture.slugify) {
    test(c.case, () => expect(slugify(c.input)).toBe(c.output));
  }
});

describe('suffixOf', () => {
  for (const c of fixture.suffix) {
    test(c.case, () => expect(suffixOf(c.input)).toBe(c.output));
  }
});

describe('assignNames', () => {
  for (const c of fixture.assign) {
    test(c.case, () => {
      const got = assignNames(c.peers).map((p) => ({
        display: p.display,
        canonicalId: p.canonicalId,
      }));
      expect(got).toEqual(c.expect);
    });
  }
});

describe('resolvePeer', () => {
  for (const c of fixture.resolve) {
    test(c.case, () => {
      const got = resolvePeer(assignNames(c.peers), c.input);
      if (c.expect.ok) {
        expect(got.ok).toBe(true);
        if (got.ok) expect(got.peer.canonicalId).toBe(c.expect.canonicalId);
      } else {
        expect(got.ok).toBe(false);
        if (!got.ok) {
          expect(got.reason).toBe(c.expect.reason);
          expect([...got.candidates].sort()).toEqual([...c.expect.candidates].sort());
        }
      }
    });
  }
});
