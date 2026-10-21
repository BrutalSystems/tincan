# Strict Pull Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators configure a session to retrieve granted peer messages from a strict local inbox without native injection, while quarantining other senders.

**Architecture:** Keep native and legacy mailbox delivery unchanged unless a receiver opts in. Add a transactional local inbox service, reuse the send pipeline and envelope, and expose retrieval through MCP and an operator CLI. Keep bodies out of shared logs and retry caches.

**Tech Stack:** Existing TypeScript/Node.js >=22, Node filesystem/crypto APIs, Zod and Vitest; no new dependencies or daemon.

**Spec:** [Approved design](../specs/2026-10-21-strict-pull-inbox-design.md), commit `92917ad`. Read the full design and `CLAUDE.md` before execution. This plan does not authorize publication or installation.

## Global Constraints

- Same-machine, cooperating Tin Can processes sharing one state root; no sandbox against unrestricted same-user processes.
- Grants require runtime plus full durable ID; descriptive slugs are ignored and `@machine` addresses are rejected.
- No global accept setting, dialog automation, child-process relay, permission relay, or notification injection.
- Native sends do not acquire inbox locks; in-flight native sends selected before enable may still land.
- Strict failures never fall back to native or legacy mailbox delivery.
- Retrieval is non-destructive; explicit cursors only. Fetch is not understanding, acknowledgement or an answer.
- Fixed expiry: 24 hours from insertion. Per receiver: 500 items, 10 MiB serialized state. Quarantine admission: 100 items, 2 MiB within those totals.
- Retrieval defaults to 20 items, maximum 100, with a 1 MiB serialized message-data response cap.
- External labels never grant authority. No external credential enrollment, role registry, automatic acknowledgement, or opencode receiver guard in this release.
- Use generic public fixtures and temporary state roots. No live session configuration changes in tests.
- Follow the repository's test-first rule: observe a meaningful failure before implementing each behavior.

## Review Focus

1. Multibyte/escaped content near byte limits must not bypass caps or cause pagination to stall — Tasks 2 and 3.
2. A failed CLI send must not put strict body text into retry files, stderr, or unsent logs — Tasks 4 and 5.
3. Repeated enable and concurrent disable/re-enable must not reset grants accidentally or write into an obsolete generation — Tasks 2 and 3.
4. A stale cursor crossing revocation/release and an unknown identity must not reveal held content — Tasks 3 and 6.
5. A mixed native/pull broadcast or a full quarantine must report partial execution honestly without injecting a strict item — Task 5.

## File Map

| Files | Responsibility |
| --- | --- |
| `src/inbox/types.ts`, `identity.ts` | Shared data contracts, canonical identity normalization, constants |
| `src/inbox/storage.ts` | Safe paths, cross-process lock, atomic snapshot persistence |
| `src/inbox/service.ts` | Grants, state transitions, capacity, retrieval and retry semantics |
| `src/inbox/audit.ts` | Body-free log projection and availability events |
| `src/inbox-cli.ts` | Operator command parsing and JSON/exit mapping |
| `src/tools.ts` | Inject service; route sends, annotate peers, bind retrieval to caller |
| `src/envelope.ts`, `src/log.ts` | Pull method, structured audit fields, answer folding |
| `src/idempotency.ts`, `src/cli-idempotency.ts` | Sender-scoped/fingerprint retry records |
| `src/tincan.ts`, `src/version.ts`, `src/tool-definitions.ts`, `src/send-cli.ts` | MCP/CLI wiring and public result/help shapes |
| `plugins/opencode/tincan-lib/caller.ts` | Recognize retrieval in `TINCAN_TOOLS` for existing caller tickets; no socket policy guard |
| `test/inbox-*.test.ts`, existing targeted test files | Policy, integration and process-boundary regressions |
| `docs/{tools,send-cli,log,design,install,troubleshooting}.md`, `docs/inbox.md`, `README.md` | Public behavior, migration and limits |

