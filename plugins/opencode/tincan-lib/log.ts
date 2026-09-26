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

/**
 * Wrap a callback so its own failure can never reach the host. SPEC §8.1.
 *
 * The one place this pattern lives: every host- or caller-supplied callback
 * in the plugin is wrapped exactly once, where it is captured, and is then
 * called bare everywhere else. Three separate hand-rolled versions of this
 * used to sit in log.ts, plugin.ts and server.ts, with call sites that
 * disagreed about which of them applied.
 */
export function swallow<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  return (...args: A) => {
    try {
      fn(...args);
    } catch {
      // Deliberate. A logging or error-reporting failure is not worth a
      // wedged opencode session.
    }
  };
}

/**
 * Values are quoted when they contain a space, an `=` or a quote.
 *
 * `message_from` is peer-controlled and lands in `from=`. Unquoted, a sender
 * calling itself `x delivery=steer session=ses_victim` forges fields in a
 * line an operator reads during an incident.
 */
function renderValue(value: unknown): string {
  let rendered = String(value)
    // One event is always one line. U+2028 and U+2029 are line
    // terminators too — to a log viewer, to a terminal, and to JS itself.
    .replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ');
  if (rendered.length > 120) {
    rendered = rendered.slice(0, 120) + '…';
  }
  if (/[\s="]/.test(rendered)) {
    rendered = `"${rendered.replace(/"/g, '\\"')}"`;
  }
  return rendered;
}

export function formatLog(fields: LogFields): string {
  const parts: string[] = [];
  for (const key of ORDER) {
    const value = (fields as unknown as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${renderValue(value)}`);
  }
  return `[tincan] ${parts.join(' ')}`;
}

export function makeLogger(sink: (line: string) => void): Logger {
  return swallow((fields: LogFields) => sink(formatLog(fields)));
}
