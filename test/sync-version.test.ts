import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { syncVersion, checkVersion, VERSION_SITES } from '../scripts/sync-version.mjs';

let dir: string;

const write = (rel: string, body: string) => {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
};
const read = (rel: string) => readFileSync(join(dir, rel), 'utf8');

/** A repo at `v`, laid out as tincan's version sites are. */
function repoAt(v: string) {
  write('package.json', `{\n  "name": "@brutalsystems/tincan",\n  "version": "${v}",\n  "type": "module"\n}\n`);
  write('test/fixtures/canonical-id.json', `{\n  "note": "x",\n  "tincan_version": "${v}",\n  "cases": []\n}\n`);
  write('plugins/opencode/tincan-lib/types.ts', `// types\nexport const PLUGIN_VERSION = '${v}';\nexport type X = 1;\n`);
  write('CANONICAL_ID.md', `# Canonical ID\n\n> **Normative for \`@brutalsystems/tincan\` ${v}.**\n\nBody.\n`);
  write('plugins/opencode/package.json', `{\n  "name": "@brutalsystems/tincan-opencode",\n  "version": "${v}",\n  "type": "module"\n}\n`);
  write('plugins/claude-code/.claude-plugin/plugin.json', `{\n  "name": "tincan",\n  "version": "${v}"\n}\n`);
  write(
    'plugins/claude-code/.mcp.json',
    `{\n  "mcpServers": {\n    "tincan": {\n      "command": "npx",\n      "args": ["-y", "@brutalsystems/tincan@${v}"]\n    }\n  }\n}\n`,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tincan-sync-'));
  repoAt('0.5.5');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('syncVersion', () => {
  test('rewrites every version site from one argument', () => {
    syncVersion(dir, '0.6.0');
    expect(JSON.parse(read('package.json')).version).toBe('0.6.0');
    expect(JSON.parse(read('plugins/opencode/package.json')).version).toBe('0.6.0');
    expect(JSON.parse(read('test/fixtures/canonical-id.json')).tincan_version).toBe('0.6.0');
    expect(read('plugins/opencode/tincan-lib/types.ts')).toContain("PLUGIN_VERSION = '0.6.0'");
    expect(read('CANONICAL_ID.md')).toContain('`@brutalsystems/tincan` 0.6.0.');
    expect(JSON.parse(read('plugins/claude-code/.claude-plugin/plugin.json')).version).toBe('0.6.0');
    expect(JSON.parse(read('plugins/claude-code/.mcp.json')).mcpServers.tincan.args).toEqual([
      '-y',
      '@brutalsystems/tincan@0.6.0',
    ]);
  });

  test('covers every site the release procedure lists, with none missing', () => {
    // The whole point: a fifth site added later must be added here too, or
    // this count is wrong and someone notices.
    expect(VERSION_SITES.map((s) => s.file).sort()).toEqual([
      'CANONICAL_ID.md',
      'package.json',
      'plugins/claude-code/.claude-plugin/plugin.json',
      'plugins/claude-code/.mcp.json',
      'plugins/opencode/package.json',
      'plugins/opencode/tincan-lib/types.ts',
      'test/fixtures/canonical-id.json',
    ]);
  });

  test('reports which files it changed', () => {
    expect(syncVersion(dir, '0.6.0').changed.sort()).toEqual([
      'CANONICAL_ID.md',
      'package.json',
      'plugins/claude-code/.claude-plugin/plugin.json',
      'plugins/claude-code/.mcp.json',
      'plugins/opencode/package.json',
      'plugins/opencode/tincan-lib/types.ts',
      'test/fixtures/canonical-id.json',
    ]);
  });

  test('is idempotent — re-running changes nothing', () => {
    syncVersion(dir, '0.6.0');
    expect(syncVersion(dir, '0.6.0').changed).toEqual([]);
  });

  test('leaves the rest of each file untouched', () => {
    syncVersion(dir, '0.6.0');
    expect(read('plugins/opencode/tincan-lib/types.ts')).toContain('export type X = 1;');
    expect(read('CANONICAL_ID.md')).toContain('Body.');
    expect(JSON.parse(read('package.json')).name).toBe('@brutalsystems/tincan');
  });

  test('throws when a site no longer matches, rather than silently skipping it', () => {
    // A silent no-op here ships a release whose plugin reports the previous
    // version — exactly the class of bug src/version.ts was written to end.
    write('plugins/opencode/tincan-lib/types.ts', 'export const PLUGIN_VERSION = versionFrom(pkg);\n');
    expect(() => syncVersion(dir, '0.6.0')).toThrow(/plugins\/opencode\/tincan-lib\/types\.ts/);
  });

  test('refuses a version that is not semver', () => {
    expect(() => syncVersion(dir, 'v0.6.0')).toThrow(/semver/i);
    expect(read('package.json')).toContain('0.5.5');
  });
});

describe('checkVersion', () => {
  test('passes when every site agrees with package.json', () => {
    expect(checkVersion(dir)).toEqual({ ok: true, version: '0.5.5', mismatches: [] });
  });

  test('catches the published plugin package drifting from the server', () => {
    // The two packages are installed separately — the server by npm, the
    // plugin by opencode — so a version skew between them is exactly the
    // failure this whole file exists to prevent.
    write('plugins/opencode/package.json', `{\n  "version": "0.4.0"\n}\n`);
    expect(checkVersion(dir).mismatches).toContainEqual({
      file: 'plugins/opencode/package.json',
      found: '0.4.0',
      expected: '0.5.5',
    });
  });

  test('catches the Claude Code plugin manifest drifting from the server', () => {
    // The skill it carries describes this version's tools and flags; a
    // manifest left behind tells a reader the skill is older than it is.
    write('plugins/claude-code/.claude-plugin/plugin.json', `{\n  "version": "0.4.0"\n}\n`);
    expect(checkVersion(dir).mismatches).toContainEqual({
      file: 'plugins/claude-code/.claude-plugin/plugin.json',
      found: '0.4.0',
      expected: '0.5.5',
    });
  });

  test('catches the plugin-bundled server pin drifting from the server', () => {
    // The pin is what a plugin install actually runs. Left behind, every
    // plugin user starts the previous release no matter what was shipped.
    write(
      'plugins/claude-code/.mcp.json',
      `{\n  "mcpServers": { "tincan": { "command": "npx", "args": ["-y", "@brutalsystems/tincan@0.4.0"] } }\n}\n`,
    );
    expect(checkVersion(dir).mismatches).toContainEqual({
      file: 'plugins/claude-code/.mcp.json',
      found: '0.4.0',
      expected: '0.5.5',
    });
  });

  test('names the file, what it found, and what package.json says', () => {
    write('CANONICAL_ID.md', '# Canonical ID\n\n> **Normative for `@brutalsystems/tincan` 0.5.4.**\n');
    const r = checkVersion(dir);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual([
      { file: 'CANONICAL_ID.md', found: '0.5.4', expected: '0.5.5' },
    ]);
  });

  test('reports every drifted site, not just the first', () => {
    write('CANONICAL_ID.md', '> **Normative for `@brutalsystems/tincan` 0.5.4.**\n');
    write('plugins/opencode/tincan-lib/types.ts', "export const PLUGIN_VERSION = '0.4.0';\n");
    expect(checkVersion(dir).mismatches.map((m) => m.file).sort()).toEqual([
      'CANONICAL_ID.md',
      'plugins/opencode/tincan-lib/types.ts',
    ]);
  });
});

describe('this repository', () => {
  const root = join(import.meta.dirname, '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  test('the npm version script stages every site it rewrites', () => {
    // A site rewritten but not staged is left out of the release commit, so
    // the tag ships the old literal while the working tree shows the new one.
    const staged: string = pkg.scripts.version;
    for (const { file } of VERSION_SITES) {
      if (file === 'package.json') continue; // npm version stages it itself
      expect(staged, file).toContain(file);
    }
  });

  test('the Claude Code plugin bundles the server under the name tincan, pinned to this release', () => {
    const mcp = JSON.parse(readFileSync(join(root, 'plugins/claude-code/.mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['tincan']);
    expect(mcp.mcpServers.tincan).toEqual({
      command: 'npx',
      args: ['-y', `@brutalsystems/tincan@${pkg.version}`],
    });
  });
});
