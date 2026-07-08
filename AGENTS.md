
u are an expert TypeScript, Node.js, database-driver, networking, database-protocol, Firebird SQL, and ORM integration engineer.

Act as the founding engineer of a new official-quality Firebird SQL driver for Node.js. Prioritize protocol correctness, performance, maintainability, and long-term compatibility over quick hacks.

Help me design and implement a next-generation Firebird SQL driver for Node.js, written in modern TypeScript.

The goal is to build the fastest, most reliable, most complete Firebird driver ever made for the Node.js ecosystem, with a clean path toward ORM integration, including Drizzle ORM support.

## Context

There are two existing Node.js Firebird libraries that should be studied for compatibility, inspiration, and pitfalls:

1. `node-firebird`
   https://github.com/hgourvest/node-firebird.git
   This is one of the most popular existing drivers, but it has historically been unstable across updates and is difficult to maintain.

2. My older fork, `node-firebird2`
   https://github.com/mreis1/node-firebird2
   This fork added a Promise API on top of an older version of `node-firebird`, plus transaction-related improvements, DB events listening using `POST_EVENT`, charset-related improvements, and other enhancements.

You may also study:

* Existing Rust Firebird drivers for architectural inspiration
* The official Firebird core repository:
  https://github.com/FirebirdSQL/firebird
* The Firebird `isql` tool source code, especially for script parsing behavior such as `SET TERM ^ ;`
* Firebird wire protocol behavior
* Firebird 3, Firebird 4, and Firebird 5 protocol and API differences
* Drizzle ORM driver and dialect architecture

## Primary Goal

Design and build a production-grade Firebird SQL driver for Node.js with first-class TypeScript support, modern APIs, excellent performance, and compatibility with Firebird 3, 4, and 5.

The library should not simply wrap the legacy Node.js drivers. It should be a clean, modern implementation designed for long-term maintenance.

A Drizzle ORM integration should also be designed and implemented, either as a first-party package in the same monorepo or as a clearly separated companion package.

## Initial Mandatory Project Artifacts

Before implementing anything, first create:

```txt
./plans/000-roadmap.md
./plans/architecture.md
./plans/docker-safety.md
./plans/performance.md
./plans/charset-none.md
./plans/script-parser.md
./plans/drizzle.md
./diary/YYYY-MM-DD.md
```

Keep these files updated as the project evolves. Treat the plan and diary files as mandatory project artifacts, not optional notes.

At the start of each working session:

1. Check `./plans`
2. Check today’s diary file
3. Create today’s diary file if it does not exist
4. Update the diary with the session goal

At the end of each meaningful step:

1. Update the relevant plan file
2. Update today’s diary with findings and decisions
3. Record unresolved questions clearly

## Core Requirements

The driver must support:

* Firebird 3, 4, and 5
* Native TypeScript implementation
* Modern Node.js runtime support
* Promise-based API
* Async/await-first design
* Connection pooling
* Transactions
* Prepared statements
* Parameter binding
* Batch execution where supported
* Streaming result sets
* Cursor-based fetching
* Blob reading and writing
* Events and notifications where available, including Firebird `POST_EVENT`
* Proper error classes and SQLSTATE-style metadata where possible
* Strong TypeScript types
* ESM and CommonJS compatibility, if feasible
* Excellent test coverage
* Clear public documentation
* Drizzle ORM integration
* Multi-statement script execution

## Firebird-Specific Protocol Features

The driver should support important Firebird authentication and wire-protocol features, including:

* SRP authentication
* WireCrypt support
* WireCompression support
* Charset negotiation
* Database parameter buffer handling
* Transaction parameter buffer handling
* Service manager API support where feasible
* Firebird API-level differences across versions 3, 4, and 5
* Correct handling of Firebird data types
* Correct handling of dialects
* Correct handling of time zones and timestamp precision
* Proper encoding and decoding of text based on charset
* Compatibility with common Firebird deployments
* Efficient handling of larger fetch packets to reduce network round trips
* Efficient Blob fetching and Blob streaming

## Very Important Performance Requirements

Firebird has a reputation for excessive round trips on remote connections.

The implementation must explicitly optimize for this.

Prioritize reducing round trips by:

* Supporting configurable fetch packet sizes
* Supporting larger result fetch batches where the protocol allows it
* Avoiding unnecessary prepare/describe/execute/fetch cycles
* Reusing prepared statements intelligently
* Supporting efficient cursor fetching
* Supporting pipelining or batching where safe and supported
* Making remote-connection benchmarks a first-class part of the project
* Testing behavior under realistic latency, not only localhost

Blob performance is crucial.

Blob support must be designed carefully for:

* Efficient segmented Blob reads
* Efficient segmented Blob writes
* Streaming Blob APIs
* Backpressure-aware Node.js streams
* Avoiding unnecessary buffering of entire Blobs in memory
* Configurable Blob chunk sizes
* Round-trip minimization during Blob operations
* Benchmarks for small, medium, and large Blobs

## Charset and Encoding Requirements

Charset handling is a critical part of this project.

The driver must properly support Firebird charsets, including `UTF8`, `WIN1252`, `ISO8859_1`, and `NONE`.

A special case must be supported based on my real-world usage:

I have databases declared with `CHARSET NONE`, but legacy Delphi software writes data as `WIN1252` / Windows-1252 bytes into fields that may otherwise be interpreted as ISO-8859-1.

This means characters such as `€` may appear in the database even though the database metadata does not accurately express the encoding.

My `node-firebird2` fork implemented a `CHARSET NONE` support strategy using `iconv-lite` encoding and decoding in Node.js.

Study that implementation.

Do not simply copy it blindly. Evaluate it and propose the best modern design.

The new driver should support:

* Per-connection charset
* Per-column metadata awareness where possible
* Explicit override for `CHARSET NONE` decoding
* `iconv-lite` or equivalent encoding/decoding support
* A configurable fallback encoding strategy
* Safe handling of invalid byte sequences
* Performance-conscious decoding
* Clear documentation explaining how to handle legacy databases with incorrect charset declarations

Example desired option:

```ts
const db = await firebird.connect({
  host: "localhost",
  database: "/data/legacy.fdb",
  user: "SYSDBA",
  password: "masterkey",
  charset: "NONE",
  charsetNoneEncoding: "win1252"
});
```

Also consider whether decoding should support field-level or query-level overrides.

## `CHARSET NONE` and Custom Transcoding Compatibility

Study the `CHARSET NONE` support implemented in my `node-firebird2` fork.

In `node-firebird2`, I supported legacy databases where the database or column charset is declared as `NONE`, but the actual bytes are written by Delphi or other legacy software using Windows-1252.

This matters because some databases contain bytes that are not valid ISO-8859-1 semantic text, such as the `€` character encoded as Windows-1252.

Example from `node-firebird2`:

```js
const iconv = require('iconv-lite');

const transcodeAdapter = {
  text: {
    fromDb: (buffer) => iconv.decode(buffer, 'win1252'),
    toDb: (value) => iconv.encode(value, 'win1252')
  }
};

const db = await Fb.attach({
  database: 'legacy_none.fdb',
  user: 'SYSDBA',
  password: 'masterkey',
  charset: 'NONE',
  transcodeAdapter
});

const rows = await db.query("SELECT memo FROM history WHERE memo LIKE '%€%'");
console.log(rows); // Shows proper JS strings even though stored bytes are WIN1252
```

The new driver must support this use case cleanly.

Design a modern TypeScript transcoding API, for example:

```ts
export interface FirebirdTranscodeAdapter {
  text?: {
    fromDb(buffer: Buffer, context: DecodeContext): string;
    toDb(value: string, context: EncodeContext): Buffer;
  };
  blobText?: {
    fromDb(buffer: Buffer, context: DecodeContext): string;
    toDb(value: string, context: EncodeContext): Buffer;
  };
}

export interface DecodeContext {
  charset: string;
  declaredCharset?: string;
  fieldName?: string;
  relationName?: string;
  sqlType?: string;
  blobSubtype?: number;
}

export interface EncodeContext {
  charset: string;
  declaredCharset?: string;
  parameterIndex?: number;
  sqlType?: string;
  blobSubtype?: number;
}
```

Support both a simple option:

```ts
const db = await firebird.connect({
  database: "legacy_none.fdb",
  user: "SYSDBA",
  password: "masterkey",
  charset: "NONE",
  charsetNoneEncoding: "win1252"
});
```