The opencode plugin calls the classifier from `plugin.ts`; extend its existing
`TINCAN_TOOLS` list in `caller.ts`, not a second caller-identity mechanism.

## Shared Interfaces

Define these contracts in Task 1; subsequent tasks import them instead of inventing parallel shapes.

```ts
type InboxIdentity = { runtime: RuntimeName; id: string };
type ItemState = 'quarantined' | 'eligible' | 'released';
type PolicyView =
  | { enabled: false }
  | { enabled: true; generation: string; receiver: InboxIdentity };
type InboxItem = {
  envelope: Envelope; state: ItemState; expiresAt: number;
  sequence?: number; urgent: boolean;
};
type InboxSnapshot = {
  version: 1; enabled: boolean; generation: string;
  receiver: InboxIdentity; grants: InboxIdentity[]; nextSequence: number;
  items: InboxItem[]; keys: InboxKeyRecord[];
};
type InboxKeyRecord = {
  namespace: string; keyHash: string; fingerprint: string;
  messageId: string; expiresAt: number;
};
type ReadArgs = { cursor?: string; limit?: number };
type ReadResult =
  | { enabled: false; messages: []; notice: string }
  | { enabled: true; messages: InboxItem[]; next_cursor: string; has_more: boolean };
type EnqueueArgs = {
  receiver: InboxIdentity; generation: string; envelope: Envelope;
  sender?: InboxIdentity; key?: string; namespace: string; urgent: boolean;
};
type EnqueueResult = {
  message_id: string; inbox_state: 'queued' | 'quarantined'; duplicate: boolean;
};
```

Use typed `InboxError` codes for `invalid_identity`, `policy_corrupt`, `policy_changed`, `locked`, `queue_full`, `cursor_invalid`, `key_reused`, `commit_unknown`, and `storage_failed`. Translate to existing public outcome/refusal conventions at adapters; errors must never embed bodies. Native `Outcome` remains accepted/rejected/failed.

### Task 1: Identity and wire contracts

**Files:** Create `src/inbox/types.ts`, `src/inbox/identity.ts`, `test/inbox-identity.test.ts`; modify `src/envelope.ts` and `test/envelope.test.ts`.

**Interfaces:** Produce `parseInboxIdentity(address: string): InboxIdentity`, `identityKey(identity: InboxIdentity): string`, `senderNamespace(identity: InboxIdentity | undefined, externalLabel?: string): string` and shared types above. Add `pull-inbox` to `DeliveryMethod`.

- [ ] Write identity tests with these assertions (use actual canonical fixture IDs):
  ```ts
  expect(parseInboxIdentity(oldSlug)).toEqual(parseInboxIdentity(newSlug));
  expect(() => parseInboxIdentity(remoteAddress)).toThrow('invalid_identity');
  expect(() => parseInboxIdentity(externalAddress)).toThrow('invalid_identity');
  expect(identityKey(claudeIdentity)).not.toBe(identityKey(codexSameId));
  ```
  Add full-ID validation, malformed separators, path traversal, missing IDs and external-label namespace tests. Assert a pull envelope keeps its peer-origin/no-approval wording and carries `method: 'pull-inbox'`.
- [ ] Run `npx vitest run test/inbox-identity.test.ts test/envelope.test.ts`; observe the new behavior fail.
- [ ] Implement normalization using existing canonical rules, not display-name resolution. Unknown agent namespace is distinct from external labels and never usable as a grant. Include fixed numeric constants from Global Constraints.
- [ ] Rerun the targeted tests and `npm run build`; expect success.
- [ ] Commit the contract and tests: `feat: define strict inbox identities and envelopes`.

### Task 2: Safe bounded transactional storage

**Files:** Create `src/inbox/storage.ts`, `test/inbox-storage.test.ts`, `test/fixtures/inbox-writer.mjs`.

