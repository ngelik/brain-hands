# Durable Brain Discovery Design

**Date:** 2026-07-12
**Status:** Approved design
**Scope:** Add a mandatory, adaptive, locally persisted discovery stage before Brain produces an execution plan.

## Problem

Brain Hands currently moves from resolved intake and preflight directly into a
one-shot Brain planning invocation. The Brain prompt can record assumptions,
but the workflow has no explicit stage in which Brain can inspect the
repository, ask the user clarifying questions, challenge a material assumption,
compare meaningful approaches, or confirm a shared understanding before it
drafts the execution plan.

The conversational skill may perform some of that work informally, but the
engine does not require or preserve it. This makes discovery hidden,
non-resumable, dependent on chat history, and impossible to audit as part of
the workflow contract.

## Goals

- Make discovery a mandatory decision for every newly created run.
- Ask one adaptive question at a time before design and implementation
  planning.
- Include both required clarification and high-value challenges that could
  materially change scope, architecture, acceptance criteria, or verification.
- Avoid artificial questions and alternatives for already clear work.
- Persist questions, answers, approaches, assumptions, briefs, and approvals in
  the local run ledger.
- Require approval of a concise discovery brief before generating the full
  execution plan.
- Keep the Codex skill conversational while making the CLI engine the durable
  source of truth.
- Preserve existing plan approval and every downstream Hands and Verifier gate.
- Keep discovery content out of GitHub.
- Preserve compatibility with runs created before this feature.

## Non-goals

- Adding a fourth Product or Designer model role.
- Publishing discovery conversations to GitHub issues or pull requests.
- Replacing execution-plan approval with discovery-brief approval.
- Turning the CLI into a continuously interactive terminal wizard.
- Asking questions only to demonstrate that discovery occurred.
- Restarting initial product discovery for ordinary implementation replans.

## Chosen approach

Extend the existing Brain role with a distinct, structured discovery protocol.
The engine owns discovery state and artifacts. The Codex skill renders each
pending action in natural language and records the user's response through the
CLI. Direct CLI users interact with the same durable boundaries through
explicit commands and readable or JSON status output.

This approach keeps the existing three-role architecture, reuses Brain's
read-only repository access, and adds the smallest coherent workflow extension.
A skill-only implementation was rejected because it would keep discovery
dependent on chat history. A separate model role was rejected because its
configuration, cost, prompts, capability checks, and handoff boundary are not
justified by the current requirement.

## Workflow architecture

New runs follow this state flow:

```text
intake
-> preflight
-> brain_discovery
-> awaiting_discovery_answer <-> brain_discovery
-> awaiting_discovery_brief_approval
-> brain_planning
-> awaiting_plan_approval
-> existing Hands and Verifier workflow
```

Every run enters `brain_discovery`, including requests that appear complete.
Brain must return one of three structured outcomes:

1. `ask_question`: Ask exactly one required or high-value question.
2. `ready_for_brief`: Report that no material uncertainty remains and produce
   meaningful approaches plus a draft brief.
3. `no_discovery_needed`: Record why the request was already clear, then
   produce approaches and a draft brief, or explain why alternatives would be
   artificial.

An answer is appended as an immutable event. Brain is invoked again with the
original request, repository context, and accumulated discovery record. It may
ask the next single question or advance to the brief.

Rejecting a brief returns the run to `brain_discovery`. The old brief and its
approval state remain immutable history. Rejection does not create an execution
plan revision and never starts Hands.

Approval pins the exact brief revision and SHA-256 digest. `brain_planning`
must verify the digest and consume both the original request and the approved
brief. The existing execution-plan approval remains a separate authorization
gate.

## Repository grounding

Discovery is repository-grounded rather than a language-only interview. Before
deciding whether to ask a question, Brain receives read-only repository access
and must inspect the relevant implementation, tests, documentation,
configuration, and recent commits. It records the repository evidence that
made a question material or made further discovery unnecessary.

Repository inspection is bounded by relevance to the request. Discovery does
not authorize edits, network mutations, or unrelated refactoring analysis.

## Discovery response contract

### Ask-question response

An `ask_question` response contains:

