# Contributing

Contributions are welcome, and I will do my best to work with you on any workflow, coding style, or other issues that may arise.

GitHub is SqlRite's public mirror and contribution forge. External
contributors may open issues and pull requests there; security reports follow
[SECURITY.md](SECURITY.md). PossumTech maintainers perform ordinary development
on the canonical Gitea repository and mirror approved source and release tags to
GitHub.

- Conventions — commits, style, types, test layout — live in [SPEC.md](SPEC.md#conventions).
- The gate: `npm run check` (lint + typecheck + tests, coverage ≥ 80/80/80) must be green.

## Releasing

Releases are operator-run from a clean checkout of canonical `main`:

1. Commit the version change and create the matching signed `v<version>` tag.
2. Push the commit and tag to canonical Gitea and the public GitHub mirror.
3. Run `npm publish` and complete npm's interactive two-factor challenge.
4. Verify the registry version, `gitHead`, integrity, and signatures.

`npm publish` runs the repository gate through `prepublishOnly`, and `prepack`
generates the shipped declarations. No hosted CI service is part of the release
contract. The existing npm GitHub trusted-publisher binding is intentionally
dormant; re-enabling its required hosted workflow is an explicit contract change.
