/**
 * Working out which Codex thread is hosting us.
 *
 * Tool-call metadata is authoritative. Process ancestry is only a fallback
 * for older hosts with exactly one thread at the nearest lock holder.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** MCP metadata, isolated across concurrent requests; never tool arguments. */
export const codexRequestContext = new AsyncLocalStorage<Record<string, unknown> | undefined>();

export function requestThreadId(): string | undefined {
  const meta = codexRequestContext.getStore();
  if (meta === undefined || !Object.hasOwn(meta, 'threadId')) return undefined;
  const id = meta.threadId;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Invalid Codex MCP threadId metadata; refusing to guess the sender.');
  }
  return id.toLowerCase();
}

/** Ancestor pids, nearest first. */
export function pickSelfThreadId(
  holders: Map<string, number>,
  ancestors: number[],
): string | undefined {
  for (const pid of ancestors) {
    const matches = [...holders].filter(([, holder]) => holder === pid);
    if (matches.length > 1) return undefined;
    if (matches.length === 1) return matches[0]![0];
  }
  return undefined;
}

export type ParentLookup = (pid: number) => Promise<number | undefined>;

/** Ancestors of `pid`, nearest first. Bounded so a reported cycle cannot hang us. */
export async function ancestorPids(
  pid: number,
  parentOf: ParentLookup,
  maxDepth = 8,
): Promise<number[]> {
  const out: number[] = [];
  const seen = new Set<number>([pid]);
  let current = pid;
  for (let i = 0; i < maxDepth; i++) {
    const parent = await parentOf(current);
    if (parent === undefined || seen.has(parent)) break;
    out.push(parent);
    seen.add(parent);
    if (parent <= 1) break;
    current = parent;
  }
  return out;
}
