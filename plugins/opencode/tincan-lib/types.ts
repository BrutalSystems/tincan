/**
 * Hand-written types for the slice of opencode 1.18.31 this plugin touches.
 *
 * Deliberately NOT imported from @opencode-ai/plugin: its published types
 * disagree with the 1.18.31 runtime in both directions — they declare a
 * `client.v2` that does not exist, and omit the `slug` that does.
 * See SPEC.md §2.
 */

/** Tracks the Tin Can package version: every registry record reports it,
 *  and a number matching no release tells an operator nothing. */
export const PLUGIN_VERSION = '0.5.1';
export const OPENCODE_TESTED_VERSION = '1.18.31';

/** Server-enforced: sessionID must match ^ses, message id must match ^msg_. */
export const SESSION_ID_RE = /^ses/;
export const MESSAGE_ID_RE = /^msg_/;

/** No 'unreachable': the plugin cannot observe its own absence. Tin Can infers
 *  that from a refused socket and caches it in its own view. SPEC §4. */
export type SessionState = 'idle' | 'busy';
export type Delivery = 'queue' | 'steer';

/** The subset of opencode's Session we rely on. `slug` and `version` are
 *  present at runtime on event payloads even though the SDK type omits them. */
export interface SessionInfo {
  id: string;
  slug: string;
  title: string;
  directory: string;
  version: string;
}

export interface RegistryRecord {
  session_id: string;
  slug: string;
  title: string;
  directory: string;
  state: SessionState;
  socket: string;
  instance_id: string;
  pid: number;
  plugin_version: string;
  opencode_version: string;
  updated_at: string;
}

export interface InboundMessage {
  to_session: string;
  message_from: string;
  text: string;
  delivery: Delivery;
  message_id: string;
}

/** The hey-api client reachable at `input.client._client`. See SPEC.md §3. */
export interface TransportResponse {
  data?: unknown;
  error?: unknown;
  response?: { status?: number };
}
export interface Transport {
  get(args: { url: string }): Promise<TransportResponse>;
  post(args: { url: string; body?: unknown }): Promise<TransportResponse>;
}

export type DeliveryOutcome =
  | { kind: 'delivered'; admittedSeq: number; replay: boolean }
  | { kind: 'rejected'; status: number; tag: string; detail: string }
  | { kind: 'transport-broken'; detail: string };
