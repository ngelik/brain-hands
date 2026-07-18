# Deterministic Plan Approval Requests Design

**Date:** 2026-07-16

**Status:** Approved

## Goal

Reduce repeated plan-approval fatigue without weakening the authorization boundary. Every new plan approval must refer to an exact, immutable, fully validated plan revision and a deterministic description of what that revision authorizes.

## Non-goals

- Cross-run approval carry-forward.
- Equivalence between different plan artifacts.
- Partial-plan or category-only authorization.
- Implicit, batch, or `--yes` approval.
- Model-authored approval recommendations.
- Changing detached `logs --follow` quiescence behavior.
- Publishing, installing, or releasing the package.

## Core invariants

1. Discovery-brief approval and plan approval remain separate gates.
2. A plan approval authorizes the exact bytes and SHA-256 of one persisted plan revision.
3. A replan candidate is materialized, schema-validated, execution-readiness-validated, and discovery-bound before an approval request is exposed.
4. Approval never creates or modifies the plan being approved.
5. The last approved executable revision remains both `current_revision` and `approved_revision` while a replan candidate is pending.
6. `pending_plan_approval.proposed_revision` points to the complete unapproved candidate.
7. Approval atomically promotes the proposed revision to current and approved state, applies any replan progress reset, and clears the pending pointer.
8. Same-run replay of the identical approved subject is idempotent. Cross-run reuse is unsupported.
9. Invalid, incomplete, corrupt, or byte-identical replans do not create an approval prompt.
10. Detailed plans and deltas remain local. GitHub status remains generic.

## Chosen manifest model

For an initial plan boundary:

```text
current_revision = 1
approved_revision = null
pending_plan_approval.proposed_revision = 1
```

For a replan from revision 1 to revision 2:

```text
current_revision = 1
approved_revision = 1
plan_revisions["2"] = fully materialized candidate
pending_plan_approval.proposed_revision = 2
pending_plan_approval.base_revision = 1
```

After explicit approval:

```text
current_revision = 2
approved_revision = 2
pending_plan_approval = null
```

This preserves the repository-wide meaning of `current_revision`: the revision safe for normal verified-plan loading and execution.

## Durable records

### Plan revision

New revision metadata is optional for legacy compatibility:

```ts
interface PlanRevision {
  revision: number;
  path: string;
  sha256: string;
  origin?: "initial" | "replan";
  base_revision?: number | null;
  approval_request_path?: string;
  approval_request_sha256?: string;
  approval_subject_sha256?: string;
  decision_contract_sha256?: string;
  // existing fields remain
}
```

### Pending approval pointer

```ts
interface PendingPlanApprovalV1 {
  schema_version: 1;
  proposed_revision: number;
  base_revision: number | null;
  request_path: string;
  request_sha256: string;
  approval_subject_sha256: string;
}
```

`pending_plan_approval` is immutable through the generic manifest patch API. Only dedicated ledger operations may create or clear it.

### Approval request

The immutable request does not contain its own byte digest. Its digest is recorded by the manifest pointer and revision record.

```ts
interface PlanApprovalRequestV1 {
  schema_version: 1;
  subject: PlanApprovalSubjectV1;
  approval_subject_sha256: string;
  plan_path: string;
  delta: PlanApprovalDeltaV1;
  additional_approvals_expected: "only_if_material_replan";
}
```

Requests are stored at `approvals/plan/revision-N.json` using create-once, no-follow, root-confined writes. Crash recovery may reuse an existing artifact only when its canonical bytes and digest match exactly.

## Approval subject

The subject contains or hashes only stable authorization inputs:

- gate and semantics version;
- run ID;
- reason code;
- proposed and base revisions;
- exact plan SHA-256;
- exact decision-contract SHA-256;
- workflow protocol;
- approved discovery brief revision and SHA-256, or explicit nulls;
- source commit;
- immutable `run-configuration.json` SHA-256;
- recorded controller provenance;
- authority contract.