- A stable question ID and monotonic sequence number.
- A category: `required` or `high_value_tradeoff`.
- Exactly one user-facing question.
- Zero or more mutually exclusive suggested choices. Free-form answers remain
  valid.
- A concise rationale.
- One or more material effects chosen from `scope`, `architecture`,
  `acceptance_criteria`, and `verification`.
- Repository evidence references when repository inspection informed the
  question.
- After the soft question limit, a concrete reason the additional question is
  essential.

The response is invalid if it contains multiple questions, an unstable or
duplicate ID, no material effect, or a cosmetic choice that cannot affect the
approved brief or plan.

### Ready-for-brief response

A `ready_for_brief` response contains:

- Two or three materially different approaches with tradeoffs.
- Brain's recommendation and rationale.
- The user's selected approach when already known, or an explicit pending
  approach-selection action.
- A draft discovery brief.

When meaningful alternatives do not exist, Brain records a concrete
`alternatives_omitted_reason` instead of inventing options.

### No-discovery-needed response

A `no_discovery_needed` response contains:

- A concrete explanation of why the request is sufficiently clear.
- Repository evidence supporting that decision.
- Meaningful approaches or `alternatives_omitted_reason`.
- A draft discovery brief.

This is still a durable discovery outcome; it is not a bypass around brief
approval.

## Discovery brief contract

Each brief revision contains:

- Stable brief revision ID.
- Goal and problem statement.
- Verifiable success criteria.
- Constraints.
- Confirmed decisions with stable decision IDs.
- Explicit assumptions with their source.
- Selected approach and rationale.
- Out-of-scope items.
- Accepted unresolved risks.
- Question and answer references that support each decision or assumption.
- Repository evidence references.

An assumption source distinguishes a Brain inference from a user instruction
and from a user-forced `proceed_with_assumptions` decision. The validator
rejects a brief that omits a confirmed decision, recorded forced assumption,
or accepted risk.

Brief validation is deterministic. Decision and assumption IDs are unique;
every source question resolves to a canonically recorded answer; and every
answer from the active discovery cycle is cited by a new or revised decision
or assumption. A revised brief retains every prior confirmed decision ID,
preserves proceed-sourced assumptions byte-for-byte, and preserves prior
accepted risks and out-of-scope items in order. A confirmed decision may
change only when the revised row cites an answer from the active cycle.

## Question budget and stopping rule

Brain stops asking when no unresolved answer could materially change scope,
architecture, acceptance criteria, or verification.

Five answered questions form the soft limit. Brain may ask a sixth question
only when it identifies the exact material decision that remains blocked. Six
is the hard limit. After the sixth answer, Brain must produce a brief with any
remaining uncertainty represented as an explicit assumption or accepted risk.

The user may choose `proceed_with_assumptions` before the limit. That action is
recorded as an immutable user decision. Brain then converts every remaining
material uncertainty into a named assumption or accepted risk and produces a
brief. Brief approval is still required.

## User experience

The CLI starts the workflow and stops at the first durable user boundary. A
machine-readable pending action includes the run, state, exact artifact or
revision, and permitted next actions. For example:

```json
{
  "state": "awaiting_discovery_answer",
  "question_id": "q-001",
  "question": "Should this behavior apply to every run or only ambiguous requests?",
  "choices": ["every_run", "ambiguous_only"],
  "rationale": "This changes the workflow contract."
}
```

The Codex skill:

1. Starts or resumes the run.
2. Reads the pending action.
3. Presents the engine-authored question, approaches, or brief naturally.
4. Records the user's response through an explicit CLI action.
5. Repeats until discovery-brief approval or another terminal boundary.

The skill does not invent, combine, edit, or answer questions. It does not
infer engine approval from silence. It may translate an unambiguous natural
language approval into the explicit command for the displayed revision.

Direct CLI users receive the same boundary in readable text or JSON. Recording
an answer advances only to the next user boundary. It never consumes several
questions, selects an approach, or grants approval automatically.

Answers are accepted through standard input or a local file. A positional
answer is not required, reducing accidental shell-history exposure.

## CLI responsibilities

