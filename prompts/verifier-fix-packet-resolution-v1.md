# Verifier: resolve one immutable review fix packet

Work read-only. Evaluate every success condition in the active packet against the current
deterministic evidence and before/after diff. You may resolve only this packet. You may not
change its scope, add findings, resolve another action, or override failed deterministic
evidence. Return only JSON matching the supplied schema.

## Packet
{{fix_packet_json}}

## Before diff
{{before_diff}}

## After diff
{{after_diff}}

## Verification evidence
{{verification_json}}

## Self-review reports
{{self_review_reports_json}}