The authority contract is derived from immutable run snapshots: mode, GitHub effects, review policy, release guards, expected warning-continuation semantics, and manual-only merge authority.

Volatile stage, timestamps, retry counters, work progress, findings, active Hands profile, and delivery state are excluded.

`run-configuration.json` is written create-once when the run is created. Its digest is stored in the manifest. Later byte drift is corruption, not a new approval opportunity.

The controller recorded for the run is part of the subject. A different installed controller cannot approve the pending subject. The operator must restore the recorded controller or start a fresh run. Same-run controller replacement and multiple request generations are deferred.

## Decision contract and delta

The decision contract projects authorization-relevant plan fields with stable ID-based ordering. It includes architecture, assumptions, risks, controller bootstrap, work items, integration verification, accepted risks, out-of-scope decisions, and discovery decision coverage.

`summary`, research narrative, and research-source prose may be omitted from the displayed decision delta, but they remain protected by the exact plan SHA-256.

Delta entries have one stable shape:

```ts
interface PlanDeltaEntryV1 {
  category: PlanDeltaCategory;
  pointer: string;
  operation: "add" | "remove" | "replace";
  before: unknown | null;
  after: unknown | null;
}
```

Entries are sorted by category, pointer, and operation. Model prose never selects categories or equivalence.

A replan is a no-op only when its serialized plan SHA-256 equals the approved base plan SHA-256. Decision-contract equality alone is insufficient.

## Preparation and approval transactions

### Preparation

1. Verify immutable patch, convergence, review-effect, finding, target, criterion, and base-revision provenance.
2. Load the exact verified approved base plan.
3. Purely materialize the candidate.
4. Validate the candidate using the same manifest repository root and workflow protocol used by persisted-plan loading.
5. Validate discovery coverage.
6. Serialize and hash the plan.
7. Reject an exact byte no-op.
8. Calculate the decision contract and delta.
9. Write the plan revision create-once.
10. Write the request create-once.
11. Commit the revision record, pending pointer, and approval-stage transition under the run ledger lock while leaving current and approved revisions on the base.

### Approval

1. Lock and re-read the ledger.
2. Verify the pending pointer and immutable request.
3. Verify request, subject, plan, configuration, controller, discovery, source, authority, and decision-contract bindings.
4. Promote the proposed revision to current and approved.
5. Apply deterministic replan progress resets when applicable.
6. Clear the pending pointer.
7. Append the subject-bound `plan_approved` event.

If the manifest becomes durable before the event append, an identical retry verifies all evidence and appends exactly the missing event. Duplicate or conflicting events fail closed.

## Recovery and compatibility

- Matching orphan plan/request artifacts are reconciled; conflicting orphans block.
- Once an immutable replan patch exists, recovery does not invoke Brain again.
- Existing approved legacy plans retain their current revision/SHA behavior.
- Existing initial-plan approval boundaries without request metadata retain their legacy approval path.
- A legacy patch-only pending replan is never materialized and approved in one command. `resume` prepares the exact new boundary first; the operator must then review and separately approve it.
- Status is observational: it verifies prepared boundaries but does not materialize them.

## Operator surfaces

`status --json` exposes independent fields:

```ts
pending_action: DiscoveryPendingAction | null;
plan_approval_request: PlanApprovalRequestV1 | null;
```

Initial requests render a concise full authorization summary. Replans render base/proposed revisions and a delta-first summary. Local output includes exact digests and plan path. GitHub output identifies only that local approval is required and the proposed revision.

## Verification standard

Implementation is complete only when focused contract, ledger, planner, replan, runtime, status, CLI, skill, and compatibility tests pass; adversarial artifact tests pass; typecheck, planner replay, skill tests, full `npm test`, build, and `npm pack --dry-run` pass; and independent task and whole-change reviews have no unresolved Critical or Important findings.
