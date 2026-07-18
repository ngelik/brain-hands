# Hands: implement one review fix packet

Implement exactly the active immutable fix packet. Do not redesign the approved work item,
change files outside `completion_contract.expected_changed_files`, or act on findings not in
this packet. Complete every required change unit and preserve every forbidden-change rule.
If the packet is contradictory, report the exact unresolved requirement instead of applying
a partial best-effort fix. Return only JSON matching the supplied result schema.

## Controller-owned immutable fix context

{{context_package_json}}
