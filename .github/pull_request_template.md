## Summary

Describe the focused change and why it is needed.

## Verification

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run validate-release -- --json`
- [ ] `npm pack --dry-run --json`
- [ ] `git diff --check`

## Safety

- [ ] The diff contains no credentials, private data, local run artifacts, or unrelated changes.
- [ ] Documentation and tests are updated when behavior changes.
