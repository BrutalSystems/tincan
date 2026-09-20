import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