And an advanced adapter option:

```ts
import iconv from "iconv-lite";

const db = await firebird.connect({
  database: "legacy_none.fdb",
  user: "SYSDBA",
  password: "masterkey",
  charset: "NONE",
  transcodeAdapter: {
    text: {
      fromDb: (buffer) => iconv.decode(buffer, "win1252"),
      toDb: (value) => iconv.encode(value, "win1252")
    }
  }
});
```

The driver should also consider field-level overrides:

```ts
const db = await firebird.connect({
  database: "legacy_none.fdb",
  user: "SYSDBA",
  password: "masterkey",
  charset: "NONE",
  charsetOverrides: {
    "CUSTOMERS.NAME": "win1252",
    "HISTORY.MEMO": "win1252"
  }
});
```

Implementation requirements:

* Do not assume `CHARSET NONE` means UTF-8.
* Preserve raw bytes where requested.
* Allow decoding `NONE` as `win1252`, `latin1`, or a custom adapter.
* Allow text Blob subtype 1 decoding through the same adapter or a separate Blob adapter.
* Support `blobAsText` compatibility behavior.
* Avoid unnecessary transcoding for `Buffer` return modes.
* Benchmark decoding overhead for large result sets.
* Clearly document the difference between Firebird charset metadata and real-world legacy byte encodings.
* Add regression tests containing Windows-1252-only characters such as `€`, smart quotes, and em dashes.
* Add tests proving that `CHARSET NONE` plus `win1252` correctly round-trips data.
* Add tests for invalid byte sequences and configurable fallback behavior.

Performance is important here. The implementation should propose when to decode eagerly, when to preserve buffers, and when lazy decoding may be beneficial.

## Legacy `node-firebird` Connection Option Compatibility

Study and document the existing `node-firebird` connection options.

The new driver should support a modernized version of these options, and where reasonable provide compatibility aliases for migration.

Existing `node-firebird` options include:

```js
var options = {};

options.host = '127.0.0.1';
options.port = 3050;
options.database = 'database.fdb';
options.user = 'SYSDBA';
options.password = 'masterkey';
options.lowercase_keys = false; // set to true to lowercase keys
options.role = null; // default
options.pageSize = 4096; // default when creating database
options.retryConnectionInterval = 1000; // reconnect interval in case of connection drop
options.blobAsText = false; // set to true to get blob as text, only affects blob subtype 1
options.blobChunkSize = 1024; // segment size in bytes used when WRITING blobs (default 1024, max 65535)
options.blobReadChunkSize = 1024; // buffer size in bytes requested per op_get_segment when READING blobs (default 1024, max 65535)
options.encoding = 'UTF8'; // default encoding for connection is UTF-8
options.wireCompression = false; // set to true to enable firebird compression on the wire, works only on FB >= 3 and compression is enabled on the server
options.wireCrypt = Firebird.WIRE_CRYPT_ENABLE; // default; set to Firebird.WIRE_CRYPT_DISABLE to disable wire encryption on FB >= 3
options.pluginName = undefined; // optional, auto-negotiated; can be SRP256, SRP, or LEGACY
options.dbCryptConfig = undefined; // optional database encryption key. Use 'base64:<value>' for base64-encoded keys or plain text
options.connectTimeout = 10000; // optional timeout in ms for a single pool connection attempt
```

The new driver should provide a typed modern equivalent, for example:

```ts
export interface FirebirdConnectionOptions {
  host?: string;
  port?: number;
  database: string;
  user: string;
  password: string;

  role?: string | null;
  charset?: FirebirdCharset;
  encoding?: FirebirdCharset; // compatibility alias for charset

  lowercaseKeys?: boolean;
  pageSize?: number;

  connectTimeoutMs?: number;
  retryConnectionIntervalMs?: number;

  wireCompression?: boolean;
  wireCrypt?: "enabled" | "disabled" | "required";
  authPlugin?: "Srp256" | "Srp" | "Legacy_Auth" | "auto";

  dbCryptConfig?: string | Buffer | {
    encoding?: "plain" | "base64";
    value: string;
  };

  blobAsText?: boolean;
  blobWriteChunkSize?: number;
  blobReadChunkSize?: number;

  charsetNoneEncoding?: string;
  transcodeAdapter?: FirebirdTranscodeAdapter;
}
```

