# Architecture

## Guiding principles

1. **Pure TypeScript, zero native deps.** All crypto via `node:crypto` (SHA1/SHA256,
   RC4 via `createCipheriv('rc4', ...)`, zlib via `node:zlib`). BigInt for SRP math.
   Optional native/WASM acceleration is a *later* opt-in (see bottom).
2. **Layered, protocol-version-aware.** Jaybird's proven layering adapted to TS:
   transport → xdr → protocol operations (per-version strategy) → objects
   (Attachment/Transaction/Statement/Blob) → public API.
3. **Round-trip frugality is a design constraint, not an optimization pass.**
   Every operation states its round-trip cost; deferred/batched sends where the
   protocol allows (lazy port semantics, prepare+info in one packet, execute+fetch).
4. **The core stays framework-free.** Drizzle, pooling ergonomics, and legacy compat
   live above the core.

## Layers (packages/core/src)

```
src/
  index.ts                 — public exports
  api/                     — public API surface
    connect.ts             — firebird.connect(), createDatabase()
    attachment.ts          — Attachment: query/execute/transaction/prepare/events
    transaction.ts         — Transaction handle
    statement.ts           — PreparedStatement (reusable), ResultSet streaming
    blob.ts                — Blob streams
    options.ts             — FirebirdConnectionOptions + legacy option normalizer
    errors.ts              — FirebirdError hierarchy (status-vector aware)
  protocol/
    constants.ts           — opcodes, protocol versions, arch, ptype
    xdr.ts                 — XdrReader/XdrWriter (4-byte aligned, big-endian)
    transport.ts           — TCP socket wrapper: framing, backpressure, timeouts,
                             pluggable stream filters (crypt, compression)
    wire.ts                — WireConnection: send/receive ops, response demux,
                             deferred-response queue (pipelining)
    handshake.ts           — op_connect / op_accept_data / op_cont_auth flow
    auth/
      srp.ts               — SRP-6a client (BigInt), Srp & Srp256 variants
      legacy.ts            — Legacy_Auth (DES crypt(3))
    crypt/arc4.ts          — wire encryption filter
    compress.ts            — zlib wire compression filter
    buffers.ts             — DPB/TPB/BPB/SPB builders (tagged parameter buffers)
    blr.ts                 — BLR builder for parameter/output messages
    infoParser.ts          — isc_info_* response parsing (statement metadata, counts)
    messages.ts            — row/param message encode/decode (null bitmap, alignment)
  types/
    codec.ts               — SQL type ⇄ JS value conversion (per sqltype/scale/subtype)
    datetime.ts            — FB date epoch (17 Nov 1898), 1/10000s time fractions, TZ ids
    int128.ts, decfloat.ts — FB4 wide types (BigInt / string-based Decimal)
  charset/
    charsets.ts            — charset id ⇄ name ⇄ bytes-per-char table
    decoder.ts             — text decode/encode incl. NONE strategy, transcodeAdapter,
                             per-field overrides (charsetOverrides)
  pool/pool.ts             — connection pool
  script/                  — script parser (SET TERM aware) — later split to own pkg
  events/                  — POST_EVENT listener (aux connection)
  services/                — Services API
```

## Key design decisions

### Protocol version strategy
Support protocol **13 (FB3) minimum** — this drops pre-FB3 servers from the wire
driver (FB 2.5 is EOL; legacy support can come later via a version-10 strategy
module if demanded). Offer 13..highest in op_connect; a small
`ProtocolVersion` strategy object encapsulates per-version differences
(null-bitmap always present ≥13; batch ops ≥16; etc.).

### Concurrency model
One in-flight logical operation queue per connection (`WireConnection` serializes),
but with **deferred packet support**: operations marked deferrable (allocate,
free, some info requests) are written without awaiting their response; responses
are matched FIFO. This is how jaybird kills round trips.

### Null handling
Protocol ≥13 uses a null bitmap at the start of each row/param message,
padded to 4 bytes. Codec never trusts declared "nullable" alone.

### Error strategy
`FirebirdError extends Error` with `gdsCode`, `sqlState`, `sqlCode`, message
built from the status vector chain (arg_gds + arg_string/arg_number interpolation
using a bundled message table for common codes; fall back to raw codes).

### Logging/debugging
Zero-cost when off: `debug`-style lazy tracer injected at transport and wire
layers (`FASTFIREBIRD_DEBUG=wire,crypt`). Optionally a packet hex-dump mode.

### ESM + CJS
tsup dual build; no top-level await in src.

## Native/WASM acceleration (future, optional)
- SRP BigInt modpow is fine in JS (one-time per connect).
- RC4/zlib already native via node builtins.
- Possible wins later: SIMD UTF-8 validation, decimal128 — only if benchmarks say so.

## Open questions
- ChaCha wire crypt (FB4+) — implement after Arc4 works (node:crypto chacha20).
- Decfloat representation: string by default vs pluggable decimal lib.
- Pool package split timing.