**Interfaces:** Produce `InboxStorage` with constructor `{root, now?, lockTimeoutMs?, probeOwner?}`; `inspect(receiver): Promise<PolicyView>`; `inspectId(id: string): Promise<PolicyView[]>`; `transaction<T>(receiver, fn: (state: InboxSnapshot | undefined) => {state: InboxSnapshot; result: T}): Promise<T>`. Service callbacks are synchronous; storage serializes their execution. `probeOwner` returns `alive | dead | unknown` and must account for process lifetime, not PID alone.

- [ ] Write tests asserting absent root is disabled without creating files, existing directory/missing snapshot throws, corrupt/foreign-owner/symlink state fails closed, and bare-ID inspection does not merge runtime identities. Use fault injection around replacement and synchronization.
  ```ts
  expect(await storage.inspect(receiver)).toEqual({ enabled: false });
  await expect(storage.inspect(receiverWithMissingState)).rejects.toMatchObject({code:'policy_corrupt'});
  expect(await countItemsAfterConcurrentProcesses(20)).toBe(20);
  ```
  Spawn actual child writers for cross-process exclusion; hold one live-owner lock, then assert timeout yields `locked`. Assert age alone never reclaims it, unknown owner fails closed, and confirmed dead owner recovery does not remove another owner's replacement lock.
- [ ] Run `npx vitest run test/inbox-storage.test.ts`; observe meaningful failures.
- [ ] Implement root layout `hash(full ID)/runtime`, directory markers, private permissions, ownership/symlink checks and schema validation. Keep locks outside marker directories. Use bounded lock acquisition (2 seconds by default, test override), unique lock ownership tokens and conservative recovery. Write/fsync a temporary snapshot, rename atomically, and sync the directory before reporting success; uncertain post-rename failure becomes `commit_unknown`. Reject oversized snapshots before replacement. No native transport calls in this module.
- [ ] Rerun storage tests and `npm run build`; expect success. Inspect the child test's exit statuses, not just parent output.
- [ ] Commit: `feat: persist strict inbox state atomically`.

### Task 3: Queue policy, retrieval and lifecycle

**Files:** Create `src/inbox/service.ts`, `test/inbox-service.test.ts`.

**Interfaces:** Produce `InboxService(storage, {now?, newGeneration?})` exposing `inspect`, `inspectId`, `enable(receiver)`, `disable(receiver)`, `grant(receiver,sender)`, `revoke(receiver,sender)`, `release(receiver,messageId)`, `drop(receiver,messageId)`, `status(receiver)`, `quarantine(receiver,{cursor?,limit?})`, `read(receiver,ReadArgs): Promise<ReadResult>`, `enqueue(EnqueueArgs): Promise<EnqueueResult>`, and `preflight(EnqueueArgs): Promise<void>`. `status` returns generation, grants, item/byte/state counts and next expiry; disable returns discard counts. Quarantine uses pagination but is only exposed through operator CLI.

- [ ] Write lifecycle tests: unlisted/unknown sender quarantines; grant enables existing items; revoke hides eligible items; explicit releases survive revoke; regrant assigns new sequences; expiry never extends on regrant. Repeated enable is idempotent, preserving grants and generation. Disable discards bodies; re-enable creates a new generation. All other management calls require enabled state.
  ```ts
  expect((await svc.read(receiver, {})).messages).toHaveLength(0);
  await svc.grant(receiver, sender);
  expect((await svc.read(receiver, {})).messages[0]?.envelope.id).toBe(id);
  await expect(svc.read(receiver, {cursor: priorGenerationCursor})).rejects.toMatchObject({code:'cursor_invalid'});
  ```
  Assert 20/100 limits, 1 MiB response cap, exact expiry boundary, foreign/forged/obsolete cursors, empty-page cursor behavior, cursor-less repeats, and new releases appearing beyond a previously returned cursor. Use Unicode and heavily escaped strings near serialized-byte caps.
