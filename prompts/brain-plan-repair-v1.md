# Brain Hands plan repair

Repair the schema-valid candidate using only the bounded JSON patch contract.

Candidate SHA-256: {{candidate_sha256}}
Approved discovery brief revision: {{approved_discovery_brief_revision}}
Approved discovery brief SHA-256: {{approved_discovery_brief_sha256}}

## Candidate

{{candidate_json}}

## Structured readiness diagnostics

{{diagnostics_json}}

Return only the structured repair object. Do not return a replacement plan. Do not modify discovery_brief_revision, discovery_brief_sha256, assumptions, accepted_risks, or out_of_scope. Do not add shell commands, `node -e`, `node --eval`, inline scripts, or remote/network commands.
