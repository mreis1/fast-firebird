# Data types

Every Firebird scalar type is supported in both directions — including the
Firebird 4 additions that trip up older drivers.

| Firebird type | JS read value | JS parameter values |
|---|---|---|
| `SMALLINT`, `INTEGER` | `number` | `number`, `bigint`, `string` |
| `BIGINT` | `number` when within `±2^53`, else `bigint` (`int64As: 'auto'`, configurable) | `number`, `bigint`, `string` |
| `INT128` | `bigint` | `bigint`, `number`, `string` |
| `NUMERIC`/`DECIMAL(p,s)` | `number` (lossy beyond 2^53 — see note) | `string` (exact), `number`, `bigint` |
| `FLOAT`, `DOUBLE PRECISION` | `number` | `number` |
| `DECFLOAT(16/34)` | `string` (exact, incl. `'Infinity'`/`'NaN'`) | `string`, `number` |
| `CHAR`, `VARCHAR` | `string` | `string` |
| `DATE`, `TIME`, `TIMESTAMP` | `Date` | `Date` |
| `TIME/TIMESTAMP WITH TIME ZONE` | `Date` (or `ZonedDate`, see below) | `Date`, `ZonedDate` |
| `BOOLEAN` | `boolean` | `boolean` |
| `BLOB` | `Buffer`/`string` (eager) or `Blob` handle | `Buffer`, `string`, `Readable`/`AsyncIterable` |

`int64As` (connection option) controls scale-0 `BIGINT` decoding: `'auto'`
(default — `number` when the value fits safely, `bigint` otherwise),
`'bigint'`, or `'number'`.

## Zone-preserving time zone types (FB4+)

By default, `TIMESTAMP/TIME WITH TIME ZONE` columns decode to JS `Date` — the
exact UTC instant, zone dropped. Opt in to keep the zone:

```ts
const db = await connect({ …, timeZones: 'zoned' });

const [row] = await db.query("select ts from events");
const z = row.TS;            // ZonedDate { date: Date(UTC instant), zone: 'Europe/Lisbon' | '+02:30' }
z.toString();                // 2026-07-13T14:30:00.000Z[Europe/Lisbon]
z.date.toLocaleString('pt-PT', { timeZone: z.zone });  // wall-clock rendering via Intl

await db.execute('insert into events (ts) values (?)',
  [new ZonedDate(new Date('2026-07-13T14:30:00Z'), 'Europe/Lisbon')]);  // round-trips zone + instant
```

Named zones come from a table generated from the Firebird source (637 zones,
tzdata 2026b); offsets decode as `±HH:MM`. Connection-level option (column
readers are cached per statement).

## DECFLOAT and INT128

DECFLOAT and INT128 are fully supported in both directions (strings/bigints
bind losslessly), including the DECFLOAT specials — `'Infinity'`,
`'-Infinity'` and `'NaN'` decode as those strings and bind back as parameters
(JS `Infinity`/`NaN` numbers work too).

## NUMERIC/DECIMAL: numbers out, exact strings in

Scaled `NUMERIC`/`DECIMAL` columns decode to JS `number` — convenient for the
common case, and documented as lossy beyond 2^53 total digits of scaled value.
When you need exactness, keep the money in `DECFLOAT` (decodes to exact
strings) or select `cast(col as varchar(…))`.

**Binding** is exact from strings: `'0.1'` is scaled by string arithmetic,
never via `parseFloat`. This matters doubly in [`executeBatch`](./batch),
where out-of-range and precision-overflow values are rejected client-side with
the offending row's index.

## Character sets

The charset layer is resolved at prepare time (zero per-cell branching): UTF8
and latin1 use native Buffer fast paths, everything else goes through
iconv-lite. Legacy `CHARSET NONE` databases get a dedicated
[transcoding toolkit](./charset-none).
