/**
 * Tin Can — opencode plugin.
 *
 * WARNING: opencode's loader invokes EVERY exported function in this file as a
 * plugin, and does not descend into subdirectories. Export exactly one thing,
 * and never a `default`. All logic lives in ./tincan-lib/. See SPEC.md §2.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { newInstanceId, peersDir, pluginLogPath } from './tincan-lib/paths.js';
import { startPlugin } from './tincan-lib/plugin.js';
import type { Transport } from './tincan-lib/types.js';

/** Rotates to `<log>.1` past this. Small enough to stay cheap to read, big
 *  enough to hold a long session's diagnostics. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;

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
  // appendFileSync only takes effect when the file is created, so a chmod
  // follows the first write to any given file — a pre-existing 0644 log
  // gets tightened too, not just a freshly created one.
  //
  // This runs on the TUI's worker thread, so it is kept to ONE syscall per
  // line in the steady state: the mkdir, the chmod and the size check happen
  // on the first write only, and the size is tracked in memory after that.
  let logBytes = -1;   // -1 until the directory is ensured and the size read
  let tightened = false; // chmod applied to the file currently at logPath
  const sink = (line: string) => {
    try {
      const data = `${line}\n`;
      if (logBytes < 0) {
        mkdirSync(dirname(logPath), { recursive: true });
        try { logBytes = statSync(logPath).size; } catch { logBytes = 0; }
      }
      if (logBytes >= MAX_LOG_BYTES) {
        // One generation back, then overwritten. Two bounded files beat one
        // unbounded one, and a rotation that fails must not cost us the
        // line — logBytes is reset either way so we do not retry per line.
        try { renameSync(logPath, `${logPath}.1`); tightened = false; } catch { /* keep appending */ }
        logBytes = 0;
      }
      appendFileSync(logPath, data, { mode: 0o600 });
      logBytes += Buffer.byteLength(data);
      if (!tightened) {
        chmodSync(logPath, 0o600);
        tightened = true;
      }
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