- [ ] Write capacity/retry tests: 101st quarantined item or quarantine >2 MiB rejected; total >500 or >10 MiB rejected without eviction; revoke may exceed quarantine admission cap without losing items. Drop retains retry tombstones until original expiry so a retry cannot resurrect a discarded item. Same scoped key/payload returns original ID across restart; different payload rejects; different sender key does not collide. Stale generation refuses insertion with no fallback.
- [ ] Run `npx vitest run test/inbox-service.test.ts`; confirm the added cases fail.
- [ ] Implement the service against Task 2 transactions. Encode/validate receiver+generation+sequence cursors, prune only expired items, maintain monotonic availability, and reserve quarantine capacity. Bound retry records within serialized-state cap; disabling clears content and keys. Enqueue fingerprint includes recipient identity, content and reply metadata; persist no extra body copies in keys. Limit each serialized item to the read-response cap at admission so pagination cannot stall. Preflight is advisory and each enqueue rechecks all limits under its own lock.
- [ ] Rerun identity/storage/service tests and build; expect success.
- [ ] Commit: `feat: add strict inbox grants and pull retrieval`.

### Task 4: Body-free audit and sender-scoped retries

**Files:** Create `src/inbox/audit.ts`, `test/inbox-audit.test.ts`; modify `src/log.ts`, `src/idempotency.ts`, `src/cli-idempotency.ts`, `test/log.test.ts`, `test/idempotency.test.ts`, `test/cli-idempotency.test.ts`.

**Interfaces:** Produce `strictAuditEnvelope(envelope: Envelope): Envelope`, replacing text with `[body omitted: strict inbox]`; add `body_omitted` and structured inbox availability to log records. Add `MessageLog.appendInboxEvent(id, state, at)` for queued/quarantined/released/revoked/expired transitions. Introduce fingerprint-only `PriorSend` variant for strict retries while retaining native legacy read compatibility; namespace key lookup at the caller.

- [ ] Write tests asserting body sentinel absent from live log, rotated log, strict retry files and returned ordinary/missed/all-project records. Preserve required `text`, identities, reply/broadcast metadata and hash integrity. Assert quarantined/failed/indeterminate `answers:true` does not close a question; eligible/released answer assertions do, and later revocation does not undo that historical event. Non-answer releases never close it. Assert native historical log fixtures are unchanged.
- [ ] Run `npx vitest run test/inbox-audit.test.ts test/log.test.ts test/idempotency.test.ts test/cli-idempotency.test.ts`; observe new failures.
- [ ] Implement structured omission and availability projection, with no bodies in event details. Ensure `findMessage` still supports identity-based replies. Update outdated log comments. Retry records use content fingerprints rather than strict body text; old cache entries must never be mistaken for a different sender's scoped key. Preserve native retry timing semantics. Body-bearing audit records already written historically are not rewritten.
- [ ] Rerun targeted tests and build; expect success.
- [ ] Commit: `feat: audit pull delivery without logging message bodies`.

### Task 5: Integrate strict routing into all send outcomes

**Files:** Modify `src/tools.ts`, `src/send-cli.ts`; create `test/inbox-routing.test.ts`; modify `test/tools.test.ts`, `test/send-cli.test.ts`, `test/codex-identity.test.ts`.

**Interfaces:** Add optional fifth argument `inbox: InboxService` to `createTools` after existing mail argument; production constructs service from the same environment root as logging. Add public `inbox_state` and `method: 'pull-inbox'` result fields, preserve them in fan-out and CLI projections. Add typed refusal mappings including `inbox_commit_unknown`, `inbox_policy_changed` and `inbox_full`.

