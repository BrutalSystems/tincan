/**
 * Logging with a hard whitelist. SPEC §8.2: the plugin must never write
 * message bodies into opencode's logs. Enforced here rather than remembered
 * at every call site.
 */

export interface LogFields {
  event: string;
  session?: string;
  from?: string;
  delivery?: string;
  message_id?: string;
  status?: number;
  detail?: string;
}

export type Logger = (fields: LogFields) => void;

const ORDER = ['event', 'session', 'from', 'delivery', 'message_id', 'status', 'detail'] as const;

export function formatLog(fields: LogFields): string {
  const parts: string[] = [];
  for (const key of ORDER) {
    const value = (fields as unknown as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${String(value).replace(/\s*[\r\n]+\s*/g, ' ')}`);
  }
  return `[tincan] ${parts.join(' ')}`;
}

export function makeLogger(sink: (line: string) => void): Logger {
  return (fields) => {
    try {
      sink(formatLog(fields));
    } catch {
      // A logging failure must never reach the host. SPEC §8.1.
    }
  };
}
