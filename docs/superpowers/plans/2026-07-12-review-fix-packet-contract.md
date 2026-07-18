# Review Fix Packet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile every new actionable Verifier finding into an immutable, scope-checked JSON packet that a smaller Hands model can execute and prove condition by condition.

**Architecture:** Keep Verifier claims, engine findings, and execution packets distinct. The existing policy engine authorizes a fix; a deterministic compiler adds trusted provenance and approved scope; packet-specific Hands and focused Verifier paths execute and resolve one immutable packet at a time while unversioned persisted queues retain legacy behavior.

**Tech Stack:** TypeScript, Zod, JSON Schema, Vitest, the existing append-only run ledger, Codex role adapters, and the Brain Hands review-policy/runtime state machine.

## Global Constraints

- Use canonical JSON; do not use YAML or generated source patches.
- New queues use `contract_version: "review_fix_packet_v1"`; absent version means legacy.
- New actionable findings use `remediation.verification.commands`; `re_verification` is legacy-only.
- Packets cannot broaden the approved `ExecutionSpecV2` file, target, operation, command, or criterion scope.
- The policy engine remains the only transition authority.
- At most one same-Verifier contract-correction call is allowed and it consumes no Hands fix attempt.
- Preserve existing retry accounting, backup routing, self-review accounting, approval gates, and no-auto-merge behavior.

---

### Task 1: Canonical packet contract

**Files:** Create `src/core/review-fix-packet.ts` and `tests/core/review-fix-packet.test.ts`; modify `src/core/types.ts` only for exported shared contracts.

**Interfaces:** Produce `ReviewFixPacketV1`, `VerifierRemediationClaimV1`, `FixPacketResultV1`, `FixAttemptSupplementV1`, `reviewFixPacketReadinessErrors`, `canonicalReviewFixPacket`, and `hashReviewFixPacket`.

- [ ] Write failing tests for a complete packet, stable canonical bytes/hash, duplicate IDs, unresolved references, vague requirements, unsafe paths, `.git`, case collisions, operation mismatches, missing executable evidence, stale plan hashes, unexpected files, and `allow_additional_files: true`.
- [ ] Run `npx vitest run tests/core/review-fix-packet.test.ts`; confirm failures are caused by the missing contract.
- [ ] Implement the minimal strict schemas, readiness validation, canonical serializer, and hash helper.
- [ ] Run the focused test and `npm run typecheck`; expect success.
- [ ] Commit `feat: add review fix packet contract`.

### Task 2: Strict Verifier remediation output

**Files:** Modify `src/core/types.ts`, `src/core/schema.ts`, `src/core/output-schemas.ts`, `prompts/verifier-review-v2.md`, and focused schema/Verifier tests.

**Interfaces:** Newly generated `ReviewerAction` requires `remediation`; persisted legacy findings remain accepted through the legacy schema.

- [ ] Write failing tests for required actionable remediation, forbidden approve/replan/operational remediation, strict Zod/JSON alignment, unknown-field rejection, legacy persistence, and old/new command exclusivity.
- [ ] Run focused tests and confirm the expected failures.
- [ ] Add the strict generated schema and prompt contract without weakening the persisted schema.
- [ ] Run schema, Verifier, adapter, and typecheck tests.
- [ ] Commit `feat: require structured verifier remediation`.

### Task 3: Packet compilation and ledger

**Files:** Create `src/workflow/fix-packets.ts` and `tests/workflow/fix-packets.test.ts`; extend `src/core/ledger.ts`.

**Interfaces:** Produce `compileReviewFixPacket`, `persistReviewFixPacket`, `loadReviewFixPacket`, and immutable supplement/correction artifact helpers.

