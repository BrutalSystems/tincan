import { deliverV2, type PromptV2 } from './delivery-v2.js';
import { effectOfV2 } from './events-v2.js';
import { makeLogger, swallow } from './log.js';
import { forgetName, pruneNames, recallName, rememberName } from './names.js';
import { startPlugin, type PluginDeps } from './plugin.js';

/**
 * The slice of opencode 2.x's plugin context this plugin touches, hand-written
 * for the same reason as types.ts: no dependency on @opencode/plugin, not even
 * for types. Verified against 2.0.24.
 */
export interface V2Context {
  location: { directory: string };
  /** 2.0.24 carries `{ name, version, channel }`; only the version is used. */
  app?: { version?: string };
  session: {
    prompt: PromptV2;
    /** Resolves to SessionInfo — which has no slug. Used only to re-advertise
     *  a resumed session whose slug we remembered. */
    get?: (input: { sessionID: string }) => Promise<unknown>;
  };
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

  // Names unseen for 30 days go; best effort, never blocks the load.
  void pruneNames(deps.dir, deps.now().getTime()).catch(() => undefined);

  /** Sessions this instance has advertised, and those it cannot: no
   *  remembered name, or another directory's. Checked before any disk read,
   *  because execution events arrive on every turn. */
  const announced = new Set<string>();
  const unresumable = new Set<string>();

  /**
   * A session we never saw created — created before this service started —
   * showing activity. Re-advertise it through the same path a create takes,
   * if we remembered its name and it lives in our directory. SPEC §5.1.
   */
  const resume = async (sessionID: string): Promise<void> => {
    const slug = await recallName(deps.dir, sessionID);
    if (slug === undefined || typeof ctx.session.get !== 'function') {
      unresumable.add(sessionID);
      return;
    }
    const got = (await ctx.session.get({ sessionID })) as Record<string, unknown> | null;
    // Tolerate a `{ data }` envelope as well as the bare SessionInfo 2.0.24 returns.
    const info = (got && typeof got.data === 'object' && got.data !== null ? got.data : got) as
      { title?: unknown; location?: { directory?: unknown } } | null;
    if (info?.location?.directory !== directory) {
      unresumable.add(sessionID);
      return;
    }
    await hooks.event({ event: {
      type: 'session.created',
      location: { directory },
      data: { sessionID, slug, location: { directory }, version: ctx.app?.version ?? '2' },
    } });
    if (typeof info.title === 'string' && info.title !== '') {
      await hooks.event({ event: { type: 'session.renamed', data: { sessionID, title: info.title } } });
    }
    announced.add(sessionID);
    await rememberName(deps.dir, sessionID, slug, deps.now().getTime());
  };

  /** Bookkeeping ahead of the shared handler; never throws into the stream. */
  const track = async (event: unknown): Promise<void> => {
    try {
      const e = event as { type?: unknown; location?: { directory?: unknown }; data?: Record<string, unknown> } | null;
      const sessionID = e?.data?.sessionID;
      if (typeof sessionID !== 'string') return;
      switch (e?.type) {
        case 'session.created': {
          const dir = (e.data?.location as { directory?: unknown } | undefined)?.directory;
          if (dir !== directory || typeof e.data?.slug !== 'string') return;
          announced.add(sessionID);
          unresumable.delete(sessionID);
          await rememberName(deps.dir, sessionID, e.data.slug, deps.now().getTime());
          return;
        }
        case 'session.deleted':
          announced.delete(sessionID);
          await forgetName(deps.dir, sessionID);
          return;
        case 'session.execution.started':
        case 'session.renamed':
        case 'session.viewed':
        case 'session.inbox.enqueued':
          if (!announced.has(sessionID) && !unresumable.has(sessionID)) await resume(sessionID);
          return;
        default:
          return;
      }
    } catch (err) {
      log({ event: 'resume.failed', detail: String(err) });
    }
  };

  const abort = new AbortController();
  const subscription = (async () => {
    if (typeof ctx?.event?.subscribe !== 'function') return;
    try {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        if (abort.signal.aborted) break;
        await track(event);
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