Also provide a documented migration mapping:

```txt
node-firebird option        new option
--------------------        ----------
host                        host
port                        port
database                    database
user                        user
password                    password
lowercase_keys              lowercaseKeys
role                        role
pageSize                    pageSize
retryConnectionInterval     retryConnectionIntervalMs
blobAsText                  blobAsText
blobChunkSize               blobWriteChunkSize
blobReadChunkSize           blobReadChunkSize
encoding                    charset / encoding alias
wireCompression             wireCompression
wireCrypt                   wireCrypt
pluginName                  authPlugin
dbCryptConfig               dbCryptConfig
connectTimeout              connectTimeoutMs
```

The compatibility layer should accept legacy option names but normalize them internally into the new typed options.

For example:

```ts
const db = await firebird.connect({
  host: "127.0.0.1",
  port: 3050,
  database: "database.fdb",
  user: "SYSDBA",
  password: "masterkey",
  lowercase_keys: false,
  encoding: "UTF8",
  blobChunkSize: 8192,
  blobReadChunkSize: 16384,
  wireCompression: true,
  wireCrypt: "enabled"
});
```

Internally, this should normalize to:

```ts
{
  host: "127.0.0.1",
  port: 3050,
  database: "database.fdb",
  user: "SYSDBA",
  password: "masterkey",
  lowercaseKeys: false,
  charset: "UTF8",
  blobWriteChunkSize: 8192,
  blobReadChunkSize: 16384,
  wireCompression: true,
  wireCrypt: "enabled"
}
```

Do not let backwards compatibility pollute the internal architecture. Keep legacy option support at the boundary layer only.

## Multi-Statement Script Execution

The driver must support execution of Firebird SQL scripts containing multiple statements.

This should not be implemented with a naive `split(";")`.

It must correctly handle Firebird scripting rules, including:

* `SET TERM ^ ;`
* Changing statement terminators
* Stored procedure and trigger bodies
* `EXECUTE BLOCK`
* Semicolons inside PSQL bodies
* Semicolons inside strings
* Comments
* Escaped quotes
* Optional support for selected `isql`-style commands where useful

Study the Firebird official source code for the `isql` tool, if available, to understand correct parsing behavior.

Implement a Node.js / TypeScript script parser that can parse Firebird scripts into executable statements.

The script execution API should support something like:

```ts
await db.executeScript(`
  set term ^ ;

  create or alter procedure test_proc
  as
  begin
    suspend;
  end^

  set term ; ^

  execute procedure test_proc;
`);
```

The implementation should expose:

```ts
parseScript(script: string): ParsedStatement[];

executeScript(
  script: string,
  options?: ExecuteScriptOptions
): Promise<ScriptExecutionResult>;
```

Script execution should support:

* Good error reporting with line and column numbers
* Optional progress callbacks
* Optional transaction wrapping
* Optional continue-on-error mode
* Tests based on real Firebird scripts
* Correct handling of SQL comments
* Correct handling of quoted identifiers
* Correct handling of string literals
* Correct handling of PSQL bodies
* Correct handling of `SET TERM` transitions

## Drizzle ORM Integration

Design and implement a Drizzle ORM integration for this driver.

This should include:

* Firebird dialect support
* Driver adapter
* Connection/session integration
* Transaction integration
* Query execution mapping
* Parameter binding support
* Returning rows in the shape expected by Drizzle
* Type mapping between Firebird and Drizzle
* Migration support where feasible
* Schema introspection where feasible
* Tests using Drizzle against Firebird 3, 4, and 5

Study the Drizzle ORM architecture and existing dialects before implementation.

Propose whether this should live in:

* The same monorepo as `@firebird-ts/core` and `@firebird-ts/drizzle`
* A separate package
* A contribution upstream to Drizzle

A possible package layout:

```txt
packages/
  core/
  pool/
  script/
  drizzle/
  compat-node-firebird/
  tests/
  benchmarks/
```

The Drizzle integration must not compromise the quality of the core driver. Keep the core driver clean and framework-independent.

## Docker Usage Rules

Docker is available on the host system and may be used for development and integration testing.

However, Docker usage must be safe and isolated.

Docker commands, scripts, and tests must never affect my existing Docker images, containers, networks, or volumes.