- [ ] Write failing tests for engine-owned provenance, approved-scope intersection, deterministic identity, plan-hash lookup, command policy, create-once persistence, conflict rejection, hash revalidation, correction limits, and immutable supplements.
- [ ] Run the focused test and confirm expected failures.
- [ ] Implement deterministic compilation and create-once artifact handling below `reviews/fix-packets/<encoded-id>/`.
- [ ] Distinguish genuine `requires_replan` scope gaps from malformed remediation; allow one correction response and then emit `invalid_verifier_contract`.
- [ ] Run focused workflow, ledger, and typecheck tests.
- [ ] Commit `feat: compile immutable review fix packets`.

### Task 4: Packet-specific Hands invocation

**Files:** Add `prompts/hands-fix-packet-v1.md`; extend prompt loading, worker code, output schemas, and focused tests.

**Interfaces:** Produce `runHandsFixPacket(input): Promise<HandsFixPacketResult>` using strict `FixPacketResultV1` output.

- [ ] Write failing tests for packet/hash provenance, bounded context, result consistency, contradictions, blockers, and profile fallback provenance.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement the packet-specific prompt and worker path without changing initial implementation or legacy fixing.
- [ ] Run worker, prompt, adapter, and typecheck tests.
- [ ] Commit `feat: add packet scoped hands fixer`.

### Task 5: Ordered-action runtime integration

**Files:** Modify `src/workflow/reviewer-actions.ts`, `src/workflow/runtime.ts`, progress types, and runtime tests.

**Interfaces:** Version new queues, retain unversioned legacy queues, and persist packet path/hash/attempt/supplement/result/verification progress.

- [ ] Write failing tests for queue versioning, compile-before-Hands, hidden future packets, exact resume bytes, unexpected real-diff files, and crash boundaries.
- [ ] Run focused runtime tests and confirm expected failures.
- [ ] Route new queues through packet compilation and `runHandsFixPacket`; retain the current scoped-work-item path only for legacy queues.
- [ ] Enforce real diff scope and change-unit coverage before deterministic verification.
- [ ] Feed the immutable packet into self-review while preserving fix reservations, accounting, backup transfer, and idempotent effects.
- [ ] Run local/GitHub runtime and typecheck tests.
- [ ] Commit `feat: execute ordered fixes from packets`.

### Task 6: Condition-level focused resolution

**Files:** Modify `src/workflow/action-verifier.ts`, `prompts/verifier-action-resolution-v2.md`, and focused tests.

**Interfaces:** Produce `verifyReviewFixPacket`; keep the existing action resolver for legacy queues.

- [ ] Write failing tests for packet/hash provenance, one result per success condition, missing evidence, failed commands, all four decisions, and forbidden cross-action authority.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement condition-level resolution; create immutable supplements for `still_open` and route contradictions to narrow replanning.
- [ ] Run focused Verifier, runtime integration, and typecheck tests.
- [ ] Commit `feat: verify fix packet conditions`.

### Task 7: Compatibility, adversarial fixture, and docs

**Files:** Extend schema/runtime/CLI/e2e fixtures; update `README.md` and `agentic-codex-workflow.md`.

- [ ] Add a crash/resume fixture where prose is insufficient but the packet is sufficient for a constrained Hands implementation.
- [ ] Prove readiness rejects the fixture when each critical packet component is removed.
- [ ] Add new-run and unversioned legacy-run end-to-end cases.
- [ ] Document artifacts, correction limits, resume/accounting behavior, compatibility, and command vocabulary.
- [ ] Run focused end-to-end and CLI tests.
- [ ] Commit `docs: document review fix packet workflow`.

### Task 8: Full verification and lifecycle

- [ ] Run `npm run typecheck`.
- [ ] Run `npm test`; rerun the known release timeout case separately if the 5-second fixture timeout recurs, and report both results honestly.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Run `node dist/cli.js --version`.
- [ ] Run `npm_config_cache=/private/tmp/brain-hands-npm-cache npm pack --dry-run` and inspect package contents.
- [ ] Run a fresh built-CLI lifecycle with a complex finding, larger Verifier, configured smaller Hands model, packet/result/evidence/focused-resolution artifacts, and final delivery proof.
- [ ] Audit the final diff against the approved design; fix and rerun affected gates before completion.
