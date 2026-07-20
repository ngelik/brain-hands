# Brain Hands plan repair

Repair the schema-valid candidate using only the bounded JSON patch contract.

Candidate SHA-256: {{candidate_sha256}}
Approved discovery brief revision: {{approved_discovery_brief_revision}}
Approved discovery brief SHA-256: {{approved_discovery_brief_sha256}}

## Candidate

{{candidate_json}}

## Structured readiness diagnostics

{{diagnostics_json}}

Repair invariants:
- A verification command referenced by `cross_cutting_impacts[].verification_command_ids` must remain `cross_cutting`; never change its tier to satisfy a missing-focused-command diagnostic.
- When a work item has no focused verification command, add or repurpose an unowned command as `focused`, keeping cross-cutting impact ownership internally consistent.
- When focused commands appear after cross-cutting commands, reorder commands without changing their tiers or ownership links.

Return only the structured repair object. Do not return a replacement plan. Do not modify discovery_brief_revision, discovery_brief_sha256, assumptions, accepted_risks, or out_of_scope. Do not add shell commands, `node -e`, `node --eval`, inline scripts, or remote/network commands.