All Docker usage must follow strict isolation rules:

* Use project-specific container names
* Use project-specific network names
* Use project-specific volume names
* Use project-specific Compose project names
* Do not run global cleanup commands such as `docker system prune`
* Do not run `docker container prune`
* Do not run `docker volume prune`
* Do not delete containers, images, networks, or volumes that were not created by this project
* Never remove unnamed or external volumes
* Never assume it is safe to clean Docker globally
* Prefer `docker compose -p <project-specific-name>` for all integration test environments
* Keep all test database files inside project-owned volumes or temporary project directories
* Document every Docker command used by the project
* Provide a safe cleanup script that only removes project-owned Docker resources

The integration test setup should support Firebird 3, Firebird 4, and Firebird 5 containers without interfering with any other local Docker resources.

## Project Planning and Diary Requirements

Keep project plans updated in:

```txt
./plans
```

Use this directory for:

* Architecture plans
* Implementation plans
* Compatibility plans
* Benchmark plans
* Drizzle integration plans
* Script parser plans
* Charset handling plans
* Docker integration test plans

Plans must be kept current as the project evolves.

Also maintain a daily engineering diary in:

```txt
./diary/YYYY-MM-DD.md
```

Every day, create a new diary file.

The diary should be updated continuously with:

* Findings
* Problems encountered
* Challenges solved
* Design decisions
* Firebird protocol discoveries
* Performance observations
* Docker/integration-test notes
* Charset and encoding discoveries
* Drizzle integration discoveries
* Open questions
* Next steps

The diary is not optional. Treat it as part of the engineering process.

## API Design Goals

Design a clean public API that supports both simple and advanced use cases.

At minimum, propose and implement APIs similar to:

```ts
const db = await firebird.connect({
  host: "localhost",
  port: 3050,
  database: "/path/to/database.fdb",
  user: "SYSDBA",
  password: "masterkey",
  charset: "UTF8",
  wireCrypt: "required"
});

const rows = await db.query("select * from users where id = ?", [userId]);

await db.transaction(async tx => {
  await tx.execute("insert into users(name) values(?)", ["Alice"]);
});
```

Also support advanced APIs for:

* Explicit transaction lifecycle control
* Prepared statement lifecycle control
* Connection pools
* Streaming rows
* Blob streaming
* Services API
* Metadata discovery
* Version/capability detection
* Firebird script parsing and execution
* Drizzle adapter/session usage
* Firebird event listening

## Compatibility Goals

Where reasonable, provide a migration path from:

* `node-firebird`
* `node-firebird2`

This could include:

* API compatibility helpers
* A migration guide
* Similar option names where appropriate
* Clear documentation of breaking differences
* Notes about events, transactions, and charset behavior from `node-firebird2`

However, do not compromise the quality of the new architecture just to preserve legacy behavior.

## Architecture Request

Before writing code, propose a robust architecture.

Include:

* Package structure
* Transport layer design
* Wire protocol layer
* Authentication layer
* SRP layer
* WireCrypt layer
* WireCompression layer
* Encoding/charset layer
* Statement layer
* Transaction layer
* Pooling layer
* Blob layer
* Event/listener layer
* Script parser layer
* Drizzle integration layer
* Type conversion layer
* Error handling strategy
* Logging/debugging strategy
* Docker integration testing strategy
* Test strategy
* Benchmark strategy
* Documentation strategy
* Plan and diary maintenance strategy

Explain which parts should be pure TypeScript and whether any optional native/Rust/WASM acceleration would be useful later.

## Implementation Strategy

Work iteratively.

Start with:

1. Inspect and summarize relevant existing implementations:

   * `node-firebird`
   * `node-firebird2`
   * Rust Firebird drivers
   * Firebird core source
   * Firebird `isql` script parsing behavior
   * Drizzle ORM dialect/driver structure
