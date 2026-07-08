# Script Parser Plan (multi-statement execution)

## Requirements (from AGENTS.md)

Parse and execute isql-style scripts. NO naive `split(';')`. Must handle:
- `SET TERM ^ ;` and arbitrary terminator changes
- PSQL bodies (procedures/triggers/EXECUTE BLOCK) containing `;`
- String literals (incl. escaped quotes `''`), q-literals `q'{...}'` (FB2.5+)
- Quoted identifiers `"..."`
- Line comments `--` and block comments `/* */` (non-nesting)
- Good errors with line/column
- Optional isql commands passthrough/ignore list (SET TERM consumed by parser;
  others like COMMIT handled as statements; CONNECT etc. rejected by default)

## Approach

Single-pass lexer/scanner state machine over the script (no full SQL grammar):
states: Default | LineComment | BlockComment | SingleQuote | DoubleQuote | QLiteral.
In Default state, match current terminator (multi-char safe, case-sensitive
token compare) at token boundary; detect `SET TERM <newterm> <oldterm>`
case-insensitively at statement start and switch terminators without emitting.

Note isql behavior (verify in references/firebird/src/isql/): isql does NOT
track BEGIN...END nesting — that's exactly why SET TERM exists. Correct
compliant behavior = honor the terminator, don't outsmart it.

Emitted statement: { sql, line, column, endLine, endColumn, terminator }.

## API

```ts
parseScript(script: string, opts?): ParsedStatement[]
attachment.executeScript(script, {
  transaction: 'perScript' | 'perStatement' | 'none',
  continueOnError?: boolean,
  onProgress?: (stmt, index, total, result) => void,
})
```

Errors carry statement text + line/col; result collects per-statement outcomes.

## Tests
Real-world scripts: procedure+trigger DDL with SET TERM, EXECUTE BLOCK with
nested begin/end, strings containing `;` and `€`, comments containing terminators,
q-literals, empty statements, terminator that is a substring of another token.

## Status
Design done; implement in M5. Verify isql edge cases against
`references/firebird/src/isql/isql.epp` before implementation.
