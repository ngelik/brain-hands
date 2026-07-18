# Contributing to Brain Hands

Thank you for helping improve Brain Hands. Public issues and pull requests from
forks are welcome. `@ngelik` is the sole maintainer and the only account with
permission to push, create release tags, merge pull requests, publish packages,
or change repository settings.

## Before opening an issue

- Search existing issues first.
- Use the bug or feature-request form and provide a minimal, reproducible case.
- Do not include credentials, private repository content, personal data, run
  ledgers, or unredacted command output.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Pull requests

1. Fork the repository and create a focused branch.
2. Keep the change surgical and avoid unrelated formatting or refactoring.
3. Add or update tests for behavior changes.
4. Run the required checks:

   ```bash
   npm test
   npm run typecheck
   npm run build
   npm run validate-release -- --json
   npm_config_cache=/private/tmp/brain-hands-npm-cache npm pack --dry-run --json
   git diff --check
   ```

5. Confirm the diff and package tarball contain no secrets or private data.
6. Complete the pull-request template.

The maintainer may request changes, close proposals that do not fit the project,
or squash accepted changes. Opening a pull request does not grant repository
write access.

## License

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE).