The CLI adds these explicit operations:

- `answer-discovery --run <run-dir> --question <id>` records an answer against
  the current question ID.
- `select-discovery-approach --run <run-dir> --revision <number> --approach <id>`
  records the selected approach from the current approaches artifact.
- `proceed-discovery --run <run-dir> --question <id>` records the decision to proceed with
  documented assumptions.
- `approve-discovery --run <run-dir> --revision <number>` approves an exact
  discovery-brief revision.
- `revise-discovery --run <run-dir> --revision <number>` rejects the displayed
  brief and records revision guidance.
- Existing `status` and `resume` commands show the current pending discovery
  action.

Text for `answer-discovery`, `proceed-discovery`, and `revise-discovery` is read
from standard input unless the caller supplies `--input-file <path>`. Every
mutating operation carries the run identity and expected question, approaches,
or brief revision. Mutating commands use the existing run lock and fail on
stale state.

`resume` at a user boundary is read-only with respect to Brain invocation. It
returns the already persisted pending action instead of generating another
question or brief revision.

## Durable artifacts and events

Discovery artifacts remain under the run directory:

```text
discovery/
  questions/001.json
  answers/001.json
  questions/002.json
  answers/002.json
  approaches.json
  briefs/revision-001.json
  approved-brief.json
```

Raw prompts, output schemas, and model responses remain in the existing
prompt, schema, and response artifact directories.

The manifest contains current pointers, counters, the approved brief revision,
and the approved SHA-256. Immutable ledger events record:

- Discovery start and readiness decision.
- Every question and answer.
- Approach presentation and selection.
- Proceed-with-assumptions decisions.
- Brief creation, rejection, revision, and approval.
- Planning-discovered gaps that reopen discovery.

The manifest is not the historical record. Rebuilding current discovery status
from validated artifacts and events must produce the same pending action.

## Planning integration

The approved brief is mandatory frozen planner input. The execution plan
records:

- Approved brief revision and SHA-256.
- Every confirmed discovery decision by stable ID.
- A mapping from each decision to a work item, acceptance criterion, or
  verification step, or an explicit statement that the decision has no
  implementation effect.
- Assumptions carried forward unchanged.
- Accepted risks and out-of-scope items.

The planner cannot silently override a confirmed decision. If planning exposes
a material contradiction or missing decision, Brain returns a structured
`discovery_gap` rather than an execution plan. The engine records the evidence,
supersedes the current brief approval without deleting it, and returns to
`brain_discovery`. The revised brief requires approval before planning resumes.

The normal five-question soft limit and six-question hard limit apply to the
initial discovery cycle. A planning-discovered gap opens a new brief-revision
cycle, but the engine supplies the gap as its first question and permits at
most one additional adaptive follow-up. After those two answers, Brain must
produce a revised brief, convert remaining uncertainty into explicit
assumptions or accepted risks when the user authorizes that outcome, or remain
blocked and resumable when proceeding would be unsafe. It must not invent
certainty to satisfy the limit. This keeps reopening bounded while allowing
newly discovered repository facts to be resolved safely.

## Failure and recovery behavior

- Invalid model output does not advance workflow state.
- Discovery permits at most two structured-output attempts for the same turn.
  The second attempt includes only the validation failure needed to correct the
  response; it does not change the question budget or advance workflow state.
- Exhausted retries leave the run blocked but resumable, with the prompt,
  response, validation error, and prior discovery state preserved.
- Recording the same answer twice is idempotent when normalized content
  matches.
- A conflicting second answer is rejected. Changing an answer requires the
  explicit brief-revision path so dependent decisions can be reconsidered.
- A stale question ID, brief revision, or approval digest is rejected.
- Concurrent mutations use the existing run lock.
- Planning fails closed when the approved brief is missing, modified,
  unapproved, or digest-mismatched.
- `status` reports the exact pending user action and artifact revision.

Before an answer is persisted into the ordinary discovery record or sent to
Brain, the existing secret detector checks it. Suspected credentials are
rejected with guidance to provide a redacted answer. The rejected secret-like
value must not appear in normal prompts, responses, progress events, or GitHub
projections.

