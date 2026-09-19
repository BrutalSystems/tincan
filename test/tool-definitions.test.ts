import { describe, test, expect } from 'vitest';
import { toolDefinitions } from '../src/tool-definitions.js';

const defs = toolDefinitions('codex');
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

  test('tells the model send_peer does not wait for an answer', () => {
    expect(byName('send_peer').description.toLowerCase()).toMatch(/does not wait|not block|fire-and-forget/);
  });

  test('defaults message_log to the last 20 records', () => {
    const props = byName('message_log').inputSchema.properties as Record<string, { default?: unknown }>;
    expect(props.last_n?.default).toBe(20);
  });
});
