import { describe, test, expect } from 'vitest';
import { toolDefinitions } from '../src/tool-definitions.js';

const defs = toolDefinitions(['codex'], 'codex');
const byName = (n: string) => defs.find((d) => d.name === n)!;

describe('toolDefinitions', () => {
  test('exposes exactly peers, send_peer and message_log', () => {
    expect(defs.map((d) => d.name).sort()).toEqual(['message_log', 'peers', 'send_peer']);
  });

  test('requires peer and message on send_peer, and nothing else', () => {
    expect(byName('send_peer').inputSchema.required).toEqual(['peer', 'message']);
  });

  test('defaults expect_reply and urgent to false', () => {
    const props = byName('send_peer').inputSchema.properties as Record<string, { default?: unknown }>;
    expect(props.expect_reply?.default).toBe(false);
    expect(props.urgent?.default).toBe(false);
  });

  test('takes no arguments for peers', () => {
    expect(byName('peers').inputSchema.properties).toEqual({});
  });

  test('names the peer runtime in the descriptions so the model knows who it reaches', () => {
    expect(byName('peers').description).toContain('Codex');
    expect(byName('send_peer').description).toContain('Codex');
  });

  test('names both runtimes when a side exposes both', () => {
    const both = toolDefinitions(['codex', 'claude-code'], 'codex');
    const d = both.find((x) => x.name === 'peers')!.description;
    expect(d).toContain('Codex');
    expect(d).toContain('Claude Code');
  });

  test('lists three runtimes as a list, not "A and B and C"', () => {
    // The Codex and opencode hosts expose all three.
    const three = toolDefinitions(['codex', 'claude-code', 'opencode'], 'codex');
    for (const name of ['peers', 'send_peer']) {
      const d = three.find((x) => x.name === name)!.description;
      expect(d).toContain('Codex, Claude Code, and opencode');
      expect(d).not.toContain('and Claude Code and');
    }
  });

  test('says the host’s own kind is absent when this side excludes it', () => {
    // The Claude Code host. Without this the model reads a short peer list as
    // the whole machine and reports "three peers" when there are fifteen
    // reachable sessions.
    const d = toolDefinitions(['codex', 'opencode'], 'claude-code').find(
      (x) => x.name === 'peers',
    )!.description;
    expect(d).toContain('Claude Code');
    expect(d).toMatch(/does not list|not listed/i);
    expect(d).toContain('SendMessage');
  });

  test('says nothing about exclusion on a side that lists its own kind', () => {
    // Codex and opencode list their own kind, so there is nothing missing to
    // warn about — an unconditional warning would be a lie on two of three
    // hosts.
    const d = toolDefinitions(['codex', 'claude-code', 'opencode'], 'codex').find(
      (x) => x.name === 'peers',
    )!.description;
    expect(d).not.toMatch(/does not list|not listed/i);
    expect(d).not.toContain('SendMessage');
  });

  test('tells the model send_peer does not wait for an answer', () => {
    expect(byName('send_peer').description.toLowerCase()).toMatch(/does not wait|not block|fire-and-forget/);
  });

  test('defaults message_log to the last 20 records', () => {
    const props = byName('message_log').inputSchema.properties as Record<string, { default?: unknown }>;
    expect(props.last_n?.default).toBe(20);
  });
});
