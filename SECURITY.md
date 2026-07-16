# Security Policy

fast-firebird implements authentication (SRP-6a, Legacy_Auth) and wire
encryption (ARC4, ChaCha, ChaCha64) for the Firebird wire protocol, so
security reports are taken seriously and handled with priority.

## Supported versions

| Version | Supported |
|---|---|
| latest published minor | ✅ |
| older versions | ❌ — please upgrade first |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via **GitHub's private vulnerability reporting**:
[github.com/mreis1/fast-firebird/security/advisories/new](https://github.com/mreis1/fast-firebird/security/advisories/new)

Include what you can of:

- The affected area (auth handshake, wire crypt, charset decoding, blob
  handling, SQL/identifier handling, …)
- A minimal reproduction, ideally against a stock Firebird Docker image
- Impact assessment as you see it

You can expect an acknowledgment within **72 hours** and a status update
within **7 days**. Coordinated disclosure is preferred: a fix is developed
privately, released, and the advisory published afterwards with credit to the
reporter (unless you prefer to stay anonymous).

## Scope notes

- **In scope**: anything in `@fast-firebird/core` and `@fast-firebird/drizzle`
  — protocol implementation, crypto, parsing of server-supplied data, SQL
  construction inside the driver (e.g. the migrator, savepoint names,
  introspection queries).
- **Out of scope**: vulnerabilities in the Firebird server itself (report to
  the [Firebird project](https://firebird.org)), and SQL injection through
  *user application code* that interpolates values instead of using
  parameters.
