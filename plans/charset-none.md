# Charset & `CHARSET NONE` Plan

## The real-world problem (from node-firebird2 experience)

Databases declared `CHARSET NONE` whose bytes were written by legacy Delphi apps
as **Windows-1252**. Bytes like `€` (0x80 in win1252) are not valid ISO-8859-1
semantic text and definitely not UTF-8. The driver must not guess UTF-8.

## Design

Connection-level:

```ts
connect({
  charset: "NONE",
  charsetNoneEncoding: "win1252",       // simple path (iconv-lite name)
  transcodeAdapter: { text: { fromDb, toDb }, blobText: { ... } },  // advanced
  charsetOverrides: { "CUSTOMERS.NAME": "win1252" },               // field-level
})
```

Resolution order for decoding a text column:
1. `transcodeAdapter` (text vs blobText by sqltype/blob subtype) — full control,
   receives DecodeContext { charset, declaredCharset, fieldName, relationName, sqlType, blobSubtype }
2. `charsetOverrides["REL.FIELD"]` / `charsetOverrides["FIELD"]`
3. Column's declared charset id from statement metadata (when ≠ NONE and connection charset is NONE... note: with lc_ctype=NONE the server sends raw bytes untranscoded — this is exactly what we want for legacy DBs)
4. `charsetNoneEncoding` when effective charset is NONE
5. Connection charset
6. Fallback: latin1 (byte-preserving), never throw by default; `onDecodeError: 'replace' | 'strict' | 'preserveBuffer'` option

Encoding parameters follows the mirror path (toDb).

## Implementation notes

- Use `iconv-lite` (pure JS, no native deps) for win1252/iso8859-1/etc.
  UTF8 + latin1 fast paths use Buffer native decode (measurably faster).
- Per-column decoder is resolved ONCE at prepare time (metadata is known) and
  cached in the row decoder plan — no per-cell branching.
- `Buffer` return mode (`returnBuffers` or per-query option) skips transcoding.
- Charset id lives in `sqlsubtype & 0xFF` for text types; blob text = subtype 1
  with charset in blob metadata / field metadata.
- OCTETS (charset id 1) always → Buffer.

## Tests (regression-grade)

- Round-trip `€`, `"" ""`, `''`, `—` through NONE+win1252 on FB3/4/5.
- Invalid byte sequences with each onDecodeError mode.
- UTF8 database happy path; WIN1252-declared database; NONE with per-field overrides.
- Blob subtype 1 with blobText adapter; blobAsText compat behavior.
- Benchmark: decode overhead on 100k-row VARCHAR scan (target: within 15% of latin1 fast path).

## Status
Design settled (above); implementation in M2 codec work.