- [ ] Write routing tests using fake runtime delivery and mailbox functions. Assert:
  ```ts
  expect(result).toMatchObject({outcome:'accepted', method:'pull-inbox', inbox_state:'quarantined'});
  expect(nativeDeliver).not.toHaveBeenCalled();
  expect(mailFile).not.toHaveBeenCalled();
  ```
  Cover urgent/prefix/expected-reply/commandSender exceptions; resolved-but-unreachable peers; expect-ID mismatch; missing sender ID; corrupt policy/storage/lock/full failures. Queue commit followed by audit failure must not cause another delivery or report definite non-insertion.
- [ ] Write unsent privacy tests for unknown, changed and unreachable targets with bare intended IDs, including missed/all-project log queries. Test concurrent Codex request identities using the same key; strict retry after receiver exits returns the original result through fingerprint cache/store evidence without sending twice. Mixed broadcasts preflight before mutation, take only one inbox lock at a time, and report per-recipient failures after execution starts.
- [ ] Write activation ordering tests with deferred fake native delivery: a pre-enable policy selection may complete after enable; a post-enable check queues; no native delivery holds/acquires inbox lock. Generation changes after strict selection reject. Assert all text-sentinel disk files outside the inbox are clean, including CLI retry records.
- [ ] Run `npx vitest run test/inbox-routing.test.ts test/tools.test.ts test/send-cli.test.ts test/codex-identity.test.ts`; confirm failures.
- [ ] Integrate sender resolution before outer key lookup, scoped fingerprints, strict policy before liveness/mail routing, body-free audit before attempts, and privacy checks before every unsent write. Use runtime/full ID for grants and conservative all-runtime lookup for bare intended IDs. Strict duplicates bypass retry guard consumption; no native path after strict selection. Unknown resolution remains rejected, not a new offline discovery service. Set envelope method before audit; retain urgency only as metadata. Preflight known storage failures before fan-out; report later failures individually.
- [ ] Rerun the targeted tests plus audit/service tests; expect success.
- [ ] Commit: `feat: route opted-in receivers exclusively through pull inboxes`.

### Task 6: Bind retrieval to MCP caller identity

**Files:** Modify `src/tools.ts`, `src/tool-definitions.ts`, `src/tincan.ts`, `plugins/opencode/tincan-lib/caller.ts`; create `test/inbox-mcp.test.ts`; modify `test/tool-definitions.test.ts`, `test/codex-mcp-e2e.test.ts`, and `plugins/opencode/test/caller.test.ts`.

**Interfaces:** Add `receive_peer_messages(args: ReadArgs): Promise<ReadResult>` to the tools object and MCP dispatcher. Add optional `delivery: 'native'|'mailbox'|'pull'` to peer rows; unknown/error states must not be mislabeled native.

- [ ] Write stdio/request-context tests: two concurrent Codex callers retrieve only their own items, unresolved identity fails, extra receiver argument is rejected, external runtime is refused, and disabled mode returns the documented empty result. Claude and opencode callers use existing identity evidence, not process-wide name fallbacks. Assert actual opencode ticket selection works for the new tool.
- [ ] Add descriptor assertions for repeat/dedupe guidance, no-approval wording, limits, and no management tools. Test peers annotation and strict send notices accurately say no wake-up; policy errors remain visible instead of claiming native delivery.
- [ ] Run `npx vitest run test/inbox-mcp.test.ts test/tool-definitions.test.ts test/codex-mcp-e2e.test.ts test/opencode-self.test.ts plugins/opencode/test/caller.test.ts`; confirm new failures.
- [ ] Implement MCP bindings within existing request metadata context. Use strict argument validation. Register no polling timer or channel capability. Add `receive_peer_messages` to opencode's `TINCAN_TOOLS` classifier; do not add receiver-side socket enforcement.
- [ ] Rerun targeted tests, build and plugin typecheck; expect success.
- [ ] Commit: `feat: expose identity-bound inbox retrieval over MCP`.

### Task 7: Operator CLI and migration guidance

