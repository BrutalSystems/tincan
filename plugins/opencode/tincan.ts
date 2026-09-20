/**
 * Tin Can — opencode plugin.
 *
 * WARNING: opencode's loader invokes EVERY exported function in this file as a
 * plugin, and does not descend into subdirectories. Export exactly one thing,
 * and never a `default`. All logic lives in ./tincan-lib/. See SPEC.md §2.
 */
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { newInstanceId, peersDir } from './tincan-lib/paths.js';
import { startPlugin } from './tincan-lib/plugin.js';
import type { Transport } from './tincan-lib/types.js';

export const TinCan = async (input: { client: { _client?: unknown } }) => {
  const sink = (line: string) => { console.error(line); };
  // The only private-field dependency in the plugin. SPEC §3 explains why it
  // is unavoidable; the self-check inside startPlugin turns a future breakage
  // into "no opencode peers" rather than a crash.
  const transport = input.client?._client;

  if (!transport || typeof (transport as { post?: unknown }).post !== 'function') {
    sink('[tincan] event=selfcheck.failed detail=no transport on client._client');
    return {};
  }

  return startPlugin({
    dir: peersDir(process.env, homedir()),
    instanceId: newInstanceId(() => randomBytes(3).toString('hex')),
    pid: process.pid,
    transport: transport as Transport,
    now: () => new Date(),
    sink,
  });
};