## GitHub privacy boundary

Questions, answers, rejected alternatives, assumptions under discussion,
draft briefs, and brief approvals remain local. GitHub issue creation continues
to occur only from an approved execution plan.

The approved plan may contain final decisions needed to implement the work, but
it does not publish the discovery transcript. GitHub status projection may
report that a run is awaiting local discovery input without including question
text, answer text, local paths, or arbitrary model output.

## Compatibility

Mandatory discovery applies only to runs created after the feature is enabled.
Persisted runs retain the workflow contract under which they were created:

- A run that already passed preflight continues without synthetic discovery.
- Old manifests do not receive fabricated questions, briefs, approvals, or
  hashes.
- Existing plan revisions and downstream artifacts keep their current meaning.
- The manifest or protocol version distinguishes legacy and discovery-enabled
  runs deterministically.

Ordinary targeted replanning after Hands or Verifier findings continues through
the existing replan protocol. It reopens initial discovery only if new evidence
proves an approved discovery decision invalid; otherwise it remains scoped to
the affected execution work.

Documentation, skill instructions, CLI help, status output, progress events,
package contents, and compatibility metadata must describe the new first-user-
boundary behavior consistently.

## Verification strategy

### Unit tests

- Validate all three discovery response variants.
- Reject multiple questions, missing material effects, duplicate IDs, cosmetic
  alternatives, and incomplete briefs.
- Enforce the five-question soft limit and six-question hard limit.
- Validate brief decision coverage and SHA-256 integrity.
- Verify secret-like answers are rejected before ordinary persistence or model
  reuse.
- Parse legacy manifests without adding discovery state.

### Workflow tests

- Clear request -> `no_discovery_needed` -> brief approval.
- Ambiguous request -> adaptive questions -> approaches -> approved brief.
- `proceed_with_assumptions` -> named assumptions -> approved brief.
- `resume` returns the existing pending action without invoking Brain.
- Duplicate matching answers are idempotent; conflicting answers fail.
- Stale and concurrent answer or approval mutations fail.
- Brief rejection creates a revision without erasing history.
- Planner `discovery_gap` safely reopens a bounded discovery revision.
- Approved decisions remain traceable into the execution plan.
- GitHub adapters receive no discovery transcript content.

### CLI tests

- Verify readable and JSON pending-action output.
- Verify answer input through standard input and local files.
- Verify exit behavior at every user boundary.
- Verify `status` and `resume` identify the exact next action.
- Verify no user response implies brief or plan approval.

### End-to-end verification

A fake-model end-to-end test exercises an adaptive multi-question run through
discovery-brief approval and execution-plan approval. A real authenticated
Brain smoke test verifies that an actual supported model follows the
one-question, repository-grounding, approach, and structured-readiness
contracts.

Before release, run:

```text
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

## Acceptance criteria

1. Every new run records a durable discovery decision before planning.
2. Brain asks at most one question per turn and each question names a material
   effect.
3. Questions adapt to earlier answers and survive process or conversation
   interruption.
4. Brain records why no questions or no alternatives are needed rather than
   silently skipping them.
5. The user can stop questioning and proceed only through documented
   assumptions and subsequent brief approval.
6. Brain presents meaningful approaches when a material design choice exists.
7. No execution plan is created until an exact discovery-brief revision is
   approved.
8. The execution plan identifies and preserves the approved brief digest and
   confirmed decisions.
9. Resume, idempotency, stale-state checks, concurrency control, and invalid
   model output preserve a truthful pending action.
10. Discovery transcript content remains local and is never projected to
    GitHub.
11. Legacy runs resume without synthetic discovery state.
12. Existing plan approval, Hands, Verifier, assurance, and delivery gates
    remain intact.

## Success definition

A user can begin with an underspecified feature or fix, receive only questions
that could materially improve the result, leave and resume at any user
boundary, select an informed approach, approve a concise shared understanding,
and receive an execution plan demonstrably derived from that approved brief.
No implementation begins early, no discovery detail leaks to GitHub, and an
already clear request incurs only a recorded readiness decision and brief
approval rather than an artificial interview.
