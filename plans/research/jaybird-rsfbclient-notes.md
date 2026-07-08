# Jaybird & rsfbclient — Wire-Protocol Implementation Notes

Research notes from two clean-room Firebird wire-protocol clients, to inform the design of a new
TypeScript driver.

Sources (read-only clones):

- **Jaybird** (pure-Java JDBC driver, protocol v10–v19, FB 2.x–5.x/6):
  `references/jaybird`, wire code under
  `src/main/org/firebirdsql/gds/ng/wire/` (hereafter `wire/`).
- **rsfbclient** (Rust, pure-rust wire client, protocol v10–v13):
  `references/rsfbclient`, wire code in `rsfbclient-rust/src/`
  (`client.rs`, `wire.rs`, `blr.rs`, `srp.rs`, `arc4.rs`, `xsqlda.rs`, `consts.rs`).
  NOTE: this clone carries local modifications (batched fetching via `FB_FETCH_BATCH`, default 200
  rows/round-trip; upstream fetched 1 row per round-trip) — see comments in `client.rs`.

---

## 1. Architecture (Jaybird) — the part most worth stealing

### 1.1 Layer stack

From bottom to top:

1. **Socket + stream stack** — `wire/WireConnection.java`. Owns the `Socket`,
   `XdrInputStream`/`XdrOutputStream`, and performs `op_connect` handshake. TCP_NODELAY is set,
   connect timeout doubles as initial SO_TIMEOUT. Exposes `XdrStreamAccess` with a
   **transmit lock** (`ReentrantLock`) — every writer does
   `withTransmitLock(xdrOut -> { ...write...; xdrOut.flush(); })`, so multi-message pipelined
   writes are atomic w.r.t. other threads.
2. **XDR layer** — `org.firebirdsql.gds.impl.wire.XdrInputStream/XdrOutputStream`. Big-endian
   ints/longs, `writeBuffer` = 4-byte length + bytes + pad-to-4, `writeString` via connection
   encoding. Crucially the streams are **stackable**: `enableCompression()/enableDecompression()`
   wraps in `FbDeflaterOutputStream`/`FbInflaterInputStream` (zlib) and `setCipher(Cipher)` wraps
   the *innermost* stream in a cipher stream (see §3). This is exactly the shape a TS driver wants:
   a transform pipeline `socket ⇄ [cipher] ⇄ [zlib] ⇄ XDR codec`.
3. **Protocol-version strategy** — `ProtocolDescriptor` (interface, `wire/ProtocolDescriptor.java`)
   is an *abstract factory per protocol version*: `createDatabase`, `createService`,
   `createTransaction`, `createStatement`, `createBlrCalculator`, `createInputBlob/OutputBlob`,
   `createAsynchronousChannel`, `createWireOperations`, plus negotiation metadata
   (`getVersion/getArchitecture/getMinimumType/getMaximumType/getWeight/supportsWireCompression`).
   `ProtocolCollection` (`wire/ProtocolCollection.java`) loads descriptors (ServiceLoader plugin
   mechanism; defaults `version10..version19`, no v14/v17 — those exist server-side but add
   nothing a client needs) and dedupes by version keeping highest weight.
4. **WireOperations** — `FbWireOperations` / `AbstractWireOperations` — version-specific *response
   reading + auth + crypt + deferred-action machinery*, shared by database and service attachments.
   This is a separate axis from the statement/database objects, which keeps handshake logic out of
   the attachment classes.
5. **Attachment/statement objects** — `FbWireDatabase`, `FbWireStatement`, `FbWireTransaction`,
   `FbWireBlob`, `FbWireService` interfaces with abstract bases (`AbstractFbWireDatabase`,
   `AbstractFbWireStatement`) and per-version concrete classes.

### 1.2 The version-subclass chain

Each version package subclasses the previous one and overrides only deltas — a textbook
"protocol version as inheritance chain" (in TS: composition/strategy objects would work equally
well):

| Package | Class chain | What it adds/overrides |
|---|---|---|
| `version10` | baseline (`V10Database`, `V10Statement`, `V10WireOperations`, …) | strict request→response per op; per-column null indicator ints; `op_execute/op_execute2`; events channel; services |
| `version11` | `V11Statement extends V10Statement`, `V11WireOperations` | **deferred responses/pipelining**: allocate+prepare in one flush; `free_statement` deferred (close not even flushed); blob open/get-segment deferred (`V11InputBlob`); the `DeferredAction` queue lives here |
| `version12` | `V12Statement`, `V12Database` | minor (FB 2.5): cancellation (`op_cancel`), dialect handling in parameter converter |
| `version13` | `V13Statement`, `V13WireOperations`, `V13ParameterConverter` | FB 3: **null bitmap** row format, **plugin auth (SRP)** continuation loop, **wire crypt (op_crypt)**, zlib compression flag, UTF-8 filenames (`isc_dpb_utf8_filename`), big sql-info buffers (default 512 KiB, max 16 MiB vs 32767 in v10 — `V13Statement.getDefaultSqlInfoSize()`) |
| `version15` | `V15WireOperations` | FB 3.0.2: crypt-key-callback gains `p_cc_reply` size field (used for DB-crypt callbacks even during connect phase) |
| `version16` | `V16Statement`, `V16WireOperations` | FB 4: statement timeouts (`p_sqldata_timeout` appended to execute msg), **batch API** (`op_batch_*`), deferred-action completion via `op_ping`, force-completion when 64 deferred actions queued (`BATCH_LIMIT`) |
| `version18` | `V18Statement`, `V18WireOperations` | FB 5: **scrollable cursors** (`op_fetch_scroll` = 112, `op_info_cursor` = 113), `p_sqldata_cursor_flags` appended to execute msg, `op_batch_sync` (110) instead of ping |
| `version19` | `V19Statement`, `V19WireOperations`, `V19Database` | FB 5.0.2/6: **inline blobs** (`op_inline_blob` = 114) + client-side `InlineBlobCache`; DPB `isc_dpb_max_inline_blob_size` = 104 |

