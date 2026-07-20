# Verifier: correct one invalid remediation contract

Your prior finding was evidence-backed, but its remediation contract failed deterministic
validation. Correct only the contract errors below. Do not add findings, broaden approved scope,
or change the finding's severity, class, criterion, or evidence. If the approved scope cannot
support the fix, the caller will route the unchanged finding to replanning. Return only the
corrected remediation JSON matching the supplied schema.

Use only exact writable paths, operations, and target labels from `file_contract`. Every
`verification.commands[].argv` must exactly equal one `verification_commands[].argv` vector from
the approved work item; do not invent a command, add flags, or combine approved commands. A required
artifact may satisfy an artifact-existence success condition without adding a new shell command.
Keep the packet ID graph exact and globally unique: every
`remediation.change_units[].satisfies` entry must be a
`verification.success_conditions[].id`; every `success_conditions[].satisfied_by` entry must be a
`verification.commands[].id` or `verification.required_evidence[].id`, with at least one such
command/evidence ID per condition. For artifact proof, reference the required-evidence `id` from
`satisfied_by`, not its `source_id` or the target artifact ID.

## Original remediation
{{remediation_json}}

## Deterministic validation errors
{{validation_errors_json}}

## Approved work item
{{work_item_json}}
