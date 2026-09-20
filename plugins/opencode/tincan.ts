/**
 * Tin Can — opencode plugin.
 *
 * WARNING: opencode's loader invokes EVERY exported function in this file as a
 * plugin, and does not descend into subdirectories. Export exactly one thing,
 * and never a `default`. All logic lives in ./tincan-lib/. See SPEC.md §2.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { newInstanceId, peersDir, pluginLogPath } from './tincan-lib/paths.js';
import { startPlugin } from './tincan-lib/plugin.js';
import type { Transport } from './tincan-lib/types.js';

export const TinCan = async (input: { client: { _client?: unknown } }) => {
  // console.error would land in the TUI's own terminal — the same one
  // opencode is drawing its interface on — and nowhere else: it never
  // reaches opencode's own log file. Appending to our own log file is the
  // only way an operator can read event=selfcheck.failed / bind.failed /
  // transport-broken after the session ends. makeLogger already guards the
  // call into this sink, but the sink itself must not throw either — a
  // logging failure (e.g. an unwritable disk) must never reach the host.
  const logPath = pluginLogPath(process.env, homedir());
  // Every other artefact here is owner-only (peers dir 0700, socket 0600,
  // records 0600). This log holds no message bodies, but it does hold
  // session ids, peer names, message ids and delivery modes — a record of
  // who is messaging whom — so it gets the same treatment. `mode` on
  // appendFileSync only takes effect when the file is created; chmod
  // unconditionally so a pre-existing 0644 file (e.g. from before this fix)
  // gets tightened too, not just a freshly created one.
  const sink = (line: string) => {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line + '\n', { mode: 0o600 });
      chmodSync(logPath, 0o600);
    } catch {
      // Nothing here may reach the host. SPEC §8.1.
    }
  };
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
