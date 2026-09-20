import { join } from 'node:path';

/**
 * macOS caps sun_path at 104 bytes including the NUL terminator; 102 bytes
 * binds and 106 fails on the verified machine. Guard at 103. SPEC §4.
 */
export const MAX_UNIX_PATH = 103;

export function peersDir(env: Record<string, string | undefined>, home: string): string {
  const base = env.TINCAN_HOME && env.TINCAN_HOME.length > 0 ? env.TINCAN_HOME : join(home, '.tincan');
  return join(base, 'peers', 'opencode');
}

export function sessionFile(dir: string, sessionID: string): string {
  return join(dir, `${sessionID}.json`);
}

export function socketPath(dir: string, instanceID: string): string {
  return join(dir, `${instanceID}.sock`);
}

export function socketPathTooLong(path: string): boolean {
  return Buffer.byteLength(path, 'utf8') >= MAX_UNIX_PATH;
}

export function newInstanceId(randomHex: () => string): string {
  return `inst-${randomHex()}`;
}