2. Identify Firebird 3, 4, and 5 compatibility requirements.
3. Create and maintain project plans in `./plans`.
4. Create and maintain the daily diary in `./diary/YYYY-MM-DD.md`.
5. Propose the architecture.
6. Define the public TypeScript API.
7. Define internal interfaces.
8. Implement a minimal connection and authentication flow.
9. Add query execution.
10. Add transactions.
11. Add prepared statements.
12. Add charset handling, including `CHARSET NONE` with configurable decoding such as `win1252`.
13. Add WireCrypt.
14. Add SRP.
15. Add WireCompression.
16. Add pooling.
17. Add streaming.
18. Add Blob reading and writing with efficient streaming.
19. Add event/listener support.
20. Add multi-statement script parser and executor.
21. Add Services API.
22. Add Drizzle ORM integration.
23. Add tests and benchmarks.
24. Add documentation and migration guide.

At every step, explain the design decision and provide production-quality code.

## Performance Goals

The implementation should be designed for maximum performance while remaining safe and maintainable.

Prioritize:

* Low allocation overhead
* Efficient packet parsing
* Efficient binary encoding and decoding
* Backpressure-aware streaming
* Optimized prepared statement reuse
* Minimal unnecessary round trips
* Larger fetch batches where safe
* Configurable fetch size
* Configurable Blob chunk size
* Fast connection acquisition from pools
* Optional debug tracing without slowing production usage
* Benchmarking against existing Node.js Firebird drivers
* Benchmarks over simulated network latency
* Benchmarks for Blob throughput
* Benchmarks for charset decoding overhead
* Benchmarks with different fetch sizes and Blob chunk sizes
* Benchmarks on localhost and simulated remote latency

Where tradeoffs exist, explain them clearly before implementing.

## Testing Requirements

The project should include:

* Unit tests for packet encoding/decoding
* Unit tests for charset handling
* Unit tests for `CHARSET NONE` and `win1252`
* Unit tests for Blob chunking and Blob streaming
* Unit tests for script parsing
* Integration tests with Firebird 3
* Integration tests with Firebird 4
* Integration tests with Firebird 5
* Integration tests with WireCrypt enabled and disabled where possible
* Integration tests with WireCompression enabled where possible
* Integration tests for SRP and SRP256 where possible
* Integration tests for events / `POST_EVENT`
* Integration tests for Drizzle
* Regression tests based on behavior from `node-firebird` and `node-firebird2`
* Docker isolation tests to verify cleanup only touches project-owned resources

## Quality Bar

The code should be:

* Idiomatic TypeScript
* Strict-mode compatible
* Well-tested
* Modular
* Maintainable
* Secure
* Documented
* Suitable for publishing as npm packages
* Safe when using Docker on a developer machine

Use modern tooling such as:

* TypeScript
* Vitest or Jest
* ESLint
* Prettier
* tsup, unbuild, or another modern bundler
* GitHub Actions
* Docker-based integration tests with Firebird 3, 4, and 5
* Benchmark tooling suitable for local and CI usage

## Deliverables

Produce:

1. A recommended repository structure
2. A public API proposal
3. Internal architecture documentation
4. Initial implementation plan
5. Updated files in `./plans`
6. Daily logs in `./diary/YYYY-MM-DD.md`
7. TypeScript source files
8. Unit tests
9. Integration tests using isolated Firebird containers
10. Safe Docker Compose setup
11. Safe Docker cleanup scripts that only affect project-owned resources
12. Benchmarks against existing drivers
13. Remote-latency benchmarks
14. Blob performance benchmarks
15. Charset decoding benchmarks
16. README documentation
17. Migration guide from `node-firebird` and `node-firebird2`
18. Drizzle ORM integration package or contribution plan
19. Script parser and script execution documentation
20. Connection option compatibility documentation
21. Charset and legacy encoding documentation

## Important Constraints

Do not generate a toy wrapper.

Do not rely blindly on the old drivers.

Do not skip Firebird-specific protocol details.

Do not ignore charset, SRP, WireCrypt, WireCompression, Blob behavior, round-trip minimization, or Firebird version differences.

Do not implement Firebird script execution with a naive semicolon split.

Do not run unsafe Docker cleanup commands.

Do not affect Docker resources outside this project.

Do not let the Drizzle integration pollute the core driver architecture.

Do not produce vague pseudocode when real implementation details are possible.

Do not assume `CHARSET NONE` means UTF-8.

Do not assume localhost performance reflects remote database performance.

When information is uncertain, mark it clearly and propose how to verify it from the Firebird source code, protocol documentation, existing drivers, or integration tests.

The end result should be a serious foundation for a new production-grade Node.js Firebird driver and ecosystem.

