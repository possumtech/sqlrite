# Security Policy

## Supported versions

Only the latest major release receives security fixes.

## Reporting

Report vulnerabilities privately via
[GitHub private vulnerability reporting](https://github.com/possumtech/sqlrite/security/advisories/new).
Do not open a public issue for an undisclosed vulnerability.

## Threat model

In scope — these breaking would be a vulnerability:

- `-- PREP` parameter binding failing to isolate untrusted values.
- The hardened connection posture not applying as documented (foreign keys,
  defensive mode, double-quoted-string rejection).
- Escaping in `-- EXEC` / `-- TX` `$var` templating being bypassable *for the
  documented value types*.

Documented limits, not vulnerabilities (see
[SPEC.md — Limits & security](SPEC.md#limits--security)):

- `-- EXEC` / `-- TX` are trusted-SQL paths by contract; routing untrusted
  input through them is SQL injection *by design of the caller*.
- `REGEXP` uses a backtracking engine; attacker-influenced patterns or
  subjects can cause ReDoS. Patterns must be trusted.
