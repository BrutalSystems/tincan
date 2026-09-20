/** Peer naming per the handoff §7: slug for humans, canonical id for the log. */

export type RuntimeName = 'claude-code' | 'codex' | 'opencode';

/**
 * How a runtime is written for a human to read. Lives here, beside
 * `RuntimeName` itself, so that `tools.ts` and `tool-definitions.ts` can both
 * use it without importing each other — two spellings of the same runtime in
 * one tool's output is exactly what this is for.
 */
export const LABEL: Record<RuntimeName, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'opencode',
};

export interface PeerBase {
  runtime: RuntimeName;
  /** Harness-supplied name; Codex threads may be unnamed. */
  rawName: string | null;
  /** Thread id (Codex) or session id (Claude Code). */
  uuid: string;
}

export interface NamedPeer extends PeerBase {
  slug: string;
  suffix: string;
  canonicalId: string;
  /** What `peers` shows and `send_peer` accepts: bare slug, suffixed only on collision. */
  display: string;
}

export type Resolution =
  | { ok: true; peer: NamedPeer }
  | { ok: false; reason: 'unknown' | 'ambiguous'; candidates: string[] };

/** Makes a widened RuntimeName a compile error at every branch that ignores it. */
export function assertNever(x: never, context: string): never {
  throw new Error(`${context}: unhandled runtime ${JSON.stringify(x)}`);
}

export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The last three hex characters, not the first. Codex thread ids are UUIDv7:
 * their leading hex is a shared timestamp, so every live thread on a machine
 * starts with the same three characters and a leading suffix disambiguates
 * nothing. The trailing characters are random in both v4 and v7.
 */
export function suffixOf(uuid: string): string {
  return uuid.replace(/[^0-9a-f]/gi, '').slice(-3).toLowerCase();
}

export function assignNames(peers: PeerBase[]): NamedPeer[] {
  const slugs = peers.map((peer) => {
    const s = peer.rawName ? slugify(peer.rawName) : '';
    return s.length > 0 ? s : 'thread';
  });

  const counts = new Map<string, number>();
  for (const s of slugs) counts.set(s, (counts.get(s) ?? 0) + 1);

  return peers.map((peer, i) => {
    const slug = slugs[i]!;
    const suffix = suffixOf(peer.uuid);
    const qualified = `${slug}.${suffix}`;
    // An unnamed thread has no name to stand on, so it always carries its suffix.
    const collides = (counts.get(slug) ?? 0) > 1 || peer.rawName === null;
    return {
      ...peer,
      slug,
      suffix,
      canonicalId: `${peer.runtime}:${qualified}`,
      display: collides ? qualified : slug,
    };
  });
}

export function resolvePeer(peers: NamedPeer[], input: string): Resolution {
  const q = input.trim().toLowerCase();
  const qualified = (p: NamedPeer) => `${p.slug}.${p.suffix}`;

  const exact = peers.filter(
    (p) => p.display.toLowerCase() === q || qualified(p) === q || p.canonicalId.toLowerCase() === q,
  );
  if (exact.length === 1) return { ok: true, peer: exact[0]! };
  if (exact.length > 1) return { ok: false, reason: 'ambiguous', candidates: exact.map(qualified) };

  const prefixed = peers.filter((p) => p.slug.startsWith(q) || qualified(p).startsWith(q));
  if (prefixed.length === 1) return { ok: true, peer: prefixed[0]! };
  if (prefixed.length > 1)
    return { ok: false, reason: 'ambiguous', candidates: prefixed.map(qualified) };

  return { ok: false, reason: 'unknown', candidates: peers.map((p) => p.display) };
}
