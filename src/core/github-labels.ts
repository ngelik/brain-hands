export interface WorkflowLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export const WORKFLOW_LABELS = [
  { name: "brain-hands", color: "5319E7", description: "Managed by the Brain Hands workflow." },
  { name: "brain:planned", color: "1D76DB", description: "Brain produced the approved implementation plan." },
  { name: "brain:critiqued", color: "0052CC", description: "Brain critique completed for this work item." },
  { name: "hands:ready", color: "0E8A16", description: "Work item is ready for Hands implementation." },
  { name: "verification:required", color: "FBCA04", description: "Verifier evidence is required before delivery." },
] as const satisfies readonly WorkflowLabel[];

export const WORKFLOW_LABEL_NAMES = WORKFLOW_LABELS.map(({ name }) => name);

export const TRANSIENT_BRAIN_HANDS_STATE_LABELS = [
  "brain-hands:ready",
  "brain-hands:implementing",
  "brain-hands:verifying",
  "brain-hands:reviewing",
  "brain-hands:fixing",
  "brain-hands:blocked",
] as const;

export const TERMINAL_BRAIN_HANDS_STATE_LABELS = [
  "brain-hands:complete",
  "brain-hands:not-planned",
] as const;

export const BRAIN_HANDS_STATE_LABELS = [
  ...TRANSIENT_BRAIN_HANDS_STATE_LABELS,
  ...TERMINAL_BRAIN_HANDS_STATE_LABELS,
] as const;

export type BrainHandsStateLabel = typeof BRAIN_HANDS_STATE_LABELS[number];

export const BRAIN_HANDS_STATE_LABEL_DEFINITIONS = [
  { name: "brain-hands:ready", color: "0E8A16", description: "Approved work item is ready for Hands" },
  { name: "brain-hands:implementing", color: "1D76DB", description: "Hands implementation is running" },
  { name: "brain-hands:verifying", color: "FBCA04", description: "Deterministic verification is running" },
  { name: "brain-hands:reviewing", color: "5319E7", description: "Verifier review is running" },
  { name: "brain-hands:fixing", color: "D93F0B", description: "Approved findings are being fixed" },
  { name: "brain-hands:blocked", color: "B60205", description: "Work item requires intervention or replanning" },
  { name: "brain-hands:complete", color: "0E8A16", description: "Work item passed Verifier review" },
  { name: "brain-hands:not-planned", color: "D4C5F9", description: "Closed without planned implementation" },
] as const satisfies readonly WorkflowLabel[];

export const GITHUB_SETUP_LABELS = [
  ...WORKFLOW_LABELS,
  ...BRAIN_HANDS_STATE_LABEL_DEFINITIONS,
] as const satisfies readonly WorkflowLabel[];

const MANAGED_STATE_LABEL_NAMES = new Set<string>(BRAIN_HANDS_STATE_LABELS);

function normalized(value: string): string {
  return value.toLowerCase();
}

export function assertNoCaseInsensitiveLabelCollisions(labels: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const label of labels) {
    const key = normalized(label);
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new Error(`GitHub has a case-insensitive label collision between '${previous}' and '${label}'`);
    }
    seen.set(key, label);
  }
}

function managedLabels(labels: readonly string[]): string[] {
  const managed = labels.filter((label) => MANAGED_STATE_LABEL_NAMES.has(normalized(label)));
  assertNoCaseInsensitiveLabelCollisions(managed);
  return managed;
}

export interface ManagedIssueLabelObservation {
  state: "OPEN" | "CLOSED";
  state_reason: "COMPLETED" | "NOT_PLANNED" | null;
  labels: readonly string[];
}

export function desiredManagedStateLabel(
  issue: Pick<ManagedIssueLabelObservation, "state" | "state_reason">,
  requested: BrainHandsStateLabel,
): BrainHandsStateLabel {
  if (issue.state === "OPEN") {
    if (issue.state_reason !== null) throw new Error("Open GitHub issue has an unexpected terminal reason");
    if ((TERMINAL_BRAIN_HANDS_STATE_LABELS as readonly string[]).includes(requested)) {
      throw new Error(`Cannot project terminal label '${requested}' onto an open GitHub issue`);
    }
    return requested;
  }
  if (issue.state_reason === "COMPLETED") return "brain-hands:complete";
  if (issue.state_reason === "NOT_PLANNED") return "brain-hands:not-planned";
  throw new Error("Closed GitHub issue has no authoritative terminal reason");
}

export function hasExactManagedStateLabel(labels: readonly string[], desired: BrainHandsStateLabel): boolean {
  const observed = managedLabels(labels);
  return observed.length === 1 && normalized(observed[0]!) === normalized(desired);
}

export function managedStateLabelEdit(
  issue: ManagedIssueLabelObservation,
  requested: BrainHandsStateLabel,
): { desired: BrainHandsStateLabel; add: string[]; remove: string[] } {
  const desired = desiredManagedStateLabel(issue, requested);
  const observed = managedLabels(issue.labels);
  const hasDesired = observed.some((label) => normalized(label) === normalized(desired));
  return {
    desired,
    add: hasDesired ? [] : [desired],
    remove: observed.filter((label) => normalized(label) !== normalized(desired)),
  };
}
