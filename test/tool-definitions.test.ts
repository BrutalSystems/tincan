import { describe, test, expect } from 'vitest';
import { toolDefinitions } from '../src/tool-definitions.js';
import { runtimeSupportsUrgent } from '../src/tools.js';
import type { RuntimeName } from '../src/types.js';

const defs = toolDefinitions(['codex'], 'codex', 'included');
const byName = (n: string) => defs.find((d) => d.name === n)!;

describe('toolDefinitions', () => {
  test('exposes exactly peers, send_peer and message_log', () => {
    expect(defs.map((d) => d.name).sort()).toEqual(['message_log', 'peers', 'send_peer']);
  });

  // Only `message` is structurally required now: a recipient may be given as
  // `peer` OR `peers`, and JSON Schema's `required` cannot express "exactly one
  // of these two". That constraint lives in `sendPeerSchema` (zod), which
  // refuses both-or-neither with a message naming the choice, and in the two
  // parameter descriptions. Asserted here so that a future edit adding `peer`
  // back to `required` — which would make every fan-out call structurally
  // invalid — fails loudly.
  test('requires only message on send_peer: the recipient may be peer or peers', () => {
    const schema = byName('send_peer').inputSchema;
    expect(schema.required).toEqual(['message']);
    expect(Object.keys(schema.properties)).toContain('peer');
    expect(Object.keys(schema.properties)).toContain('peers');
  });

  test('caps fan-out width in the schema the model reads', () => {
    const props = byName('send_peer').inputSchema.properties as Record<string, { maxItems?: number }>;
    expect(props.peers?.maxItems).toBe(8);
  });

  test('defaults expect_reply and urgent to false', () => {
    const props = byName('send_peer').inputSchema.properties as Record<string, { default?: unknown }>;
    expect(props.expect_reply?.default).toBe(false);
    expect(props.urgent?.default).toBe(false);
  });

  // The reachability of the `urgent` wordings below depends on a fact recorded
  // in tools.ts, a different file: nothing is steerable as of 0.6.0. Asserting
  // it here is what keeps the two unreachable branches in tool-definitions.ts
  // distinguishable from dead code.
  //
  // WHEN THIS FAILS a runtime has gone steerable, which is good news: the
  // "all steerable" and mixed-fleet wordings are reachable again and need
  // tests of their own. Do not simply relax this — go and cover them.
  test('no runtime is steerable, so only the "unsupported" urgent wording is reachable', () => {
    const all: RuntimeName[] = ['codex', 'claude-code', 'opencode'];
    expect(all.filter(runtimeSupportsUrgent)).toEqual([]);

    const mixed = toolDefinitions(['codex', 'claude-code', 'opencode'], 'codex', 'included');
    const urgent = (
      mixed.find((d) => d.name === 'send_peer')!.inputSchema.properties as Record<
        string,
        { description?: string }
      >
    ).urgent?.description;
    expect(urgent).toContain('Unsupported on');
    expect(urgent).toContain('queued either way');
    // The two wordings that would replace it if anything were steerable.
    expect(urgent).not.toContain('instead of queuing behind it');
    expect(urgent).not.toContain('Only takes effect for');
  });

  test('takes no arguments for peers', () => {
    expect(byName('peers').inputSchema.properties).toEqual({});
  });

  test('names the peer runtime in the descriptions so the model knows who it reaches', () => {
    expect(byName('peers').description).toContain('Codex');
    expect(byName('send_peer').description).toContain('Codex');
  });

  test('names both runtimes when a side exposes both', () => {
    const both = toolDefinitions(['codex', 'claude-code'], 'codex', 'included');
    const d = both.find((x) => x.name === 'peers')!.description;
    expect(d).toContain('Codex');
    expect(d).toContain('Claude Code');
  });

  test('lists three runtimes as a list, not "A and B and C"', () => {
    // The Codex and opencode hosts expose all three.
    const three = toolDefinitions(['codex', 'claude-code', 'opencode'], 'codex', 'included');
    for (const name of ['peers', 'send_peer']) {
      const d = three.find((x) => x.name === name)!.description;
      expect(d).toContain('Codex, Claude Code, and opencode');
      expect(d).not.toContain('and Claude Code and');
    }
  });

  test('says the host’s own kind is scoped when this side lists only part of it', () => {
    // The Claude Code host. Without this the model reads a short peer list as
    // the whole machine and reports "three peers" when there are fifteen
    // reachable sessions.
    const d = toolDefinitions(['codex', 'opencode', 'claude-code'], 'claude-code', 'cross-config-dir').find(
      (x) => x.name === 'peers',
    )!.description;
    expect(d).toContain('Claude Code');
    expect(d).toMatch(/only when they run under a different CLAUDE_CONFIG_DIR/i);
    // Both halves of the native path, not just the send verb. A model told
    // only that SendMessage exists still has no way to FIND the session it
    // would send to, which is exactly how a caller concluded the excluded
    // peers were unreachable rather than natively listed.
    expect(d).toContain('ListAgents');
    expect(d).toContain('SendMessage');
  });

  test('says nothing about exclusion on a side that lists its own kind', () => {
    // Codex and opencode list their own kind, so there is nothing missing to
    // warn about — an unconditional warning would be a lie on two of three
    // hosts.
    const d = toolDefinitions(['codex', 'claude-code', 'opencode'], 'codex', 'included').find(
      (x) => x.name === 'peers',
    )!.description;
    expect(d).not.toMatch(/does not list|not listed/i);
    expect(d).not.toContain('SendMessage');
    expect(d).not.toContain('ListAgents');
  });

  test('tells the model send_peer does not wait for an answer', () => {
    expect(byName('send_peer').description.toLowerCase()).toMatch(/does not wait|not block|fire-and-forget/);
  });

  test('defaults message_log to the last 20 records', () => {
    const props = byName('message_log').inputSchema.properties as Record<string, { default?: unknown }>;
    expect(props.last_n?.default).toBe(20);
  });
});

test('the claude arm says its own-kind listing is scoped to other config dirs', () => {
  const [peers] = toolDefinitions(['codex', 'opencode', 'claude-code'], 'claude-code', 'cross-config-dir');
  expect(peers?.description).toContain('different CLAUDE_CONFIG_DIR');
  expect(peers?.description).toContain('ListAgents');
  expect(peers?.description).toContain('SendMessage');
});

test('an arm that lists its own kind in full says nothing about scoping', () => {
  const [peers] = toolDefinitions(['codex', 'claude-code', 'opencode'], 'codex', 'included');
  expect(peers?.description).not.toContain('CLAUDE_CONFIG_DIR');
});
