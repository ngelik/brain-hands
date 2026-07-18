# Verifier: correct one invalid remediation contract

Your prior finding was evidence-backed, but its remediation contract failed deterministic
validation. Correct only the contract errors below. Do not add findings, broaden approved scope,
or change the finding's severity, class, criterion, or evidence. If the approved scope cannot
support the fix, the caller will route the unchanged finding to replanning. Return only the
corrected remediation JSON matching the supplied schema.

## Original remediation
{{remediation_json}}

## Deterministic validation errors
{{validation_errors_json}}

## Approved work item
{{work_item_json}}