**Files:** Create `src/inbox-cli.ts`, `test/inbox-cli.test.ts`, `docs/inbox.md`; modify `src/tincan.ts`, `src/version.ts`, `test/version.test.ts`, `test/docs-parity.test.ts`, `README.md`, `docs/tools.md`, `docs/send-cli.md`, `docs/log.md`, `docs/design.md`, `docs/install.md`, `docs/troubleshooting.md`.

**Interfaces:** Produce `runInbox(argv: string[], deps: {service: InboxService; stdout(s:string):void; stderr(s:string):void}): Promise<number>`. Add inbox intent to existing argv classifier; no MCP server starts for CLI commands.

- [ ] Write parser/behavior tests for all nine spec commands, required exact identities, duplicate/unknown flags, remote/external receiver rejection, pagination and malformed cursor. Assert one JSON result on operational success/failure; use existing CLI usage exit 64, operational rejection 2, failure 1 and success 0. `--help` succeeds without required args. Refuse missing message IDs and do not echo bodies in errors.
- [ ] Assert repeated enable preserves state, disable reports discarded counts, status includes capacity/next expiry and compatibility limitations, and quarantine inspection is explicit CLI only. CLI and MCP read the identical service data. No TTY gate. Help must warn about cursor-less repeats and in-flight native completion.
- [ ] Run `npx vitest run test/inbox-cli.test.ts test/version.test.ts test/docs-parity.test.ts`; observe failures.
- [ ] Implement commands by delegating to the service. Expose status diagnostics for known old sender versions; missing versions are unknown, not compatible. Explain shared state roots, restarting all senders, unaffected native messaging, no idle wake-up, retention/drop operations and external-label quarantine. Update log terminology and the intentional CLI-query exception. Use only generic examples; do not change versions or user configuration.
- [ ] Rerun targeted tests and `npx vitest run test/docs-links.test.ts`; expect success.
- [ ] Commit: `feat: add operator inbox commands and public documentation`.

### Task 8: Whole-feature verification and review

**Files:** Extend `test/inbox-mcp.test.ts` and `test/inbox-storage.test.ts` with end-to-end recovery cases; no unrelated refactors.

- [ ] Add a built-binary test using a temporary state root: enable receiver, grant sender, send through fake runtime discovery, retrieve through identity-bound MCP, revoke, quarantine, release, fetch beyond old cursor, then disable/re-enable. Assert native adapter calls remain zero for strict selections and log/cache files contain no body sentinel. Interrupt a child writer at the storage seam and verify original-key retry reconciles safely.
- [ ] Run the new scenario and observe failure before completing any missing integration. If it already passes, follow the repo's regression-test instruction: temporarily break the relevant integration, observe that precise failure, restore it, and rerun.
- [ ] Run `npm run build`, `npm run typecheck:plugin`, `npm run typecheck:test`, and `npm test`. Inspect every exit status. Run `git diff --check` and public-content checks on feature commits using `bash scripts/check-public.sh --range <execution-base>..HEAD`. Fix substantive failures with targeted tests before rerunning broader checks.
- [ ] Commit remaining integration tests/fixes with a descriptive message. Request a whole-branch review under the selected execution workflow; give the reviewer spec commit `92917ad`, this plan, execution base and final head. Resolve valid findings and rerun affected checks.
- [ ] Report final behavior, validation evidence and operational limitations. Do not publish, bump versions, push tags, change native permission settings, or globally install anything as part of this plan.

## Execution Handoff

Dependencies are sequential: contracts → storage → service → audit/retries → routing → MCP → CLI/docs → whole-feature review. Use an isolated worktree at execution time. This plan creates one feature, not separately shippable policy and storage subsystems.

Recommended execution: **Native**, with one final independent review. The tasks share identity, storage and audit contracts tightly; keeping implementation context together reduces interface drift. The alternative is subagent-driven execution with a fresh implementer/reviewer for each task, at greater coordination and context cost.

Implementation begins after the user reviews this plan and selects an execution method. Design approval is already recorded; do not reopen those decisions unless implementation uncovers a concrete contradiction.
