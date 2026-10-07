import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as Record<string, any>;

/**
 * opencode's loader does NOT import the package by its "." export.
 * packages/opencode/src/plugin/shared.ts, resolvePackageEntrypoint:
 *
 *   const exports = pkg.json.exports
 *   if (isRecord(exports)) {
 *     const raw = extractExportValue(exports[`./${kind}`])   // kind = "server"
 *     if (raw) return resolvePackagePath(...)
 *   }
 *   if (kind !== "server") return
 *   const main = packageMain(pkg)
 *   if (!main) return
 *
 * So it looks for `exports["./server"]`, then falls back to `main`. A package
 * carrying only `exports["."]` resolves to no entry point and is silently not
 * loaded — fetched, installed, never executed, with no error anywhere. That
 * is exactly what 0.6.1 did.
 */
describe('published plugin manifest', () => {
  it('declares the ./server export opencode actually looks for', () => {
    expect(pkg.exports?.['./server']).toBe('./tincan.ts');
  });

  it('declares main as the fallback the loader uses next', () => {
    expect(pkg.main).toBe('./tincan.ts');
  });

  it('keeps the "." export for ordinary importers', () => {
    expect(pkg.exports?.['.']).toBe('./tincan.ts');
  });

  it('points every entry at the same file, so they cannot drift apart', () => {
    expect(new Set([pkg.main, pkg.exports['.'], pkg.exports['./server']]).size).toBe(1);
  });

  it('ships that entry file', () => {
    expect(pkg.files).toContain('tincan.ts');
  });

  it('publishes publicly — a new scoped package is restricted by default', () => {
    expect(pkg.publishConfig?.access).toBe('public');
  });
});

/**
 * opencode 2.x loads a SUBDIRECTORY of plugin/ as a plugin too, when it finds
 * an entry file there — verified on 2.0.24, where tincan-lib/server.ts made it
 * try tincan-lib/ and log "Plugin must export a default definition" on every
 * start: the same text as #46, from a plugin that was working. The helper
 * directory must hold nothing 2.x reads as an entry. `server` is the name
 * observed; `index` is the conventional one, guarded on the same reasoning.
 */
describe('the helper directory, seen by opencode 2.x', () => {
  it('holds no file 2.x would treat as a plugin entry', () => {
    const lib = fileURLToPath(new URL('../tincan-lib/', import.meta.url));
    const entries = readdirSync(lib).filter((f) => /^(server|index)\.(ts|js|mjs)$/.test(f));
    expect(entries).toEqual([]);
  });
});
