/**
 * Working out which Codex thread is hosting us.
 *
 * Codex sets no thread-id environment variable for MCP servers, so the host
 * would otherwise have to identify itself by working directory — wrong the
 * moment two Codex sessions share one. But the hosting process holds that
 * thread's writer lock, and we are its descendant.
 */

/** Ancestor pids, nearest first. */
export function pickSelfThreadId(
  holders: Map<string, number>,
  ancestors: number[],
): string | undefined {
  for (const pid of ancestors) {
    for (const [threadId, holder] of holders) {
      if (holder === pid) return threadId;
    }
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
