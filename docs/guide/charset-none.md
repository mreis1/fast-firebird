# Legacy `CHARSET NONE` databases (the € problem)

A huge share of long-lived Firebird databases — especially those built by
Delphi-era ERP and LOB software — declare their text columns `CHARSET NONE`
and store raw Windows-1252 bytes in them. Modern drivers that assume UTF-8
turn every `€`, `ç`, or `ã` into mojibake.

fast-firebird ships a transcoding toolkit so these databases round-trip
cleanly:

```ts
const db = await connect({
  database: '/data/legacy.fdb',
  charset: 'NONE',
  charsetNoneEncoding: 'win1252',        // simple strategy
  // or full control (node-firebird2-compatible):
  // transcodeAdapter: { text: { fromDb: b => iconv.decode(b, 'win1252'),
  //                             toDb:  s => iconv.encode(s, 'win1252') } },
  // or per-field:
  // charsetOverrides: { 'HISTORY.MEMO': 'win1252' },
});

const rows = await db.query("select memo from history where memo like ?", ['%€%']);
```

Three levels of control:

1. **`charsetNoneEncoding`** — one iconv-lite encoding name applied to every
   `NONE` column (and `NONE`-connection text). The right answer for most
   legacy Windows apps is `'win1252'`.
2. **`transcodeAdapter`** — your own `fromDb`/`toDb` byte↔string functions,
   compatible with node-firebird2-style adapters.
3. **`charsetOverrides`** — per-`TABLE.COLUMN` encoding when one database
   mixes eras.

The transcoding applies to parameters, results, and text blobs alike — the
driver's test suite asserts byte-exact `€` round-trips on every supported
server version.
