import { deliverV2, type PromptV2 } from './delivery-v2.js';
import { effectOfV2 } from './events-v2.js';
import { makeLogger, swallow } from './log.js';
import { startPlugin, type PluginDeps } from './plugin.js';

/**
 * The slice of opencode 2.x's plugin context this plugin touches, hand-written
 * for the same reason as types.ts: no dependency on @opencode/plugin, not even
 * for types. Verified against 2.0.24.
 */
export interface V2Context {
  location: { directory: string };
  session: { prompt: PromptV2 };
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown> };
  tool: {
    hook(
      name: 'execute.before' | 'execute.after',
      callback: (input: unknown) => Promise<void> | void,
    ): Promise<unknown>;
  };
}

export type V2Deps = Omit<PluginDeps, 'transport' | 'deliver' | 'selfCheck' | 'effectOf'>;

/** 2.x passes the call id as `id`; the shared hooks read 1.x's `callID`. */
function asV1ToolInput(input: unknown): unknown {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  return { tool: i.tool, sessionID: i.sessionID, callID: i.id };
}

function disposeOf(registration: unknown): () => unknown {
  const d = (registration as { dispose?: unknown } | null)?.dispose;
  return typeof d === 'function' ? () => (d as () => unknown).call(registration) : () => undefined;
}

/**
 * opencode 2.x entry: the same registry, socket and wire as 1.x, fed from the
 * plugin context instead of the 1.x hooks map. Returns the cleanup 2.x calls
 * when it unloads the plugin. SPEC.md §2.1.
 */
export async function startV2(ctx: V2Context, deps: V2Deps): Promise<() => Promise<void>> {
  const log = swallow(makeLogger(deps.sink));
  const directory = ctx?.location?.directory;

  const hooks = await startPlugin({
    ...deps,
    // No round trip at load — the 1.x lesson (SPEC §3) holds: init is not the
    // place for one. Checking the shape is enough: 2.x hands the plugin a
    // real API, not a private transport that may have moved.
    selfCheck: async () => {
      const ok = typeof ctx?.session?.prompt === 'function'
        && typeof ctx?.event?.subscribe === 'function'
        && typeof directory === 'string';
      // Expected once per load under `opencode serve` on 1.x, which calls
      // setup() as well as server() [verified 1.18.34; `opencode run` calls
      // server() only]. The 1.x half has already bound by then, so this is
      // the 2.x half standing aside, not a failure — the detail says so.
      if (!ok) log({ event: 'selfcheck.failed', detail: 'not an opencode 2.x context; on 1.x, server() handles this host' });
      return ok;
    },
    deliver: (msg, sent) => deliverV2((input) => ctx.session.prompt(input), msg, sent),
    effectOf: (event) => effectOfV2(event, directory),
  });

  const abort = new AbortController();
  const subscription = (async () => {
    if (typeof ctx?.event?.subscribe !== 'function') return;
    try {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        if (abort.signal.aborted) break;
        await hooks.event({ event });
      }
    } catch (e) {
      // An abort on cleanup ends the stream with a throw; that is not news.
      if (!abort.signal.aborted) log({ event: 'subscribe.failed', detail: String(e) });
    }
  })();

  const registrations: Array<() => unknown> = [];
  if (typeof ctx?.tool?.hook === 'function') {
    try {
      registrations.push(disposeOf(await ctx.tool.hook('execute.before', (i) => hooks['tool.execute.before'](asV1ToolInput(i)))));
      registrations.push(disposeOf(await ctx.tool.hook('execute.after', (i) => hooks['tool.execute.after'](asV1ToolInput(i)))));
    } catch (e) {
      log({ event: 'hook.failed', detail: String(e) });
    }
  }

  return async () => {
    abort.abort();
    for (const dispose of registrations) {
      try { await dispose(); } catch { /* the host is unloading us anyway */ }
    }
    await hooks.dispose();
    await subscription;
  };
}