Descriptors declare negotiation rows; e.g. `Version13Descriptor`:
`(PROTOCOL_VERSION13, arch_generic, ptype_lazy_send, ptype_lazy_send, supportsWireCompression=true, weight=4)`.
Jaybird only supports `ptype_lazy_send` (=5) from v13 up ("Protocol implementation expects lazy
send"). Protocol version constants (`gds/impl/wire/WireProtocolConstants.java`):
`PROTOCOL_VERSION10 = 10`, v11+ are `FB_PROTOCOL_FLAG | n` with `FB_PROTOCOL_FLAG = 0x8000`
(so v13 is `0x800D`; the accept response returns it as a *negative* int which is re-masked:
`protocolVersion = (protocolVersion & FB_PROTOCOL_MASK) | FB_PROTOCOL_FLAG`).
`ptype_rpc=2, ptype_batch_send=3, ptype_out_of_band=4, ptype_lazy_send=5, ptype_MASK=0xFF,
pflag_compress=0x100`. rsfbclient (`consts.rs`) hardcodes `V10=0x0000000A, V11=0xFFFF800B,
V12=0xFFFF800C, V13=0xFFFF800D` and sends rows `[version, 1, 0, 5, weight]` with weights 2/4/6/8
(`wire.rs::connect`).

### 1.3 Handshake (op_connect)

`WireConnection.sendConnectAttachMsg`: `op_connect(1), op_attach(19), CONNECT_VERSION3(3),
arch_generic(1), p_cnct_file (db path string), protocol count, p_cnct_user_id buffer, then N
protocol rows (version, arch, min type, max type [| pflag_compress], weight)`.

The user-id block is tag/len/value bytes (`createUserIdentificationBlock` +
`ClientAuthBlock.writePluginDataTo`): `CNCT_login=9` (user name), `CNCT_plugin_name=8`,
`CNCT_plugin_list=10`, `CNCT_specific_data=7` (multi-part: **each chunk max 254 data bytes,
length byte = chunk+1, first payload byte is a step counter 0,1,2…**), `CNCT_client_crypt=11`
(4-byte vax int: 0=required?, per `WireCrypt` enum level), `CNCT_user=1` (OS user),
`CNCT_host=4`, `CNCT_user_verification=6` (len 0). rsfbclient writes the same tags
(`consts.rs::Cnct`, `wire.rs::connect`) with `ClientCrypt` value `"\x01\x00\x00\x00"`
(little-endian 1 = enabled).

Server replies `op_accept(3)` / `op_accept_data(94)` / `op_cond_accept(98)`:
`p_acpt_version, p_acpt_architecture, p_acpt_type` (type & 0xFF = ptype, & 0x100 = compression
accepted), and for accept_data/cond_accept: `p_acpt_data` (auth plugin data), `p_acpt_plugin`,
`p_acpt_authenticated` (int), `p_acpt_keys` (server crypt key list as untagged clumplets:
`TAG_KNOWN_PLUGINS=0x74`…, `TAG_KEY_TYPE`, `TAG_KEY_PLUGINS`, `TAG_PLUGIN_SPECIFIC` — parsed in
`WireConnection.addServerKeys`). On `op_cond_accept` authentication continues on the *attachment*
via `authReceiveResponse` (§2). Errors during connect can also be `op_response` or `op_reject(4)`.

### 1.4 Deferred responses / pipelining (the key performance idea)

- `wire/DeferredAction.java`: callback interface `{ processResponse(Response), onException(e),
  getWarningMessageCallback(), requiresSync() }` with a builder and a wrapper for public-API
  `DeferredResponse<T>`.
- `version11/V11WireOperations.java` keeps `ArrayList<DeferredAction> deferredActions`.
  `enqueueDeferredAction` appends; **`readNextOperation()` in `AbstractWireOperations` always
  calls `processDeferredActions()` first**, i.e. before reading the response you actually want,
  all queued deferred responses are drained in FIFO order — the server answers requests in order,
  so responses interleave deterministically. `completeDeferredActions()` flushes first when any
  queued action `requiresSync()` (v11–15: flush suffices; v16+: writes `op_ping` (93) or
  `op_batch_sync` (110) and reads its response, because batch ops send no response until forced —
  `version16/V16WireOperations.java`).
- What is pipelined:
  - **prepare**: `V11Statement.prepare` sends `op_allocate_statement` + `op_prepare_statement`
    in one flush, then reads both responses (statement handle from allocate response,
    sql-info from prepare response). v10 does two full round-trips.
  - **free**: `V11Statement.free` — `DSQL_close` is written but *not flushed* (piggybacks on the
    next request); `DSQL_drop`/unprepare is flushed but the response is deferred
    (`requiresSync=true`).
  - **blobs**: `V11InputBlob` defers `op_open_blob2` and even `op_get_segment` responses;
    `V11OutputBlob` similarly; `V11Database` defers `op_close_blob`/`op_cancel_blob`.
  - **async fetch** (`V11Statement.asyncFetchRows`): sends `op_fetch` + flush, enqueues a
    deferred action that runs the normal `processFetchResponse` when the reply is eventually
    drained. `AsyncFetchStatus` tracks pending/completed/exception. Skipped when: after-last,
    already pending, fetchSize==1, named cursor, scrollable cursor, or disabled by property.
- rsfbclient's equivalent is a simple `lazy_count: u32` (`client.rs`): `op_allocate_statement`
  and `op_free_statement` don't get their response read immediately; every subsequent read loop
  first consumes `lazy_count` pending `op_response`s. Statement handle in a pipelined
  prepare-after-allocate is `u32::MAX` (0xFFFFFFFF) as a "last allocated" placeholder.

### 1.5 Response objects

`AbstractWireOperations.processOperation` maps operation → record:

- `op_response (9)` → `GenericResponse(objectHandle int, blobId long, data buffer, exception from
  status vector)`;
- `op_fetch_response (66)` → `FetchResponse(status int, count int)`;
- `op_sql_response (78)` → `SqlResponse(count int)`;
- `op_batch_cs (103)` → `BatchCompletionResponse` (v16+);
- `op_inline_blob (114)` → `InlineBlobResponse` (v19+).
`op_dummy (71)` keep-alives are skipped inside `readNextOperation()`.

### 1.6 Ideas worth stealing for TypeScript

- Transport / XDR / protocol-strategy / statement objects as four separate layers; version
  differences expressed as a small strategy object (factory per version) with delta overrides.
- A single transmit lock (in TS: a promise-chain mutex) around "compose message(s) + flush".
- Deferred-action FIFO drained on every read; `requiresSync` flag distinguishing "needs flush"
  from "needs op_ping/op_batch_sync".
- Expected-response counting during multi-message operations (`expectedResponseCount` +
  `consumePackets(n)` in `V10Statement.execute` / `V11Statement.prepare`) so errors mid-sequence
  don't desynchronize the stream.
- Stackable stream transforms for zlib + cipher, installed mid-connection.

---

## 2. SRP client authentication

### 2.1 Jaybird — `wire/auth/srp/SrpClient.java`

Constants:

- `SRP_KEY_SIZE = 128` (bytes), `SRP_SALT_SIZE = 32`,
  `EXPECTED_AUTH_DATA_LENGTH = (32 + 128 + 2) * 2 = 324`.
- Group prime `N` (1024-bit, hex):
  `E67D2E994B2F900C3F41F08F5BB2627ED0D49EE1FE767A52EFCD565CD6E768812C3E1E9CE8F0A8BEA6CB13CD29DDEBF7A96D4A93B55D488DF099A15C89DCB0640738EB2CBDD9A8F7BAB561AB1B0DC1C6CDABF303264A08D1BCA932D1F1EE428B619D970F342ABA9A65793B8B2F041AE5364350C16F735F56ECBCA87BD57B29E7`
- `g = 2`
- `k = 1277432915985975349439481660349303019122249719989` (decimal) — this is
  `SHA1(N || pad(g))` where `pad(g)` left-pads g's bytes to N's length (verified by
  rsfbclient's `srp_group_k` test in `srp.rs`).

Algorithm (client side):

1. `a` = 128-**bit** random (`new BigInteger(SRP_KEY_SIZE, random)` — note: bits, not bytes),
   `A = g^a mod N`.
2. `A` is sent **hex-encoded (uppercase-agnostic ASCII)** as the CNCT_specific_data payload of
   op_connect (`getPublicKeyHex()` = hex of `pad(A)`), chunked 254 bytes per CNCT clumplet.
   rsfbclient likewise: `hex::encode(srp.get_a_pub())` (`wire.rs::connect`), and also as
   `p_data` of `op_cont_auth` when re-sending after a plugin switch.
3. Server data (from `p_acpt_data` or `op_cont_auth p_data`) is parsed as
   `[u16le saltLength][salt bytes (RAW, not hex; ≤64 bytes)][u16le keyLength][B as ASCII hex]`
   (`SrpClient.clientProof(user, password, authData)`; rsfbclient
   `wire.rs::parse_srp_auth_data` with the emphatic comment "* DO NOT PARSE AS HEXADECIMAL *"
   for the salt, and odd-length hex B gets a leading `'0'`).
4. `u = SHA1(pad(A) || pad(B))` — **always SHA-1**, where `pad()` truncates to the last 128
   bytes if longer (jaybird) / plain big-endian bytes (rsfbclient).
5. `x = SHA1(salt || SHA1(user ":" password))` — **always SHA-1**. Jaybird passes the
   *normalized login* (unquoted → upper-cased; `ClientAuthBlock.normalizeLogin`) as `user` here.
6. Session secret `S = (B − k·g^x)^(a + u·x) mod N` (jaybird computes
   `diff = (B − k·g^x) mod N`, `aux = a + u·x mod N`... exactly:
   `diff = serverPublicKey.subtract(kgx).mod(N); aux = privateKey.add(u.multiply(x).mod(N)).mod(N);
   S = diff.modPow(aux, N)`; rsfbclient guards `B % N != 0` against a malicious server).
7. **Session key `K = SHA1(S)` — always SHA-1, 20 bytes, for every Srp variant.** (rsfbclient
   comments "Firebird hashes this with SHA1 for some reason" in three places.)
8. Client proof:
   `M = H( (SHA1(N) ^ SHA1(g) mod N) || SHA1(user) || salt || A || B || K )`
   where `H` is the **variant hash** (see below) and — Firebird quirk — the standard SRP-6a
   `H(N) XOR H(g)` is replaced by **modular exponentiation**: jaybird computes
   `n1 = SHA1(N)`, `n2 = SHA1(g)`, first term = `n1.modPow(n2, N)`; rsfbclient:
   `hn.modpow(&hg, n)`. `SHA1(user)` has leading zero bytes stripped in jaybird
   (`stripLeadingZeroes`). All BigInteger→bytes conversions strip leading zeros.
9. `M` is sent **hex-encoded** as `p_data` of `op_cont_auth` (jaybird
   `SrpAuthenticationPlugin.authenticate`: `toHexString(clientProof(...))`; rsfbclient
   `client.rs::srp_auth`: `hex::encode(verifier.get_proof())`).
10. Server replies `op_response`; a successful (empty-error) response means authenticated. The
    server may send additional keys in `p_resp_data` (added via `addServerKeys`).

Variants — `wire/auth/srp/*Spi.java`, differ **only** in the proof hash `H`:

| Plugin name | Proof hash |
|---|---|
| `Srp` | SHA-1 |
| `Srp224` | SHA-224 |
| `Srp256` | SHA-256 (Firebird 3+ default) |
| `Srp384` | SHA-384 |
| `Srp512` | SHA-512 |

Everything else (u, x, k, K) stays SHA-1. Jaybird's default plugin list is `Srp256,Srp`
(`PropertyConstants.DEFAULT_AUTH_PLUGINS`); rsfbclient requests `Srp` first with
`plugin_list = "Srp,Srp256"` and switches when the server demands (`client.rs::connect` loop
re-sends `op_cont_auth` with A hex if the server picked another plugin —
"Server requested a different authentication method").

The multi-plugin continuation loop is `version13/V13WireOperations.authReceiveResponse`:
loop reading `op_trusted_auth (90)` (rejected), `op_cont_auth (92)` (data/pluginName/list/keys),
`op_crypt_key_callback (97)`, `op_cond_accept (98)`, `op_response` (done → then attempt wire
crypt). Each turn: `clientAuthBlock.setServerData(data); authenticate();` then send
`op_cont_auth` = `p_data` (client data, hex), `p_name` (current plugin), `p_list`
(plugin list, only the first time), `p_keys` (empty buffer).

rsfbclient test vectors (usable as unit-test fixtures) live in `srp.rs::test` (known seed, salt,
server key → expected A, x, proof, session key for both Srp/SHA-1 and Srp256).

### 2.2 Wire answer to the explicit questions

- **Is A sent hex-encoded in cnct data?** Yes — hex ASCII inside `CNCT_specific_data` clumplets
  (chunked 254 bytes + step byte in jaybird; rsfbclient identical chunking in `wire.rs`).
- **Is the proof sent hex?** Yes — hex ASCII as the `p_data` buffer of `op_cont_auth`.
- **Is B hex on the wire?** Yes (ASCII hex string, u16le length prefix inside the auth-data
  blob); **the salt is raw bytes** (not hex), though FB's server happens to generate
  64-byte salts that look hex-ish.
- **Client proof formula**: `H( pow(SHA1(N), SHA1(g)) mod N || SHA1(user) || salt || A || B || SHA1(S) )`.
- **Session key**: `K = SHA1(S)`, 20 bytes, independent of variant; used directly as the wire
  encryption key (§3).

---

## 3. Wire encryption (Arc4) and compression (zlib) — Jaybird

### 3.1 Placement in the stream stack

`gds/impl/wire/XdrOutputStream.java` / `XdrInputStream.java`:

- `enableCompression()` → `out = new FbDeflaterOutputStream(out)`
  (`DeflaterOutputStream` with **syncFlush=true**, i.e. `Z_SYNC_FLUSH` on every `flush()` — vital
  so request packets actually leave the machine); `enableDecompression()` →
  `in = new FbInflaterInputStream(in)`. Enabled immediately after the accept packet if
  `p_acpt_type & pflag_compress(0x100)` (`WireConnection.handleConnectAttachAccept`).
- `setCipher(Cipher)`: if the current stream is an `EncryptedStreamSupport`
  (i.e. the deflater/inflater wrapper), the cipher is pushed **inside** it — wrapping the raw
  socket stream. Result on the wire: `XDR → zlib-deflate → RC4 → socket`
  (compress-then-encrypt), matching Firebird.
- Both throw if a cipher is already set (double-encryption guard).

### 3.2 Negotiation

1. Client advertises `CNCT_client_crypt` level in op_connect (DISABLED/ENABLED/REQUIRED, wire
   value written as vax int; `WireCrypt.getWireProtocolCryptLevel()`).
2. Server's accept packet + auth responses carry `p_acpt_keys` / `p_resp_data` clumplets:
   `TAG_KEY_TYPE` ("Symmetric") → `TAG_KEY_PLUGINS` ("Arc4[,ChaCha[,ChaCha64]]") →
   optional `TAG_PLUGIN_SPECIFIC` ("<plugin>\0<data>") — collected into `KnownServerKey`
   (`WireConnection.addServerKeys`, `wire/crypt/KnownServerKey.java`).
3. After auth completes (`op_response` inside `authReceiveResponse`), if wireCrypt != DISABLED and
   auth produced a session key: `tryKnownServerKeys()` walks plugin-specific data in server
   order, looks up an `EncryptionPluginSpi` (registry), builds
   `CryptSessionConfig.symmetric(identifier, sessionKey, specificData)` — **encryptKey =
   decryptKey = the 20-byte SRP session key** (`wire/crypt/CryptSessionConfig.java` line ~55).
4. `enableEncryption` (`V13WireOperations`): under transmit lock send
   `op_crypt (96)` + `p_plugin` ("Arc4") + `p_key` ("Symmetric"), flush, then **set ciphers on
   both streams before reading** — the server's `op_response` confirming crypt is already
   encrypted. If it fails and wireCrypt==REQUIRED → `isc_wirecrypt_incompatible` error.

### 3.3 Key derivation

- **Arc4** (`wire/crypt/arc4/Arc4EncryptionPlugin.java`): RC4 keyed with the raw session key
  (SHA1(S), 20 bytes). Two independent RC4 states for send and receive (same key). No IV.
- **ChaCha** (FB4+, `wire/crypt/chacha/ChaChaEncryptionPlugin.java`): key =
  **SHA-256(session key)**; nonce/IV = plugin-specific data from server keys (12 bytes nonce, or
  16 bytes = 12 nonce + 4 counter big-endian). Cipher `ChaCha20`.

### 3.4 rsfbclient

`client.rs::srp_auth`: after the proof's `op_response`, unconditionally sends
`crypt("Arc4", "Symmetric")` (`wire.rs::crypt`), swaps `FbStream::Plain` for
`FbStream::Arc4(Arc4Stream::new(tcp, &verifier.get_key(), buf_len))` and only then reads the
response. `arc4.rs` is a self-contained RC4 (KSA + PRGA, XOR stream), separate states for
read/write. No compression support, no ChaCha.

---

## 4. Fetch strategy & statement reuse

### 4.1 Jaybird

- **Batch size**: JDBC layer default `FBFetcher.DEFAULT_FETCH_ROWS = 400`
  (`src/main/org/firebirdsql/jdbc/FBFetcher.java`); `setFetchSize` overrides; capped by
  `maxRows` remaining (`FBStatementFetcher.actualFetchSize`). One `op_fetch` requests
  `p_sqldata_messages = fetchSize` rows and the server streams that many
  `op_fetch_response` packets in one shot (each `status=0, count=1` + row bytes), terminated by
  `status=0,count=0` (end of batch) or `status=100` (`FETCH_NO_MORE_ROWS`, end of cursor) —
  `V10Statement.processFetchResponse` loops until a terminator.
- **Row BLR only once**: `sendFetchMsg` sends `p_sqldata_blr = calculateBlr(rowDescriptor)` on the
  first fetch, `null` (empty buffer) afterwards (`hasFetched()` check). Same for
  `op_fetch_scroll`.
- **Async fetch / read-ahead** (v11+): `FBStatementFetcher` observes the size of each completed
  batch; once a batch ≥15 rows arrives it sets a trigger point
  `asyncFetchOnRemaining = max(batchRows / 3, 10)`; when the local row queue drains to that
  count it issues `stmt.asyncFetchRows(fetchSize)` — the op_fetch goes out immediately, the
  response is picked up later via the deferred queue, overlapping server row production with
  client row consumption (`jdbc/FBStatementFetcher.java` lines 165–318,
  `wire/version11/V11Statement.java`).
- **Avoided round trips**: allocate+prepare single flush (v11, §1.4); statement info
  (`isc_info_sql_stmt_type` + full describe of select vars and bind vars) is requested *inside*
  `op_prepare_statement` (`p_sqlst_items` + `p_sqlst_buffer_length`), so prepare returns type +
  row metadata in one round trip — `V10Statement.sendPrepareMsg` with items from
  `ServerVersionInformation` (`gds/ng/ServerVersionInformation.java`: stmt_type, select
  describe_vars: sqlda_seq/type/sub_type/scale/length/field/alias/relation[/relation_alias]/owner,
  then bind describe_vars: numeric items only). Buffer sizes: v10 32 KB, v13+ 512 KiB default.
  `DSQL_close` piggybacked (never flushed alone). Cursor close+re-execute reuses the prepared
  statement (`StatementState` machine: PREPARED ⇄ CURSOR_OPEN, `reset(false)` keeps descriptors).
- **Truncation handling**: if the info response is truncated, jaybird re-requests with
  `isc_info_sql_sqlda_start + index` (same trick as rsfbclient below).

### 4.2 rsfbclient

- Upstream fetched **1 row per op_fetch**; this clone batches: `fetch_batch_size()` reads
  `FB_FETCH_BATCH` (default **200**) and `fetch_batch` issues one `op_fetch` for `count` rows,
  parsing every `op_fetch_response` greedily from an accumulation buffer, resuming on partial TCP
  reads (`client.rs::fetch_batch/parse_one_fetch_response`; distinguishes Row /
  BatchEnd(status=0,messages=0) / End(status=100)). Rows buffer in
  `StmtHandleData.prefetched: VecDeque<Vec<Column>>` and `cursor_eof` marks server exhaustion;
  `execute` clears both to reopen the cursor.
- Prepare: `op_allocate_statement` (lazy) + `op_prepare_statement` (stmt handle `u32::MAX`) in
  one flush; describe items `XSQLDA_DESCRIBE_VARS` (`xsqlda.rs`, 17 items) sent with the prepare;
  truncated describes continued via `op_info_sql` with
  `isc_info_sql_sqlda_start(2 bytes index)` prefix.

---

## 5. Row/message decoding, null bitmap, and BLR

### 5.1 Row encoding on the wire

- **v10–v12** (`V10Statement.readSqlData/writeSqlData`): for each column, the value (XDR-aligned)
  followed by a 4-byte null indicator int (`0` = not null, `-1` = null). Data is present (garbage/
  zeros) even for NULL values.
- **v13+** (`V13Statement.readSqlData/writeSqlData`): row starts with a **null bitmap** of
  `(fieldCount + 7) / 8` bytes, XDR-padded to a multiple of 4 (jaybird uses
  `readBuffer(len)`/`writePaddedBuffer` which pad; rsfbclient computes
  `len += 4 - (len % 4)` — `wire.rs::parse_sql_response`). Bit `i` (LSB-first within each byte:
  `null_map[i/8] >> (i%8) & 1`) set = column i is NULL. **NULL columns transmit no data at all.**
- Value alignment: everything is padded to 4 bytes. jaybird's
  `DefaultBlrCalculator.calculateIoLength` encodes the read strategy per type:
  - `0` → length-prefixed buffer (VARCHAR: 4-byte length + bytes + pad);
  - negative `-n` → read exactly `n` raw bytes, no padding (`SQL_SHORT/LONG/FLOAT/DATE/TIME` = −4;
    `DOUBLE/TIMESTAMP/BLOB/ARRAY/QUAD/INT64/DEC16/TIME_TZ` = −8; `TIMESTAMP_TZ/TIME_TZ_EX` = −12;
    `TIMESTAMP_TZ_EX/DEC34/INT128` = −16);
  - positive `n` → fixed `n−1` bytes plus pad-to-4 (`SQL_TEXT` = declaredLength+1, `SQL_BOOLEAN` =
    2 → 1 byte + 3 pad). CHAR pads with the charset's space byte (`fieldDescriptor.getPaddingByte()`).
  Note the −4/−8 items are still 4-aligned by construction. rsfbclient reads i64/f64/8-byte blob
  ids directly and manually skips 3 pad bytes after a boolean.
- Endianness: **all XDR values big-endian**, but *info-request/clumplet payloads are
  little-endian vax integers* (e.g. describe data, affected-row counts), and the BLR message
  length field is little-endian u16.

### 5.2 BLR message metadata (bind/output formats)

Both drivers build a tiny BLR program describing the message. Exact byte pattern
(jaybird `wire/DefaultBlrCalculator.java`; rsfbclient `blr.rs::params_to_blr` /
`xsqlda.rs::xsqlda_to_blr`):

```
blr_version5 (5)            ; dialect 3 (blr_version4 = 4 for dialect 1)
blr_begin    (2)
blr_message  (4)
0                            ; message number
lo(2*n) hi(2*n)              ; u16 LE: field count * 2 (each field + its null-indicator short)
  <field 1 type bytes>
  blr_short (7) 0            ; null indicator, scale 0  — after EVERY field
  ...
blr_end (255)
blr_eoc (76)
```

Per-type encodings (numeric codes from `org.firebirdsql.gds.BlrConstants`):

| SQL type | BLR bytes |
|---|---|
| VARCHAR | `blr_varying2 (38), subtype, 0, len_lo, len_hi` (jaybird; collation byte written as 0) — rsfbclient uses plain `blr_varying (37), len u16le` |
| CHAR | `blr_text2 (15), subtype, 0, len_lo, len_hi` (rsfbclient: `blr_text (14), len u16le`) |
| SQL_NULL | `blr_text (14), 0, 0` |
| SMALLINT | `blr_short (7), scale` |
| INTEGER | `blr_long (8), scale` |
| BIGINT | `blr_int64 (16), scale` |
| FLOAT | `blr_float (10)` |
| DOUBLE | `blr_double (27)` |
| D_FLOAT | `blr_d_float (11)` |
| DATE | `blr_sql_date (12)` |
| TIME | `blr_sql_time (13)` |
| TIMESTAMP | `blr_timestamp (35)` |
| BLOB (FB2.5+) | `blr_blob2 (17), subtype_lo, subtype_hi, charsetId_lo, 0` (jaybird uses field scale as charset id low byte) |
| BLOB (FB≤2.1) / ARRAY / QUAD | `blr_quad (9), scale` (rsfbclient always uses QUAD for blobs) |
| BOOLEAN | `blr_bool (23)` |
| DECFLOAT(16) | `blr_dec64 (24)` |
| DECFLOAT(34) | `blr_dec128 (25)` |
| INT128 | `blr_int128 (26), scale` |
| TIME WITH TZ | `blr_sql_time_tz (28)` |
| TIMESTAMP WITH TZ | `blr_timestamp_tz (29)` |
| TIME WITH TZ (extended) | `blr_ex_time_tz (30)` |
| TIMESTAMP WITH TZ (extended) | `blr_ex_timestamp_tz (31)` |

Scale is written as a signed byte (negative for NUMERIC/DECIMAL). Length for text types is the
u16 LE byte length. For **parameters**, jaybird has a second overload
`calculateBlr(rowDescriptor, rowValue)` that substitutes each field's **actual data length** for
text/varying (so the blr matches the bytes being sent); `writeSqlData(..., useActualLength=true)`
mirrors this on the value side.

rsfbclient parameter mapping (`blr.rs`): Text → `blr_text` (unless >32767 bytes → creates a blob
via `op_create_blob`/`op_put_segment`/`op_close_blob` and sends `blr_quad` + 8-byte id);
Integer → `blr_int64`; Floating → `blr_double`; Timestamp → `blr_timestamp`
(4-byte date + 4-byte time); Boolean → `blr_bool` with 4 bytes `01 00 00 00`; Null → zero-length
`blr_text`. Null bitmap prepended to values for v13 (`null_bitmap()` writes u32 LE words per 32
params — note it uses LE u32 chunks so the byte order matches the per-byte LSB convention).
rsfbclient also **coerces** output columns before building the fetch BLR
(`xsqlda.rs::XSqlVar::coerce`): every int→INT64 (scale≠0 → DOUBLE), float→DOUBLE,
date/time/timestamp→TIMESTAMP, text→VARYING — asking the *server* to convert. Jaybird does NOT
coerce; it decodes each native type (more code, no server-side conversion, preserves NUMERIC
exactness). For a TS driver, jaybird's approach is the better model (rsfbclient's DOUBLE coercion
loses NUMERIC precision).

Batch message length (`calculateBatchMessageLength`): fields packed with C alignment
(text/boolean 1, short 2, varying 2 (+2 len bytes), long/float/date/time/timestamp/tz/blob 4,
double/int64/dec/int128 8), each followed by a 2-aligned 2-byte null indicator — mirrors
`src/remote/client/BlrFromMessage.cpp` in Firebird.

### 5.3 Statement describe (both)

Info items answered LE inside the buffer:
`isc_info_sql_stmt_type (21)` → 4-byte type; `isc_info_sql_select (4)` / `isc_info_sql_bind (5)`
sections, each `isc_info_sql_describe_vars (7)` → count, then per column
`isc_info_sql_sqlda_seq (8)`, `type (11)`, `sub_type (12)`, `scale (13)`, `length (14)`,
`null_ind (15)`? (rsfbclient requests it), `field (9)`, `relation (16)`, `owner (18)`,
`alias (10)`, `describe_end (19)`; `isc_info_truncated (0x40/64)` → re-request from
`isc_info_sql_sqlda_start (20)` + u16 index. SQL type codes (jaybird
`gds/ISCConstants.java`): TEXT 452, VARYING 448, SHORT 500, LONG 496, FLOAT 482, DOUBLE 480,
D_FLOAT 530, TIMESTAMP 510, BLOB 520, ARRAY 540, QUAD 550, TIME 560, DATE 570, INT64 580,
TIMESTAMP_TZ_EX 32748, TIME_TZ_EX 32750, INT128 32752, TIMESTAMP_TZ 32754, TIME_TZ 32756,
DEC16 32760, DEC34 32762, BOOLEAN 32764, NULL 32766 (odd = nullable; mask with `& ~1`).

---

## 6. Statement execute flow

Jaybird `V10Statement.execute(RowValue)`:

1. Decide operation: `hasSingletonResult()` (= statement type has singleton result **and** has
   output fields — `AbstractFbStatement.hasSingletonResult`) → **`op_execute2` (76)**, else
   **`op_execute` (63)**. Statement type comes from prepare info
   (`isc_info_sql_stmt_select=1 … exec_procedure=8`). **EXECUTE PROCEDURE and DML…RETURNING are
   reported by the server as exec_procedure**, hence take the op_execute2 path and yield exactly
   one row via `op_sql_response`; plain SELECT keeps a cursor and rows come via op_fetch.
2. Message (struct `p_sqldata`): `statementHandle, transactionHandle, p_sqldata_blr (param blr or
   empty), p_sqldata_message_number=0, p_sqldata_messages (1 if params else 0), [param row data]`;
   for op_execute2 additionally `p_sqldata_out_blr (output blr), p_sqldata_out_message_number=0`.
   v16 appends `p_sqldata_timeout` (u32 ms); v18 appends `p_sqldata_cursor_flags`.
3. Responses: for op_execute2 first `op_sql_response` (`count>0` → read one row with
   `readSqlData()`, then `setAfterLast()`), then always a final `GenericResponse`. v19 can
   interleave `op_inline_blob` responses before either. Response counting +
   `consumePackets` keeps the stream consistent on error/cancel.
4. State: SELECT-ish types → `CURSOR_OPEN`, others → back to `PREPARED`.
5. **Affected rows**: not part of execute; fetched on demand via `op_info_sql (70)` with item
   `isc_info_sql_records (23)`; response: `23, u16le len, { isc_info_req_select_count=13 |
   insert=14 | update=15 | delete=16, u16le 4, u32le count }*, isc_info_end (1)`
   (`gds/ng/SqlCountProcessor.java`). rsfbclient does the same right after every `execute`
   (`client.rs::execute` → `parse_info_sql_affected_rows` in `wire.rs`, summing
   insert+update+delete and ignoring select count).

rsfbclient splits the API: `execute()` uses op_execute (+affected rows query), `execute2()` uses
op_execute2 and parses `op_sql_response` (`SqlResponse` = row data w/o status) followed by
`op_response` — used for `RETURNING` support at the higher `Queryable` level.

`op_exec_immediate (64)` (jaybird uses it for DDL-ish `executeImmediate`; rsfbclient
`exec_immediate`): `tr_handle, stmt_handle=0, dialect, sql, blr?/items, buffer_length` — executes
without a prepared statement.

Cursor name: `op_set_cursor (69)` with **null-terminated** cursor name string quirk
(`V10Statement.sendSetCursorMsg` appends `'\0'`).

---

## 7. Events (aux connection)

Jaybird only (rsfbclient has none):

- Request: `op_connect_request (53)` with `p_req_type = P_REQ_async (1)`, object+partner = 0
  (`version10/V10Database.initAsynchronousChannel`). The `GenericResponse.data` holds a raw
  `sockaddr_in`; only **bytes 2–3 (big-endian port)** are trusted — the IP is ignored ("invalid in
  FB3 and higher; always use original hostname").
- A second plain socket connects to the same host at that port
  (`version10/V10AsynchronousChannel.connect`, NIO non-blocking `SocketChannel`). No handshake on
  the aux socket; it only ever *receives*.
- Registering interest: on the **main** connection, `op_que_events (48)`:
  `p_event_database=0, p_event_items = EPB buffer, p_event_ast+arg = 8 zero bytes,
  p_event_rid = client-generated local id`. EPB (`wire/WireEventHandle.toByteArray`):
  `EPB_version1 (1), nameLength u8, name bytes, u32 vax-LE current count`. Response is a normal
  op_response. Cancel: `op_cancel_events (49)` with the local id.
- Aux socket traffic (`V10AsynchronousChannel.processBuffer`): packets `op_event (52)`:
  `db handle (4), event buffer length (4) + buffer + XDR pad, AST info (8), event id (4)`;
  the new count is the trailing 4 vax bytes of the buffer. Also `op_dummy`, and
  `op_exit`/`op_disconnect` close the channel. Partial reads are handled by
  mark/reset on a 2048-byte `ByteBuffer`.
- One global daemon thread multiplexes all aux channels with a `Selector`
  (`wire/AsynchronousProcessor.java`). Each event delivery is one-shot: the handler re-queues
  (`op_que_events` again with updated counts) to keep listening.

---

## 8. Service manager protocol (brief)

`version10/V10Service.java` (+ `AbstractFbWireService`):

- `op_service_attach (82)`: `p_operation, objectId=0, service name string ("service_mgr" or
  host/service), SPB buffer`. Auth/crypt identical to database attach (same
  `WireOperations.authReceiveResponse` path, `WireServiceConnection` variant of the handshake).
  v13+ uses SPB version 2 with UTF-8 strings (`Version13Descriptor.createServiceParameterBuffer`).
- `op_service_info (84)`: `handle, incarnation=0(?), spb?, request items buffer, buffer length` —
  used right after attach to describe the server (`afterAttachActions` queries with a
  1024-byte buffer).
- `op_service_start (85)`: `handle, 0, service request buffer (SRB)` — backup/restore/user
  management etc.
- `op_service_detach (83)`: handle; response consumed.

rsfbclient does not implement services.

---

## 9. FB4/FB5-specific support (jaybird)

- **INT128**: BLR 26 + scale, 16 bytes big-endian two's complement (io length −16). Used for
  NUMERIC(38).
- **DECFLOAT**: `blr_dec64 (24)` 8 bytes / `blr_dec128 (25)` 16 bytes, IEEE 754-2008 decimal
  encodings (decode in `org.firebirdsql.extern.decimal`).
- **Time zones**: `TIME/TIMESTAMP WITH TIME ZONE` = base value in **UTC** + `u16` Firebird zone
  id (+`i16` offset-in-minutes in the `EX` variants). Decode
  (`gds/ng/tz/TimeZoneDatatypeCoder.java`, `TimeZoneMapping.java`): id read as unsigned short;
  `id ∈ [0, 2878]` is an **offset zone**: `offsetMinutes = id − 1439` (`OFFSET_CORRECTION=1439`,
  range ±23:59); `id > 2878` is a **named zone**: index into the bundled zone-name table via
  `0xFFFF − id` (mirrors `RDB$TIME_ZONE_ID`; table generated from Firebird's ICU list). Values
  are converted to `OffsetDateTime` by applying the named zone's rules to the UTC base.
  On encode jaybird always writes an offset-encoded id (UTC → 1439).
- **Statement timeout**: v16 execute message trailer (u32 ms).
- **Batch API** (v16+, `version16/V16Statement.java`): `op_batch_create (99)` (stmt handle, blr of
  param message, message length from `calculateBatchMessageLength`, batch parameter buffer with
  version tag), `op_batch_msg (100)` (stmt handle, row count, then rows encoded like v13 sql data
  padded to 4), `op_batch_regblob (104)` (register existing blob ids), `op_batch_exec (101)`
  (stmt+transaction), response `op_batch_cs (103)` = `p_batch_statement, p_batch_reccount,
  p_batch_updates, p_batch_vectors, p_batch_errors` then update counts, (element, status-vector)
  pairs, and error-element indices (`V16WireOperations.readBatchCompletionResponse`);
  `op_batch_rls (102)` / `op_batch_cancel (109)`. Create/send/regblob/release are all
  **deferred**; sync is forced with `op_ping (93)` (v16/17) or `op_batch_sync (110)` (v18+),
  and automatically when 64 deferred actions accumulate.
- **Scrollable cursors** (v18): `op_fetch_scroll (112)` = fetch msg + `p_sqldata_fetch_op`
  (FetchType: NEXT/PRIOR/FIRST/LAST/ABSOLUTE/RELATIVE) + `p_sqldata_fetch_pos`;
  cursor must be opened with `CURSOR_TYPE_SCROLLABLE` flag in `p_sqldata_cursor_flags`;
  `op_info_cursor (113)` for cursor size/position info (`jdbc/FBServerScrollFetcher`).
- **Inline blobs** (v19): server pushes `op_inline_blob (114)` packets (transaction handle, blob
  id, blob info clumplets incl. `isc_info_blob_total_length`, then segmented data buffer) ahead of
  `op_sql_response`/`op_fetch_response` rows; client caches them per (transaction, blobId) in
  `wire/InlineBlobCache.java` so `openBlob` never hits the wire for small blobs. Negotiated with
  DPB `isc_dpb_max_inline_blob_size = 104` (and `isc_dpb_max_blob_cache_size`); handled inside
  `V10Statement.execute/processFetchResponse` loops (`response instanceof InlineBlobResponse`).

rsfbclient supports none of these (stops at protocol 13 / FB3 types; no int128/decfloat/tz).

---

## 10. Error / status-vector parsing

- Jaybird (`wire/AbstractWireOperations.readStatusVector`): loop reading XDR ints:
  `isc_arg_gds (1)` → error code (0 ignored) starts a new chained exception;
  `isc_arg_warning (18)` → warning code; `isc_arg_string (2)` / `isc_arg_interpreted (5)` →
  message parameter string; `isc_arg_sql_state (19)` → SQLSTATE; `isc_arg_number (4)` and any
  other tag → integer message parameter; `isc_arg_end (0)` terminates. Accumulated in
  `FbExceptionBuilder`, which formats messages from a bundled error-code→template table
  (parameters substituted into `@1 @2 …` slots), computes SQLSTATE/SQLcode, and picks the
  exception class (warning vs transient vs non-transient) — `readStatusVector` returns
  `null` for an empty vector, so a `GenericResponse` carries `exception == null | SQLWarning |
  SQLException`; warnings are routed to a `WarningMessageCallback` instead of thrown
  (`processResponseWarnings`/`processResponse`).
- rsfbclient (`wire.rs::parse_status_vector`): same tags (`isc_arg_gds`, `isc_arg_number` —
  captures SQL code when gds_code==335544436, `isc_arg_string`, `isc_arg_interpreted`,
  `isc_arg_sql_state` skipped, `isc_arg_end`), messages formatted by replacing `@n` from a
  generated `gds_to_msg` table in `consts.rs`; produces `FbError::Sql { code, msg }`. Unknown
  tags are a hard error (jaybird treats them as int params — more forgiving, better choice).
- Both parse the vector **inside** the op_response reader so the error is attached to the
  response object rather than thrown mid-stream (jaybird) / returned as Err (rsfbclient).

---

## Appendix A — Wire operation codes (from `WireProtocolConstants.java`)

```
op_void 0, op_connect 1, op_exit 2, op_accept 3, op_reject 4, op_disconnect 6, op_response 9,
op_attach 19, op_create 20, op_detach 21, op_transaction 29, op_commit 30, op_rollback 31,
op_create_blob 34, op_open_blob 35, op_get_segment 36, op_put_segment 37, op_cancel_blob 38,
op_close_blob 39, op_info_database 40, op_info_blob 43, op_que_events 48, op_cancel_events 49,
op_commit_retaining 50, op_event 52, op_connect_request 53, op_open_blob2 56, op_create_blob2 57,
op_allocate_statement 62, op_execute 63, op_exec_immediate 64, op_fetch 65, op_fetch_response 66,
op_free_statement 67, op_prepare_statement 68, op_set_cursor 69, op_info_sql 70, op_dummy 71,
op_execute2 76, op_sql_response 78, op_drop_database 81, op_service_attach 82,
op_service_detach 83, op_service_info 84, op_service_start 85, op_rollback_retaining 86,
op_partial 89, op_trusted_auth 90, op_cancel 91, op_cont_auth 92, op_ping 93, op_accept_data 94,
op_abort_aux_connection 95, op_crypt 96, op_crypt_key_callback 97, op_cond_accept 98,
op_batch_create 99, op_batch_msg 100, op_batch_exec 101, op_batch_rls 102, op_batch_cs 103,
op_batch_regblob 104, op_batch_blob_stream 105, op_batch_set_bpb 106, op_batch_cancel 109,
op_batch_sync 110, op_info_batch 111, op_fetch_scroll 112, op_info_cursor 113, op_inline_blob 114
```

`FETCH_OK = 0`, `FETCH_NO_MORE_ROWS = 100` (fetch status); free-statement options
`DSQL_close = 1`, `DSQL_drop = 2`, `DSQL_unprepare = 4`.

## Appendix B — Key file index

| Topic | File |
|---|---|
| Protocol plugin factory | `jaybird/src/main/org/firebirdsql/gds/ng/wire/ProtocolDescriptor.java`, `ProtocolCollection.java`, `AbstractProtocolDescriptor.java` |
| Handshake / CNCT / server keys | `.../wire/WireConnection.java`, `.../wire/auth/ClientAuthBlock.java` |
| Deferred actions | `.../wire/DeferredAction.java`, `.../wire/version11/V11WireOperations.java`, `version16/V16WireOperations.java` |
| Statement send/receive | `.../wire/version10/V10Statement.java`, `version11/V11Statement.java`, `version13/V13Statement.java`, `version16/V16Statement.java`, `version18/V18Statement.java` |
| BLR | `.../wire/DefaultBlrCalculator.java`, `org/firebirdsql/gds/BlrConstants.java`; rsfbclient `rsfbclient-rust/src/blr.rs`, `xsqlda.rs` |
| SRP | `.../wire/auth/srp/SrpClient.java` (+ `*Spi.java`); rsfbclient `rsfbclient-rust/src/srp.rs` |
| Crypt/compression | `.../wire/version13/V13WireOperations.java`, `.../wire/crypt/arc4/Arc4EncryptionPlugin.java`, `crypt/chacha/ChaChaEncryptionPlugin.java`, `org/firebirdsql/gds/impl/wire/Xdr{Input,Output}Stream.java`, `FbDeflaterOutputStream.java`; rsfbclient `arc4.rs`, `client.rs::srp_auth` |
| Fetch strategy | `jaybird/src/main/org/firebirdsql/jdbc/FBFetcher.java` (DEFAULT_FETCH_ROWS=400), `FBStatementFetcher.java` (async fetch heuristic); rsfbclient `client.rs` (FB_FETCH_BATCH=200, local mod) |
| Events | `.../wire/version10/V10AsynchronousChannel.java`, `.../wire/AsynchronousProcessor.java`, `.../wire/WireEventHandle.java`, `V10Database.initAsynchronousChannel` |
| Services | `.../wire/version10/V10Service.java` |
| Time zones | `jaybird/src/main/org/firebirdsql/gds/ng/tz/TimeZoneDatatypeCoder.java`, `TimeZoneMapping.java` |
| Inline blobs (FB5) | `.../wire/version19/V19WireOperations.java`, `.../wire/InlineBlobCache.java`, `InlineBlob.java` |
| Status vector | `.../wire/AbstractWireOperations.java` (readStatusVector); rsfbclient `wire.rs::parse_status_vector` |
