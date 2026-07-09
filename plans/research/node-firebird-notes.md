# node-firebird / node-firebird2 — Wire-Protocol Research Notes

Reference document for the clean-room TypeScript reimplementation. All constants,
buffer layouts and quirks below were extracted directly from:

- **`references/node-firebird`** — `node-firebird` v2.3.4 (hgourvest lineage, heavily
  modernized fork: SRP, wire crypt, protocols 10–19(+20 constants), events, FB6 schema
  support). Wire code lives under `lib/wire/` (`connection.js`, `const.js`,
  `serialize.js`, `xsqlvar.js`, `socket.js`, `eventConnection.js`, `fbEventManager.js`,
  `database.js`, `statement.js`, `transaction.js`, `service.js`) plus `lib/srp.js`,
  `lib/unix-crypt.js`, `lib/messages.js`, `lib/utils.js`, `lib/ieee754-decimal.js`.
- **`references/node-firebird2`** — `node-firebird2` v1.3.13 (mreis1 fork of the classic
  0.9.x codebase). Single-file implementation `lib/index.js` (5684 lines) +
  `lib/serialize.js`, `lib/messages.js`. **Protocol 10 / Legacy auth only** (plaintext
  password in DPB). Adds: `Isolation` class, `transcodeAdapter` for CHARSET NONE,
  POST_EVENT support, promise wrapper (`Fb2` / `exports.promises`).

Throughout: “NF” = node-firebird (modern), “NF2” = node-firebird2 (legacy proto 10).

---

## 1. Complete opcode table

Defined in NF `lib/wire/const.js:28-127` and NF2 `lib/index.js:126-219`. Identical
values; NF adds the FB5/FB6 tail (112–114).

| Opcode | Value | | Opcode | Value |
|---|---|---|---|---|
| op_void | 0 | | op_allocate_statement | 62 |
| op_connect | 1 | | op_execute | 63 |
| op_exit | 2 | | op_exec_immediate | 64 |
| op_accept | 3 | | op_fetch | 65 |
| op_reject | 4 | | op_fetch_response | 66 |
| op_disconnect | 6 | | op_free_statement | 67 |
| op_response | 9 | | op_prepare_statement | 68 |
| op_attach | 19 | | op_set_cursor | 69 |
| op_create | 20 | | op_info_sql | 70 |
| op_detach | 21 | | op_dummy | 71 |
| op_compile | 22 | | op_response_piggyback | 72 |
| op_start | 23 | | op_start_and_receive | 73 |
| op_start_and_send | 24 | | op_start_send_and_receive | 74 |
| op_send | 25 | | op_exec_immediate2 | 75 |
| op_receive | 26 | | op_execute2 | 76 |
| op_unwind | 27 | | op_insert | 77 |
| op_release | 28 | | op_sql_response | 78 |
| op_transaction | 29 | | op_transact | 79 |
| op_commit | 30 | | op_transact_response | 80 |
| op_rollback | 31 | | op_drop_database | 81 |
| op_prepare | 32 | | op_service_attach | 82 |
| op_reconnect | 33 | | op_service_detach | 83 |
| op_create_blob | 34 | | op_service_info | 84 |
| op_open_blob | 35 | | op_service_start | 85 |
| op_get_segment | 36 | | op_rollback_retaining | 86 |
| op_put_segment | 37 | | op_partial | 89 |
| op_cancel_blob | 38 | | op_trusted_auth | 90 |
| op_close_blob | 39 | | op_cancel | 91 |
| op_info_database | 40 | | op_cont_auth | 92 |
| op_info_request | 41 | | op_ping | 93 |
| op_info_transaction | 42 | | op_accept_data | 94 |
| op_info_blob | 43 | | op_abort_aux_connection | 95 |
| op_batch_segments | 44 | | op_crypt | 96 |
| op_que_events | 48 | | op_crypt_key_callback | 97 |
| op_cancel_events | 49 | | op_cond_accept | 98 |
| op_commit_retaining | 50 | | op_fetch_scroll (NF only) | 112 |
| op_prepare2 | 51 | | op_info_cursor (NF only) | 113 |
| op_event | 52 | | op_inline_blob (NF only) | 114 |
| op_connect_request | 53 | | | |
| op_aux_connect | 54 | | | |
| op_ddl | 55 | | | |
| op_open_blob2 | 56 | | | |
| op_create_blob2 | 57 | | | |
| op_get_slice | 58 | | | |
| op_put_slice | 59 | | | |
| op_slice | 60 | | | |
| op_seek_blob | 61 | | | |

Note: **neither driver ever sends op_open_blob2 (56), op_put_segment (37) or
op_seek_blob (61)** — they use op_open_blob (35), op_batch_segments (44),
op_create_blob2 (57), op_get_segment (36), op_close_blob (39).

`op_free_statement` sub-codes (`const.js:129-133`): `DSQL_close = 1`, `DSQL_drop = 2`,
`DSQL_unprepare = 4` (FB ≥ 2.5, unused by both drivers).

`op_fetch_scroll` directions (`const.js:135-142`): fetch_next=0, fetch_prior=1,
fetch_first=2, fetch_last=3, fetch_absolute=4, fetch_relative=5.

---

## 2. XDR / BLR serialization primitives

NF `lib/wire/serialize.js`; NF2 `lib/serialize.js` (nearly identical, NF2 uses `long`
package for int64 and lacks Int128/DecFloat/BitSet/`addAlignment`).

### XDR (big-endian, 4-byte aligned)
- `align(n) = (n + 3) & ~3` (`serialize.js:4-6`).
- `addInt` = Int32BE; `addUInt` = UInt32BE; `addInt64` = BigInt64BE (8 bytes);
  `addInt128` = two UInt64BE words, high then low (16 bytes); `addDouble` = DoubleBE;
  `addQuad` = Int32BE high, then Int32BE low.
- `addString(s, enc)`: Int32BE byteLength, then bytes, then **zero padding** to align(len)
  (`serialize.js:327-336`).
- `addText(s, enc)`: bytes + zero padding, **no length prefix** — used for `SQL_TEXT`
  (CHAR) params.
- `addBlr(blrWriter)`: Int32BE length (`blr.pos`), raw BLR bytes, zero padding to align.
- `addAlignment(len)` (NF only, `serialize.js:382-388`): appends `(4 - len) & 3` bytes of
  **0xFF** (not 0x00!) — used to pad the protocol-13 null bitmap.
- Reader mirrors: `readArray()` = Int32BE length + slice + skip align(len) (returns
  `undefined` if len==0); `readBuffer(len, toAlign=true)`; `readString`/`readText` skip
  align(len). NF2's `readBuffer(len)` **always aligns**.

### BLR / parameter-block writer (little-endian where multi-byte)
- `addByte`, `addShort` (Int8!), `addWord` (UInt16LE), `addInt32` (UInt32LE),
  `addSmall` (Int16LE, NF2 only for `addBuffer`).
- `addNumeric(tag, v)` (`serialize.js:75-94`): if v < 256 → `[tag, 1, v]`; else
  `[tag, 4, Int32**BE**(v)]`. (Big-endian for the 4-byte form — a long-standing
  node-firebird quirk; Firebird tolerates it for DPB values it reads as VAX? Note:
  `BlrWriter.addByteInt32` uses UInt32LE. Careful — copy behavior exactly or use LE
  consistently and test.)
- `addString(tag, s, enc)`: `[tag, len(1 byte), bytes…]`, max 255, throws
  `'blr string is too big'` above.
- `addString2(tag, s, enc)`: `[tag, len(UInt16LE), bytes…]` (max 65025) — for
  isc_spb v2 blocks.
- `addMultiblockPart(tag, s, enc)` (NF `serialize.js:139-158`): splits data into
  254-byte chunks, each emitted as `[tag, chunkLen+1, stepNumber, …chunk…]` —
  used for `CNCT_specific_data` because a single CNCT tag payload is limited to 255
  bytes and the SRP public key hex is 256 chars.
- `addBuffer(b)`: UInt16LE length + bytes — blob segment framing.
- `BlrReader.readInt()`: UInt16LE cluster length (1/2/4) then Int8/Int16LE/Int32LE
  value — this is the parser for info-response clumplets.
- `BlrReader.readString()`: UInt16LE len + bytes.
- `BlrReader.readSegment()` (`serialize.js:214-242`): loops `{UInt16LE len, bytes}`
  until buffer end — concatenates multiple blob segments inside one op_get_segment
  response buffer.

### BitSet (NF only, `serialize.js:530-585`)
Used for the protocol ≥ 13 null bitmap.
- Constructor from Buffer: unpacks into **32-bit word array** (`k >>> 5`).
- `set(index, value)`: packs into **byte array** (`index >>> 3`, `1 << (index % 8)`).
- `get(index)`: reads from the 32-bit word layout (`index >>> 5`, JS `>>>` shifts mod 32).
- `toBuffer()` = `Buffer.from(this.data)` (valid only for the byte-packed write path).
- **Pitfall:** write path (set/toBuffer) and read path (constructor/get) use different
  internal layouts; they are only used disjointly (encode params vs decode rows). Do
  not mix. In a reimplementation use one LSB-first byte layout for both: bit i of the
  bitmap = `buf[i >> 3] & (1 << (i & 7))`, 1 = NULL.

---

## 3. Connect handshake (op_connect)

### 3.1 NF modern client — `lib/wire/connection.js:331-472`

Message layout (all XDR Int32BE unless noted):

```
op_connect (1)
op_attach  (19)                  // "operation to follow"
CONNECT_VERSION3 (3)             // const.js:164 (CONNECT_VERSION2 = 2 also defined)
ARCHITECTURE_GENERIC (1)
<string: database path>          // options.database || options.filename
<int: count of protocol versions offered>   // up to 10
<array: user identification BLR>  // CNCT clumplets, see below
per protocol (5 ints each):
    version, architecture, min_type, max_type, weight
```

CNCT tag values (`const.js:463-478`):

| Tag | Value |
|---|---|
| CNCT_user | 1 |
| CNCT_passwd | 2 |
| CNCT_host | 4 |
| CNCT_group | 5 |
| CNCT_user_verification | 6 |
| CNCT_specific_data | 7 |
| CNCT_plugin_name | 8 |
| CNCT_login | 9 |
| CNCT_plugin_list | 10 |
| CNCT_client_crypt | 11 |

Client crypt levels: WIRE_CRYPT_DISABLED=0, WIRE_CRYPT_ENABLED=1, WIRE_CRYPT_REQUIRED=2.

CNCT clumplet order actually written (`connection.js:342-365`):
1. `CNCT_login(9)` = user name (as typed, not uppercased)
2. `CNCT_plugin_name(8)` = chosen plugin (default first of AUTH_PLUGIN_LIST)
3. `CNCT_plugin_list(10)` = `'Srp512,Srp384,Srp256,Srp,Legacy_Auth'` (comma-joined,
   `const.js:255-261`)
4. `CNCT_specific_data(7)` via `addMultiblockPart`:
   - SRP plugins: client public key **A as lowercase ASCII hex** (`BigInt.toString(16)`,
     no padding) — 256 hex chars for a 1024-bit key → 2 multiblock chunks.
   - Legacy_Auth: `crypt(password, '9z').substring(2)` (DES-crypt, salt `'9z'`
     = `Const.LEGACY_AUTH_SALT`, drop the 2 salt chars).
5. `CNCT_client_crypt(11)` = raw bytes `[11, 4, wireCryptLevel, 0, 0, 0]` (4-byte
   little-endian int; default value `WIRE_CRYPT_ENABLE = 1`).
6. `CNCT_user(1)` = OS user name (`os.userInfo().username`)
7. `CNCT_host(4)` = `os.hostname()`
8. `CNCT_user_verification(6)` = zero-length: bytes `[6, 0]`

Protocols offered — `SUPPORTED_PROTOCOL` (`const.js:233-244`), each
`[version, arch, minType, maxType, weight]`:

```
[0x000A (10),          1, ptype_rpc(2),       ptype_batch_send(3), 1]
[0x800B (32779, v11),  1, ptype_lazy_send(5), ptype_lazy_send(5),  2]
[0x800C (v12),         1, 5, 5, 3]
[0x800D (v13),         1, 5, 5, 4]
[0x800E (v14),         1, 5, 5, 5]
[0x800F (v15),         1, 5, 5, 6]
[0x8010 (v16),         1, 5, 5, 7]
[0x8011 (v17),         1, 5, 5, 8]
[0x8012 (v18),         1, 5, 5, 9]
[0x8013 (v19),         1, 5, 5, 10]
```

`FB_PROTOCOL_FLAG = 0x8000`; versions ≥ 11 are OR-ed with it (`const.js:171-221`).
Protocol 20 (0x8014) constants exist but v20 is not in the offered list.
`ptype_rpc = 2`, `ptype_batch_send = 3`, `ptype_out_of_band = 4`, `ptype_lazy_send = 5`,
`ptype_mask = 0xFF`, `pflag_compress = 0x100` (`const.js:224-231`). If
`options.wireCompression` and version ≥ 13, max_type is OR-ed with `pflag_compress`
(`connection.js:385-389`). `options.maxNegotiatedProtocols` (default 10) slices the
tail of the list (keeps the newest N).

### 3.2 NF2 legacy client — `lib/index.js:3954-3982`

```
op_connect(1), op_attach(19), CONNECT_VERSION2(2), ARCHITECTURE_GENERIC(1),
<db path string>, 1 /* protocol count */,
<BLR: [1(CNCT_user), len, $USER] [4(CNCT_host), len, hostname] [6, 0]>,
PROTOCOL_VERSION10(10), ARCHITECTURE_GENERIC(1), 2 /*min*/, 3 /*max*/, 2 /*weight*/
```

op_accept check (`index.js:3921-3924`): must be exactly `(10, 1, 3)` else
`'Invalid connect result'`.

### 3.3 op_accept / op_accept_data / op_cond_accept (NF `connection.js:2040-2184`)

```
op_accept(3):        version:int32, architecture:int32, type:int32
op_accept_data(94) / op_cond_accept(98): the same 3 ints, then:
    data:      array (readArray → salt+key buffer, may be empty)
    pluginName: string
    is_authenticated: int32   (1 = server already authenticated us)
    keys:      string         (comma list of wire-crypt plugin names, e.g. 'ChaCha64,ChaCha,Arc4')
```

- `compress = (type & pflag_compress) != 0`; `type &= ptype_mask` (0xFF).
- Negative version → `(version & FB_PROTOCOL_MASK) | FB_PROTOCOL_FLAG`
  (`FB_PROTOCOL_MASK = ~0x8000 & 0xFFFF`) — the server sends v13 as 0x800D which
  reads as a negative int32? no — as 32-bit it's positive; the mask handles servers
  that return the version sign-extended.
- `protocolMinimumType === ptype_lazy_send(5)` is later used as “V11+, can pipeline”.
- On `op_cond_accept` with computed authData: client sends `op_cont_auth` and waits
  for `op_response` on the same queue slot (`connection.js:2170-2182`).
- On `op_accept_data` with empty data array: client sends `op_cont_auth` carrying its
  public key again and waits for the server's `op_cont_auth` with salt+key
  (`connection.js:2089-2097`).
- `compress==true` → `socket.enableCompression()` — zlib deflate with
  `Z_FULL_FLUSH` / inflate (`socket.js:186-203`).

### 3.4 op_cont_auth

Send (`connection.js:273-285`):
```
op_cont_auth(92)
<string: auth data>            // hex text (SRP proof or pubkey) or legacy hash
<string: plugin name>
<string: plugin list>          // 'Srp512,Srp384,Srp256,Srp,Legacy_Auth'
<int32: 0>                     // keys (empty array)
```
Receive (`connection.js:2185-2319`): `data:array, pluginName:string, plist:string,
pkey:string`. Handles: (a) server switching SRP flavor, (b) SRP salt/key delivery when
op_accept_data had no data, (c) server M2 proof (ignored — just wait for op_response),
(d) FB4/5 chained `Legacy_Auth` re-auth after SRP (responds with DES-crypt hash),
(e) fallback to Legacy_Auth when server rejects SRP.

---

## 4. SRP authentication (NF only)

Files: `lib/srp.js` (math), `lib/wire/connection.js` (protocol glue),
`lib/unix-crypt.js` (legacy DES crypt), `SRP_PROTOCOL.md` (docs).

### 4.1 Group constants (`srp.js:3-19`)
```
SRP_KEY_SIZE  = 128 bytes (1024-bit)
SRP_SALT_SIZE = 32
N (prime, hex) = E67D2E994B2F900C3F41F08F5BB2627ED0D49EE1FE767A52EFCD565CD6E76881
                 2C3E1E9CE8F0A8BEA6CB13CD29DDEBF7A96D4A93B55D488DF099A15C89DCB064
                 0738EB2CBDD9A8F7BAB561AB1B0DC1C6CDABF303264A08D1BCA932D1F1EE428B
                 619D970F342ABA9A65793B8B2F041AE5364350C16F735F56ECBCA87BD57B29E7
g = 2
k = 1277432915985975349439481660349303019122249719989 (decimal)
    (= SHA1(pad(N) || pad(g)) as BigInt; recomputed per hash via getK, srp.js:22-27,
     but note getK is always called with 'sha1' in practice)
```
`pad(x)` left-pads the big-endian byte form to exactly 128 bytes (`srp.js:163-175`).

### 4.2 Hash usage — the critical subtlety
Plugin → M1 hash algorithm map (`connection.js:2081-2086`):
`Srp→sha1, Srp256→sha256, Srp384→sha384, Srp512→sha512`.

**Everything else is always SHA-1**, regardless of plugin:
- scramble `u = SHA1(pad(A) || pad(B))` (`srp.js:184-186`, hard-coded 'sha1')
- user hash `x = SHA1(salt || SHA1(USER_UPPER ':' password))` (`srp.js:245-250`)
- session key `K = SHA1(sessionSecret)` → 20 bytes (`srp.js:203-235`)
- Only the final proof `M` uses the plugin's hash (`srp.js:126`).

### 4.3 Client session & proof (`srp.js:114-136, 203-235`)
```
a = random 128 bytes as BigInt, reduced mod N   (clientSeed, srp.js:35-49 — the
    reduction of a mod N matters: see comment; without it ~10% of logins fail)
A = g^a mod N
u = SHA1(pad(A) || pad(B))
x = SHA1(salt_string || SHA1(upper(user) + ':' + password))
S = (B - k·g^x mod N) ^ ((a + u·x) mod N)  mod N
    // NOTE: Firebird reduces the exponent (a + ux) mod N — non-standard SRP,
    // must match (comment at srp.js:216-219)
K = SHA1(S)                                  // 20-byte session key
M1: n1 = SHA1(N-bytes); n2 = SHA1(g-bytes); n1 = n1 ^ n2 mod N   // modPow! Firebird
    quirk — NOT the RFC's H(N) xor H(g)  (srp.js:118-124)
    n2' = SHA1(upper(user))                  // hashed as *string*
M  = HASHplugin(n1-bytes || n2'-bytes || salt_string || A-bytes || B-bytes || K-bytes)
```
BigInt→Buffer conversions use minimal-length hex (`toBuffer`, `srp.js:287-289`,
with odd-length hex zero-prefixed). The salt is used **as the raw string received**
(itself typically ASCII hex from the server) — it is fed to the hash as a UTF-8 string,
not decoded from hex.

### 4.4 Server data parsing (`connection.js:2099-2117`)
The op_accept_data / op_cont_auth `data` array contains:
```
UInt16LE saltLen | salt bytes (ASCII, kept as utf8 string) |
UInt16LE keyLen  | server public key B as ASCII hex
```
Key start computed as `keyStart = (saltLen + 2 + 3) & ~3` and the key is read to end of
buffer (ignores keyLen!). Salt sanity check `saltLen > 64` only logs `'salt to long'`.
`B = BigInt('0x' + hexText)`.

### 4.5 How auth data flows
- op_connect: `CNCT_specific_data` = A in hex (multiblock parts of 254 bytes).
- Server responds op_accept_data/op_cond_accept with salt+B; client computes proof.
- `accept.authData = M.toString(16)` (hex text).
- **op_cond_accept path**: authData is sent via `op_cont_auth` before attach.
- **op_accept_data path**: authData is embedded in the attach DPB as
  `isc_dpb_specific_auth_data (84)` — plain hex string (`connection.js:522-524`).
- Legacy fallback: `isc_dpb_password_enc (30)` = `crypt(password,'9z').substr(2)` for
  protocol 11/12, `isc_dpb_password (29)` plaintext for protocol 10
  (`connection.js:503-511`).

### 4.6 Wire encryption (op_crypt) — `connection.js:408-461`, `socket.js`
After successful accept with a session key, if version ≥ 13 and
`wireCrypt !== WIRE_CRYPT_DISABLE`:
```
key = Buffer.from(sessionKey.toString(16).padStart(40, '0'), 'hex')  // 20 bytes
plugin = pick from server 'keys' list, preference: chacha64 > chacha > arc4
send: op_crypt(96), <string plugin e.g. 'Arc4'>, <string 'Symmetric'>
```
- **Arc4**: encryption enabled on the client immediately after *sending* op_crypt
  (op_crypt itself goes plaintext, the op_response comes back encrypted). RC4 KSA/PRGA
  implemented in `socket.js:9-50`, keyed with the 20-byte K, separate cipher instances
  for TX and RX.
- **ChaCha / ChaCha64**: wait for op_crypt's op_response whose `buffer` is the IV
  (ChaCha64: 8 bytes; ChaCha: 12 bytes); key = SHA-256(sessionKeyBytes) (32 bytes);
  Node `chacha20` cipher with an OpenSSL 16-byte IV assembled per `socket.js:56-68`
  (ivlen 8 → copy to offset 8; ivlen 12 → copy to offset 4; ivlen 16 → counter LE from
  bytes 12..15 + 12 IV bytes at offset 4).
- Compression, when active, is applied **before** encryption on send and after
  decryption on receive (`socket.js:106-181`).

### 4.7 op_crypt_key_callback (database encryption) — `connection.js:2320-2338`
Receive: `serverPluginData:array, p_cc_reply:int32`. Reply
`op_crypt_key_callback(97)` + `addBlr(<client data>)`; client data from
`options.dbCryptConfig` (plain UTF-8, or `'base64:...'`-prefixed).

---

## 5. op_attach / op_create — DPB construction

NF `connection.js:475-587` (attach), `615-717` (create). DPB tag values in
`const.js:364-461` (standard Firebird values; notable ones used):

| Tag | Value | Used for |
|---|---|---|
| isc_dpb_version1 | 1 | first byte of DPB |
| isc_dpb_version2 | 2 | service SPB (v2, doubled: `[2,2]`) |
| isc_dpb_page_size | 4 | create |
| isc_dpb_sweep_interval | 22 | — |
| isc_dpb_force_write | 24 | create (=1) |
| isc_dpb_user_name | 28 | attach |
| isc_dpb_password | 29 | proto 10 only |
| isc_dpb_password_enc | 30 | proto 11/12 |
| isc_dpb_lc_ctype | 48 | connection charset |
| isc_dpb_overwrite | 54 | create (=1) |
| isc_dpb_connect_timeout | 57 | — |
| isc_dpb_dummy_packet_interval | 58 | service attach (=120 LE int) |
| isc_dpb_sql_role_name | 60 | role |
| isc_dpb_sql_dialect | 63 | create (=3) |
| isc_dpb_set_db_charset | 68 | create |
| isc_dpb_process_id | 71 | `[71, 4] + Int32LE(pid)` |
| isc_dpb_trusted_auth | 73 | — |
| isc_dpb_process_name | 74 | process.title (truncated to last 255) |
| isc_dpb_org_filename | 76 | — |
| isc_dpb_utf8_filename | 77 | proto ≥13, zero-length |
| isc_dpb_auth_block | 79 | — |
| isc_dpb_client_version | 80 | — |
| isc_dpb_specific_auth_data | 84 | SRP proof hex, proto 13+ |
| isc_dpb_auth_plugin_list | 85 | — |
| isc_dpb_auth_plugin_name | 86 | — |
| isc_dpb_session_time_zone | 91 | options.sessionTimeZone |
| isc_dpb_parallel_workers | 92 | addNumeric |
| isc_dpb_max_inline_blob_size | 93 | addNumeric (FB5+) |
| isc_dpb_search_path | 94 | proto ≥20 (FB6) |
| isc_dpb_default_schema | 95 | proto ≥20 (FB6) |

NF attach message:
```
op_attach(19), 0 /* Database Object ID */, <string db path>, <array DPB>
```
DPB build order (`connection.js:493-556`): version1(1); lc_ctype (options.encoding,
default 'UTF8'); [utf8_filename(77),0] if proto ≥ 13; user_name; password/password_enc
only when proto < 13 **and** no SRP authData; sql_role_name; process_id; process_name;
specific_auth_data(84)=authData hex if present; session_time_zone; parallel_workers;
max_inline_blob_size; default_schema/search_path (proto ≥ 20).

NF create adds: set_db_charset(68)='UTF8', sql_dialect=3, force_write=1, overwrite=1,
page_size (default 4096).

NF2 attach (`index.js:4006-4017`): `[1, lc_ctype(48)+enc, user_name(28), password(29)
plaintext, sql_role_name(60)?]` → `op_attach, 0, dbpath, DPB`.

Response is a standard op_response; `handle` = attachment handle used in subsequent
`op_transaction`, `op_allocate_statement`, etc.

op_detach: NF sends `op_detach(21), 0` (`connection.js:600-604`). NF2 sends
`op_detach, dbhandle||0, op_disconnect(6)` — piggybacks op_disconnect in the same
packet (`index.js:4060-4063`).

op_drop_database: `op_drop_database(81), dbhandle` (`connection.js:720-736`).

---

## 6. op_response parsing & protocol version differences

### 6.1 op_response layout (`connection.js:2404-2476`)
```
handle:int32
oid:   quad (int32 high, int32 low)   // blob id / object id; stored if nonzero
data:  array (int32 len + bytes + pad) // info buffer, e.g. prepare DESCRIBE reply
status vector: sequence of clumplets until isc_arg_end:
    isc_arg_end(0)          → stop
    isc_arg_gds(1)          → int32 gdscode (0 = skip)
    isc_arg_string(2) / isc_arg_interpreted(5) / isc_arg_sql_state(19) → string param
    isc_arg_number(4)       → int32 param; if current gdscode == isc_sqlerr
                              (335544436) also sets response.sqlcode
    anything else           → 'Unexpected' error
```
Error text is resolved from gdscodes via `lib/firebird.msg.json` (NF,
`utils.js:lookupMessages`) or binary `firebird.msg` B-tree lookup (NF2
`lib/messages.js`, header: bucket_size@2 UInt16LE, top_tree@4 UInt32LE,
levels@12 UInt16LE; params substituted into `@1`,`@2`…).

### 6.2 How versions 10–13 differ in the code
- **Protocol 10**: plaintext `isc_dpb_password`; no lazy send; statements need separate
  `op_allocate_statement` round-trip (`connection.js:1000-1015` —
  `protocolMinimumType === ptype_lazy_send` selects the combined path); per-column
  trailing 4-byte NULL indicator in row data (see §8).
- **Protocol 11/12**: `isc_dpb_password_enc` (DES crypt); lazy send enabled
  (ptype_lazy_send): `op_allocate_statement` + `op_prepare_statement` are written in
  one packet and their two op_responses parsed via `callback.lazy_count = 2`
  (`connection.js:974-996`, response loop at `connection.js:1895-1913`); deferred
  packets: `op_free_statement`/`op_close_blob` are buffered client-side and flushed
  with the next real request (`_queueEvent(callback, defer=true)` →
  `socket.write(data, defer)`, `connection.js:311-328`, `socket.js:137-157`).
  v12 adds op_cancel support (not used by driver).
- **Protocol 13**: plugin auth (op_cont_auth, SRP), wire crypt; **row/param NULL
  bitmap replaces per-column indicators**; op_execute2 used for EXEC PROCEDURE with
  outputs (`connection.js:1084-1090`).
- **Protocol ≥ 14/15**: only crypt/accept related; no message-format changes in driver.
- **Protocol ≥ 16**: op_execute gains trailing `p_sqldata_timeout` int32
  (`connection.js:1399-1402`).
- **Protocol ≥ 18**: op_execute gains `p_sqldata_cursor_flags` int32 (1 = scrollable)
  (`connection.js:1404-1406`); op_fetch_scroll available.
- **Protocol ≥ 19**: op_execute gains `p_sqldata_inline_blob_size` int32
  (`connection.js:1408-1410`); server may push `op_inline_blob(114)` frames:
  `tran_id:int32, blob_id:quad, data:array`, cached in a Map keyed
  `"high:low"` and consumed instead of op_open_blob (`connection.js:1863-1876`,
  `2619-2630`).
- **Protocol 20 (FB6)**: DESCRIBE_WITH_SCHEMA info items; DPB 94/95.

---

## 7. Statement lifecycle

### 7.1 Allocate + prepare
- `op_allocate_statement(62), dbhandle` → op_response.handle = statement handle
  (`connection.js:896-910`).
- `op_prepare_statement(68)` (`connection.js:1019-1064`):
```
op_prepare_statement, transaction.handle, statement.handle,
3 /* SQL dialect */, <string: query>, <array: info items>, 65535 /* buffer_length */
```
  Combined lazy variant (`allocateAndPrepareStatement`, `connection.js:949-997`)
  writes op_allocate_statement with statement handle `0xFFFF` placeholder in the
  prepare, `lazy_count = 2`.

Info items requested (DESCRIBE, `const.js:582-604`):
```
21 (isc_info_sql_stmt_type)
 4 (isc_info_sql_select)
 7 (isc_info_sql_describe_vars)
 9 (isc_info_sql_sqlda_seq)
11 (isc_info_sql_type)
12 (isc_info_sql_sub_type)
13 (isc_info_sql_scale)
14 (isc_info_sql_length)
16 (isc_info_sql_field)
17 (isc_info_sql_relation)
19 (isc_info_sql_alias)
 8 (isc_info_sql_describe_end)
 5 (isc_info_sql_bind)
 7, 9, 11, 12, 13, 14, 8          // same core items for input params
[+ 22 (isc_info_sql_get_plan) if plan requested]
[DESCRIBE_WITH_SCHEMA inserts 33 (isc_info_sql_relation_schema) after 17 for proto ≥20]
```
All isc_info_sql_* values: select=4, bind=5, num_variables=6, describe_vars=7,
describe_end=8, sqlda_seq=9, message_seq=10, type=11, sub_type=12, scale=13, length=14,
null_ind=15, field=16, relation=17, owner=18, alias=19, sqlda_start=20, stmt_type=21,
get_plan=22, records=23, batch_fetch=24, relation_alias=25, explain_plan=26,
relation_schema=33. Structural: isc_info_end=1, isc_info_truncated=2, isc_info_error=3,
isc_info_length=126, isc_info_flag_end=127.

Statement types (`const.js:563-578`): select=1, insert=2, update=3, delete=4, ddl=5,
get_segment=6, put_segment=7, exec_procedure=8, start_trans=9, commit=10, rollback=11,
select_for_upd=12, set_generator=13, savepoint=14.

### 7.2 Parsing the DESCRIBE response — `describe()` (`connection.js:2478-2603`)
The op_response `buffer` is walked with BlrReader:
- `21` → `statement.type = readInt()` (clumplet int)
- `4` → start output param array; `5` → start input param array
- `7 (describe_vars)` → `readInt()` (count, discarded), then loop:
  - `9 (sqlda_seq)` → `num = readInt()` (1-based index)
  - `11 (type)` → `type = readInt()`; instantiate SQLVar class by `type & ~1`;
    `param.nullable = Boolean(type & 1)`; `param.type = type & ~1`;
    `parameters[num-1] = param`
  - `12` → `param.subType = readInt()`
  - `13` → `param.scale = readInt()`
  - `14` → `param.length = readInt()` (byte length on the wire)
  - `15` → `param.nullable = Boolean(readInt())`
  - `16/17/33/18/19/25` → field/relation/relationSchema/owner/alias/relationAlias
    strings
  - `2 (isc_info_truncated)` → throws `'Truncated'` (no retry with bigger buffer —
    known limitation; 65535 buffer + huge column count could fail)
  - unknown byte → `finishDescribe = true; br.pos--`
- After parse, NF unpacks `charSetId = subType & 0xFF`, `collationId = subType >> 8`
  for TEXT/VARYING (`connection.js:2589-2602`).

### 7.3 BLR message descriptor — `CalcBlr` (`connection.js:2605-2617`)
For both execute params and fetch output:
```
blr_version5(5), blr_begin(2), blr_message(4), 0 /* msg number */,
UInt16LE (count * 2),
per variable: <type-specific blr>, blr_short(7), 0   // the short is the null flag slot
blr_end(255), blr_eoc(76)
```
Per-type BLR (from `xsqlvar.js` calcBlr methods): text: `blr_text(14) + word(length)`;
varying: `blr_varying(37) + word(length)`; short: `blr_short(7) + scale`; long:
`blr_long(8) + scale`; int64: `blr_int64(16) + scale`; int128: `blr_int128(26) + scale`;
float: `blr_float(10)`; double: `blr_double(27)`; timestamp: `blr_timestamp(35)`;
date: `blr_sql_date(12)`; time: `blr_sql_time(13)`; quad/blob/array:
`blr_quad(9) + scale/0`; bool: `blr_bool(23)`; dec64: `blr_dec64(24)`; dec128:
`blr_dec128(25)`; time_tz: `blr_sql_time_tz(28)`; timestamp_tz: `blr_timestamp_tz(29)`;
ex_time_tz: `blr_ex_time_tz(30)`; ex_timestamp_tz: `blr_ex_timestamp_tz(31)`.
(⚠ NF `const.js:335-336` first defines blr_timestamp_tz=28/blr_time_tz=29 then
*redefines* at 345-348 as blr_sql_time_tz=28/blr_timestamp_tz=29 — the later values win
in the object spread and are correct per Firebird's blr.h.)
Bool params are sent as `blr_short(7)` + int (NF `xsqlvar.js:714-732`).

### 7.4 op_execute / op_execute2 — `sendExecute` (`connection.js:1332-1414`)
```
op(63 or 76), statement.handle, transaction.handle,
<array: input BLR (CalcBlr) or empty>,
0  /* message number */,
1 if params else 0 /* number of messages */,
[message data — see below],
if op_execute2:
    <array: output BLR or empty>, 0 /* output message number */
if proto ≥ 16: int32 timeout (0)
if proto ≥ 18: int32 cursor flags (1 = scrollable)
if proto ≥ 19: int32 inline blob size
```
op_execute2 is chosen when proto ≥ 13 && stmt type == exec_procedure(8) &&
output.length > 0 (`connection.js:1083-1090`); NF2 uses op_execute2 for any
exec_procedure with outputs (no proto check, `index.js:4518-4521`).

**Message data, proto ≥ 13** (`connection.js:1348-1372`): null bitmap first —
`ceil(paramCount/8)` bytes, bit i (LSB-first within byte) = 1 if param i is null —
then pad to 4-byte boundary with 0xFF (`addAlignment`), then each **non-null** param's
`encode()` (value only, no indicator).

**Message data, proto < 13** (`connection.js:1373-1380`): for each param:
`encode()` then, for non-null values, `addInt(0)` (null indicator 0). For null values
the Param classes themselves write a zero value + `addInt(1)`. (In NF2 every Param
encode writes value + indicator inline, `index.js:1201-1210` etc.)

Response: op_response for op_execute; for op_execute2 an `op_sql_response(78)` with
one row precedes the op_response.

### 7.5 op_fetch and batched fetch (`connection.js:1419-1441`)
```
op_fetch(65), statement.handle, <array: output BLR>, 0 /* message number */,
count /* fetch size, DEFAULT_FETCHSIZE = 200 (const.js:16) */
```
`fetchAll` loops fetch(200) until `fetched` (`connection.js:1495-1560`). NF2 identical
(fetch size 200, `index.js:871, 4780-4809`).

**op_fetch_response(66) / op_sql_response(78) stream parsing**
(`connection.js:1914-2039`): repeated `{status:int32, count:int32, [row data]}`;
`status == 100` → end of cursor; after each row another opcode int is read — it is
either another op_fetch_response header or an op_response (statement exhausted this
round). op_sql_response instead decrements `count`. Partial-packet state is stashed on
the XdrReader (`data.fstatus/fcount/fcolumn/frow/frows/fop/r`) so decoding resumes when
more TCP data arrives — including mid-row resume via `data.fcolumn`.

Row layout proto ≥ 13: `ceil(outputCount/8)`-byte null bitmap, padded to 4
(`readBuffer((4 - n) & 3)`), then only… **no — all columns are still present?** No:
columns flagged null in the bitmap are *skipped entirely* (no bytes on the wire);
non-null columns are decoded in order (`connection.js:1953-1997`). Row layout < 13:
every column has its value followed by an int32 null indicator (nonzero = null); the
SQLVar decode methods read the value then `data.readInt()` (`xsqlvar.js`, e.g. 93-98).

### 7.6 op_free_statement (`connection.js:913-946`)
```
op_free_statement(67), statement.handle, DSQL_drop(2) | DSQL_close(1)
```
Sent deferred (lazy) on proto ≥ 11 — no response awaited; callback fired immediately.

### 7.7 Named parameters (NF `connection.js:1279-1313`)
Object params are mapped by `input[i].alias || input[i].field` (case-insensitive,
optional leading `:`). Falls back to `[params]` single positional if nothing matched.

---

## 8. Data type encoding/decoding

### 8.1 SQL type constants (`const.js:276-304`, NF2 `index.js:263-278`)

| Constant | Value | Wire size / format |
|---|---|---|
| SQL_TEXT | 452 | `length` bytes + pad to 4 (no length prefix) |
| SQL_VARYING | 448 | int32 length + bytes + pad |
| SQL_SHORT | 500 | int32 (yes, 4 bytes on wire) |
| SQL_LONG | 496 | int32 |
| SQL_FLOAT | 482 | float32 BE |
| SQL_DOUBLE | 480 | double64 BE |
| SQL_D_FLOAT | 530 | decoded as float |
| SQL_TIMESTAMP | 510 | int32 date + uint32 time |
| SQL_BLOB | 520 | quad (blob id) |
| SQL_ARRAY | 540 | quad |
| SQL_QUAD | 550 | quad |
| SQL_TYPE_TIME | 560 | uint32 (deci-milliseconds ×10) |
| SQL_TYPE_DATE | 570 | int32 (Modified JD) |
| SQL_INT64 | 580 | int64 BE |
| SQL_INT128 | 32752 | 2× uint64 BE (high, low) |
| SQL_TIMESTAMP_TZ | 32754 | date + time + int32 tz |
| SQL_TIMESTAMP_TZ_EX | 32748 | date + time + tz + int32 ext offset |
| SQL_TIME_TZ | 32756 | time + int32 tz |
| SQL_TIME_TZ_EX | 32750 | time + tz + int32 ext offset |
| SQL_DEC16 | 32760 | 8 bytes IEEE754 Decimal64 (`ieee754-decimal.js`) |
| SQL_DEC34 | 32762 | 16 bytes IEEE754 Decimal128 |
| SQL_BOOLEAN | 32764 | int32 (0/1) |
| SQL_NULL | 32766 | treated as text |

The low bit of the described `sqltype` is the nullable flag: `type & 1`. Dispatch is on
`type & ~1` (`connection.js:2512-2544`).

### 8.2 Date/time math (`xsqlvar.js:11-14`)
```
DateOffset = 40587      // MJD of Unix epoch 1970-01-01
TimeCoeff  = 86400000   // ms/day
MsPerMinute = 60000
decode date:      ms = (raw - 40587) * 86400000  (+ local tz offset correction)
decode time:      ms = floor(raw / 10)           // raw is in 100µs units
encode timestamp: value = date.getTime() - tzOffset*60000;
                  time = (value % 86400000) * 10; date = value/86400000 + 40587
                  negative time → date--, time += 864000000  (xsqlvar.js:684-705)
```
All decoding converts to local-time JS Date (adds `getTimezoneOffset()`), and TZ types
**discard** the timezone field (`xsqlvar.js:399-481`).

### 8.3 Scaled numerics
`ScaleDivisor = [1,10,100,...,1e15]` (`xsqlvar.js:10`); SHORT/LONG/INT64 decode divides
by `ScaleDivisor[|scale|]` producing a JS float (precision loss!). INT128 with scale:
if > MAX_SAFE_INTEGER returns a **string** `"int.frac"` via decimal-string slicing,
else Number divided (`xsqlvar.js:232-261`). NF2: same but scale division happens *only
when not null* (`index.js:1031-1045`).

### 8.4 Text decode & truncation heuristic (NF `xsqlvar.js:67-138`)
- SQL_TEXT (CHAR): `readText(this.length, enc)`; then trims to
  `floor(length / charsetWidth)` characters where width map is
  `{UTF8:4, UNICODE_FSS:3, SJIS:2, EUCJ:2, else 1}` — this is the CHAR blank-padding
  workaround for multibyte charsets (crude: it substring-cuts decoded JS string).
- SQL_VARYING: `readString(enc)` (int32 length + data + pad).
- `subType === 1` (OCTETS) → returns raw Buffer.
- Encoding resolution `FirebirdToNodeEncoding` map: UTF8/UNICODE_FSS→'utf8',
  WIN1252/ISO8859_1/LATIN1→'latin1', ASCII→'ascii', NONE→'latin1'
  (`xsqlvar.js:28-36`).

### 8.5 Param encode (NF `xsqlvar.js:502-732`)
For proto ≥ 13, `encode()` writes only the value (nulls handled by bitmap and skipped).
For < 13, the connection appends `addInt(0)` after each non-null encode. Value classes:
`SQLParamInt` (int32), `SQLParamInt64`, `SQLParamInt128`, `SQLParamDouble`,
`SQLParamString` (addText — CHAR-style, **no length prefix**, works because the
matching BLR is `blr_text` with the exact byte length), `SQLParamQuad` (blob id),
`SQLParamDate` (timestamp pair), `SQLParamBool` (int32 via blr_short),
`SQLParamDecFloat16/34`. JS value mapping (`connection.js:1183-1268`): bigint→Int128,
integer-in-int32-range→Int, other integer→Int64, non-integer number→Double,
string→String, boolean→Bool, Date/dateish→Date, object→JSON string (if `jsonAsObject`),
default→`value.toString()`.

**Pitfall:** `SQLParamString.calcBlr` computes `blr_text` length from the *value's*
byte length, not the described param length — so the BLR always matches the data. NF2
additionally supports Buffer values via `addTextBuffer` (`index.js:1261-1284`).

### 8.6 XDR alignment rules recap
- Every variable-length field (string/array/BLR) is padded to a 4-byte boundary with
  zeros; the length prefix records the unpadded size.
- SQL_TEXT data is padded to align(length) with zeros on write and skipped on read
  (`readText` advances `align(len)`).
- The proto-13 null bitmap is padded to 4 bytes (write: 0xFF filler via
  `addAlignment`; read: `readBuffer((4 - nullBitsLen) & 3, false)`).

---

## 9. Blob handling

### 9.1 Reading (NF `connection.js:1564-1602, 2619-2806`)
- Row decode leaves a **function** in the cell for BLOB columns
  (`fetch_blob_async`, or with `options.blobAsText` + `subType === isc_blob_text(1)` a
  promise-returning fetcher, `connection.js:1980-1987`).
- `op_open_blob(35), transaction.handle, quad(blob id)` → response.handle = blob
  handle.
- `op_get_segment(36), blob.handle, bufferLength, 0` where bufferLength =
  `options.blobReadChunkSize || 1024`, clamped ≤ 65535 (`connection.js:53-54, 1583-1591`).
  Response: `handle` field is the segment status — **`handle === 2` means EOF
  (isc_segstr_eof / “last segment”)**, loop otherwise; `buffer` holds one-or-more
  `{UInt16LE len, bytes}` segments parsed with `BlrReader.readSegment()`.
- `op_close_blob(39), blob.handle` — sent deferred (lazy) when reading
  (`closeBlob(..., defer=true)`, `connection.js:1574-1580`).
- blobAsText fetches run **sequentially** per fetch batch, to avoid exhausting
  Firebird's per-connection open-blob limit (issue #387 comment,
  `connection.js:1507-1523`). Each opens/uses either the provided transaction or a
  throwaway `ISOLATION_READ_UNCOMMITTED` transaction committed afterwards.
- Inline blobs (proto ≥ 19): `op_inline_blob` frames cached by `"high:low"` id and
  served without any round-trip (`connection.js:2622-2627, 2769-2791`).
- NF2: same opcodes, fixed 1024 read buffer (`index.js:4867-4875`); segment loop
  keyed on `ret.handle !== 2` too; blob functions are invoked
  `blob(function(err, name, eventEmitter))` with `data`/`end`/`error` (and NF2 adds a
  `'text'` event carrying the transcoded whole value for text blobs,
  `index.js:1546-1563`).

### 9.2 Writing (NF `connection.js:1092-1165, 1594-1617`)
- `op_create_blob2(57), 0 /* BPB length/absent */, transaction.handle, 0, 0` →
  response: `handle` (blob handle) + `oid` (quad blob id). **No BPB is ever sent**
  (the two trailing zero ints are the empty id halves; the first 0 is an empty BPB
  array).
- Data sent via `op_batch_segments(44), blob.handle, int32(len+2),
  <BLR-array: UInt16LE len + bytes, padded>` — note the outer length is
  `buffer.length + 2` to include the segment-length word (`connection.js:1606-1617`).
- Chunk size: `options.blobChunkSize || 1024`, clamped ≤ 65535. Streams are paused
  and pumped chunk-by-chunk (`connection.js:1097-1165`).
- `op_close_blob` then the param becomes `SQLParamQuad(blob.oid)`.
- Values accepted: Buffer, string (UTF-8), stream (`.readable`), other → JSON string.

---

## 10. Transactions

TPB tag values (`const.js:496-520`): version1=1, version3=3, consistency=1,
concurrency=2, shared=3, protected=4, exclusive=5, wait=6, nowait=7, read=8, write=9,
lock_read=10, lock_write=11, verb_time=12, commit_time=13, ignore_limbo=14,
read_committed=15, autocommit=16, rec_version=17, no_rec_version=18,
restart_requests=19, no_auto_undo=20, lock_timeout=21 (FB ≥ 2.0).

### NF (`connection.js:748-827`)
```
op_transaction(29), dbhandle, <array TPB>
```
TPB built as: `isc_tpb_version3(3)` + isolation bytes + `read(8)|write(9)` +
`wait(6)` [+ `lock_timeout(21)` addNumeric if waitTimeout] or `nowait(7)` +
optional `no_auto_undo(20)`, `autocommit(16)`, `ignore_limbo(14)`.
Isolation presets (`const.js:522-528`):
```
ISOLATION_READ_UNCOMMITTED         = [15, 17]      // read_committed + rec_version (!)
ISOLATION_READ_COMMITTED           = [15, 18]      // read_committed + no_rec_version
ISOLATION_REPEATABLE_READ          = [2]           // concurrency
ISOLATION_SERIALIZABLE             = [1]           // consistency
ISOLATION_READ_COMMITTED_READ_ONLY = [15, 18]
```
Response handle = transaction handle. Then:
`op_commit(30), handle` / `op_rollback(31), handle` /
`op_commit_retaining(50), handle` / `op_rollback_retaining(86), handle`
(`connection.js:830-893`).

### NF2 (`index.js:4157-4190`, presets at 803-809)
Isolation arrays are **complete TPBs** including version byte:
```
ISOLATION_READ_UNCOMMITTED       = [3, 9, 6, 15, 18]
ISOLATION_READ_COMMITED          = [3, 9, 6, 15, 17]
ISOLATION_REPEATABLE_READ        = [3, 9, 6, 2, null]
ISOLATION_SERIALIZABLE           = [3, 9, 6, 1, null]
ISOLATION_READ_COMMITED_READ_ONLY= [3, 8, 6, 15, 17]
ISOLATION_READ_COMMITED_NOWAIT   = [3, 9, 7, 15, 18]
```
(the `null` slots are filtered/overwritten by the `Isolation` class,
`index.js:5119-5181`, which also defaults `lockTimeout` to **5 s** whenever wait mode
is on, emitting `[21, 4, Int32LE(timeout)]`). Position semantics:
[0]=version, [1]=read/write, [2]=wait/nowait, [3]=isolation, [4]=rec_version flag.

---

## 11. Events (POST_EVENT) — both drivers

NF2 pioneered this (`index.js:1985-2014, 2113-2209, 3431-3536, 5019-5092`); NF has the
hardened version (`connection.js:1741-1844`, `eventConnection.js`,
`fbEventManager.js`, `database.js:322-375`).

### 11.1 Aux connection
```
op_connect_request(53), 1 /* P_REQ_async */, dbhandle, eventid(NF)/0(NF2)
```
Response op_response: `buffer` bytes = sockaddr:
`family:Int16BE@0, port:UInt16BE@2, IPv4 bytes @4..7`
(`connection.js:1771-1775`). NF quirk: if host resolves to `'0.0.0.0'` or `'::'`,
substitute the main connection's host (`database.js:342-344`). Client opens a **plain
TCP socket** to that address — no handshake at all on the aux socket; the server just
starts pushing `op_event` packets.

### 11.2 Subscribing
```
op_que_events(48), dbhandle,
<array EPB>, 0 /* ast */, 0 /* args */, eventid:int32
```
EPB format (`connection.js:1796-1809`): byte `EPB_version1 = 1`, then per event:
`byte nameLength, name bytes (UTF8), Int32LE count` (the last-seen count — server fires
when its counter differs). Response: plain op_response.
`op_cancel_events(49), dbhandle, eventid` cancels (`connection.js:1824-1844`).

### 11.3 op_event on the aux socket (`eventConnection.js:39-111`)
```
op_event(52), dbHandle:int32, <array EPB buffer>, ast:int64, eventId:int32
```
EPB buffer parse: skip byte 0 (version 1), then repeated
`{Int8 len, name, Int32LE count}`. The manager compares counts to its stored table and
emits `post_event(name, count)` for changed ones, updates counts, and **re-arms** by
sending another op_que_events (one-shot semantics). NF2 bug: first delivery is
swallowed only if `prevcount !== 0` (`index.js:3504`), NF fires on any difference
(`eventConnection.js:80-81`).

### 11.4 NF hardening (fbEventManager.js — worth replicating)
- Never send `op_que_events` with an **empty EPB** — some server versions never reply,
  wedging the main-connection queue (`fbEventManager.js:193-201`).
- Mark subscription active *before* sending queEvents: the server can deliver the
  baseline op_event before the op_response arrives (`fbEventManager.js:203-209`).
- Re-subscription: cancel (op_cancel_events) → wait op_response → queEvents.
- Teardown: null the event callback first, `sock.end()` (FIN, not destroy/RST —
  RST confuses FB3's event cleanup), wait for 'close' with a 200 ms fallback timer
  (`fbEventManager.js:258-325`).
- Stray `op_event` arriving on the **main** connection must be consumed
  (db:int32, EPB array, int64 ast, int32 rid) and *not* matched to the request queue
  (`connection.js:2339-2360`); likewise unsolicited `op_response_piggyback(72)` from
  FB5 must be parsed (op_response layout) and dropped (`connection.js:2361-2384`).

---

## 12. NF2's CHARSET NONE / transcodeAdapter

Purpose: DBs declared `CHARSET NONE` that physically store a legacy codepage
(e.g. WIN1252). Driver must not assume UTF-8 anywhere.

- **iconv-lite is NOT a dependency of the driver** — the adapter is user-supplied;
  tests wire iconv-lite in (`test/mr/12-1-charset-none-transcoder.js:55-61`):
  ```js
  const transcodeAdapter = {
    text: {
      fromDb: (buffer) => iconv.decode(buffer, 'win1252'),
      toDb:   (value)  => iconv.encode(value, 'win1252')
    }
  };
  attach({ ..., encoding: 'NONE', transcodeAdapter })
  ```
- Interface + defaults: `DEFAULT_TRANSCODE_ADAPTER` (`index.js:873-886`) —
  `fromDb(buffer, field) → string|Buffer` (default: identity Buffer),
  `toDb(value, field) → Buffer` (default: `Buffer.from(String(value))`).
  `normalizeTranscodeAdapter` (`index.js:888-896`) fills missing methods.
  Adapter is normalized in the Connection ctor (`index.js:3566`) and re-normalized in
  attach/createDatabase (`index.js:3993, 4081`).
- Activation gate: `connection._isEncodingNone = (options.encoding||'UTF8')
  .toUpperCase() === 'NONE'` (`index.js:3563-3565`). The adapter only fires when
  encoding is NONE.
- Hook points:
  1. **VARCHAR/CHAR decode** — `SQLVarText.decode` / `SQLVarString.decode`
     (`index.js:921-975`): when `_isEncodingNone && subType !== 1` (subType 1 =
     OCTETS → raw Buffer), read raw bytes and call
     `connection._decodeTextFromDb(buffer, field)` (`index.js:3738-3744`). The
     SQLVar gets a `connection` back-pointer during describe (`index.js:4391`).
  2. **SQL text of prepared statements** — `prepareStatement`
     (`index.js:4459-4468`): the query string is run through `toDb` and written with
     `'binary'` (latin1) encoding so the exact bytes hit the wire. This is essential:
     literals like `WHERE NAME = '€'` must be codepage bytes, not UTF-8.
  3. **String params** to NONE TEXT/VARYING columns (subType !== 1):
     `SQLParamString(self._encodeTextToDb(value, meta))` — Buffer path via
     `addTextBuffer` (`index.js:4673-4677`, `serialize.js:298-306`).
  4. **Text BLOB write** (`putBlobData`, `index.js:4535-4553`): when
     `meta.subType === 1` (isc_blob_text) and a text adapter exists, strings/objects
     are encoded with `toDb` before segmenting; raw Buffers bypass the adapter
     unless it's a text blob; stream chunks are stringified then encoded
     (`index.js:4568-4590` — ⚠ chunk-boundary hazard: a multibyte char split across
     stream chunks would be corrupted by per-chunk toString/encode).
  5. **Text BLOB read** (`fetch_blob_async`, `index.js:1489-1573`): for
     `fieldMeta.subType === 1`, each segment goes through `fromDb` and is re-emitted
     as a UTF-8 Buffer on `'data'`; a `'text'` event fires at EOF with the full
     decoded value; `readBlob`/`fetch_blob_sync` consume it
     (`index.js:1446-1454`, `5296-5359` — note `decodeBlob` currently just does
     `data.toString()` because the per-segment decode already happened; the commented
     line shows the older double-decode bug).
- If no adapter is provided with charset NONE, TEXT/VARYING/BLOB-subtype-1 surface as
  raw Buffers (README:210).
- **Blob text vs varchar text distinction**: for BLOBs, `subType === 1` *means text*
  (isc_blob_text); for CHAR/VARCHAR, `subType === 1` means *OCTETS/binary* and
  subType 0 means NONE. Opposite meanings of the same number — easy trap.
- NF's equivalent is much cruder: static charset→Node-encoding map with NONE→latin1
  (`xsqlvar.js:28-36`), connection-wide, no per-column handling.

---

## 13. Known bugs / pitfalls / workarounds seen in the code

1. **BitSet dual layout** (§2) — write and read paths use different bit-packing;
   don't reuse the class as-is.
2. **`addNumeric` 4-byte form is big-endian** (`serialize.js:87-93`) while
   `addByteInt32` (used for event counts, NF2 lock_timeout) is little-endian. Firebird
   parameter-block ints are little-endian; the BE variant appears to survive only
   because values < 256 use the 1-byte form in virtually every code path.
   (NF2 `Isolation` uses `addByte(21); addByte(4); addInt32LE(timeout)` — correct.)
3. **Null bitmap padding uses 0xFF** filler (`addAlignment`, `serialize.js:382-388`).
   The server ignores pad bytes; harmless but intentional in fbclient too.
4. **`describe()` throws 'Truncated'** with no retry (`connection.js:2579-2580`) —
   a statement with enough columns to overflow the 65535 info buffer fails hard.
   A reimplementation should re-request with `isc_info_sql_sqlda_start (20)`.
5. **Lazy-send desync hazards**: deferred packets *must accumulate*, not overwrite —
   fixed in NF `socket.js:142-151` (comment describes the hang caused by dropping a
   deferred op_close_blob before op_free_statement). Also `lazy_count` must be
   restored on partial-packet retry or the decoder waits for a second op_response
   that never comes (`connection.js:170-198`).
6. **op_fetch_response partial-packet resume** relies on stashing parser state on the
   XdrReader and a magic `data.readBuffer(68)` skip when resuming (`fop` flag,
   `connection.js:1923-1930`) — acknowledged “??” hack. Design a proper framing
   layer instead (buffer until a whole message is parseable).
7. **Blob handle EOF sentinel**: `ret.handle !== 2` loop — status 2 =
   isc_segstr_eof coming back through the op_response `handle` field. Status 1
   (isc_segment, buffer-too-small partial segment) is treated the same as 0.
8. **Open-blob concurrency deadlock** (NF issue #387): reading many text blobs in
   parallel exceeds server per-connection blob handles; NF serializes blob reads per
   batch (`connection.js:1507-1523`).
9. **CHAR (SQL_TEXT) multibyte trim heuristic** divides byte-length by max charset
   width (UTF8→4) and substrings the decoded text (`xsqlvar.js:71-88`) — wrong for
   strings mixing widths; correct approach is trimming trailing blanks.
10. **Scaled BIGINT/DECIMAL → JS float division** loses precision beyond 2^53
    (`xsqlvar.js:210-227`); INT128 partially fixed by string formatting.
11. **SQL_BOOLEAN wire size is int32** in both directions (with blr_short in the BLR
    for params, blr_bool for output) — don't send 1 byte.
12. **Event count semantics**: counts are cumulative server-side; deliverable events
    are detected by count difference; the *first* op_event after queEvents is the
    baseline and, in NF2, is suppressed only when prevcount==0
    (`index.js:3504` vs NF `eventConnection.js:80`). Update stored counts only for
    still-registered events (NF `eventConnection.js:87-93`).
13. **Aux socket teardown** — use FIN + wait-for-close + 200 ms fallback; RST breaks
    FB3 (`fbEventManager.js:269-307`).
14. **op_event / op_response_piggyback on the main socket** must be consumed without
    consuming a queue slot (`connection.js:217-227, 2339-2384`).
15. **SRP nonstandard math**: exponent `(a + ux) mod N` and `H(N)^H(g) mod N` instead
    of XOR; salt treated as opaque string; session key always SHA-1 → 20 bytes.
    Also `clientSeed` must reduce `a` mod N (comment `srp.js:36-40`).
16. **Leftover debug logging** in the SRP handshake (`connection.js:2120-2139` prints
    salt/keys/proof unconditionally via console.log) — a security bug; don't replicate.
17. **NF2 `EventConnection` default switch case calls `cb(...)` which is undefined**
    in scope (`index.js:3516-3517`) — crash on unexpected aux-socket opcode.
18. **NF2 detach piggybacks op_disconnect** in the detach packet (`index.js:4063`);
    NF instead sends op_detach with object id 0 and relies on socket close.
19. **Query cache** (`cacheQuery`/`maxCachedQuery` options) keys statements by exact
    SQL string and re-uses handles; released via DSQL_close instead of DSQL_drop when
    cached (`statement.js:20-26`).
20. **op_connect payload duplication**: NF passes `options.database` into op_connect's
    file field; NF2 passes it too — required by some server configs for per-database
    plugin config resolution.
21. **65535 clamp** on `blobChunkSize`/`blobReadChunkSize` (`connection.js:53-54`) —
    segment length is a UInt16.
22. **`MAX_BUFFER_SIZE = 8192`** guard only used for service queries.
23. **DEFAULT values**: host 127.0.0.1, port 3050, user SYSDBA, password masterkey,
    pageSize 4096, encoding 'UTF8', fetchSize 200, svc 'service_mgr'
    (`const.js:7-17`).

---

## 14. Misc reference

- **Response classes** attach to callbacks: `callback.response = new Statement(...)`
  etc. — op_response fills `.handle` on that object. `callback.statement` routes
  op_fetch_response/op_sql_response decoding.
- **Request pipelining**: strict FIFO `_queue` of callbacks; one decode per response;
  socket 'data' handler loops while bytes remain and re-buffers on RangeError
  (incomplete packet) (`connection.js:152-261`).
- **isc_arg codes**: end=0, gds=1, string=2, cstring=3, number=4, interpreted=5,
  unix=7, next_mach=15, win32=17, warning=18, sql_state=19. `isc_sqlerr = 335544436`.
- **Legacy crypt**: `lib/unix-crypt.js` is Apache Commons Codec UnixCrypt (DES) port;
  Firebird's LegacyHash = `crypt(password, '9z')[2:]` — always 11 chars.
- **Service opcodes** (op_service_attach 82 / _detach 83 / _info 84 / _start 85) use
  SPB version 2 (`[2,2]` header) and the isc_action_svc_* / isc_info_svc_* /
  isc_spb_* constants listed in `const.js:637-857` (values mirror Firebird's
  ibase.h; NF2 duplicates them at `index.js:283-473`).
- **NF2 promise layer** (`Fb2`, `index.js:5207-5684`): auto-upgrade of read-only
  transactions on error message `'attempted update during read-only transaction'`,
  `readBlob()` promise helper honoring the `'text'` event, `attachEvent` refuses
  non-local hosts (`index.js:5637-5639`).
- **NF options of interest**: `pluginName`, `wireCrypt` (0/1/2), `wireCompression`,
  `maxNegotiatedProtocols`, `blobAsText`, `jsonAsObject`, `blobChunkSize`,
  `blobReadChunkSize`, `sessionTimeZone`, `parallelWorkers`, `maxInlineBlobSize`,
  `defaultSchema`, `searchPath`, `cacheQuery`, `maxCachedQuery`,
  `retryConnectionInterval`, `dbCryptConfig`, `encoding`, `lowercase_keys`.

---

## ERRATA (verified against firebird source + live servers, 2026-07-09)

- §4.3 claims `u = SHA1(pad(A) || pad(B))` (128-byte padded). **Wrong for the
  server**: srp.cpp `computeScramble` uses `processStrippedInt` → u hashes the
  MINIMAL (leading-zero-stripped) big-endian bytes of A and B. node-firebird's
  padded variant fails ~1/128 handshakes (whenever A or B < 128 bytes) — this
  is likely a long-standing latent bug there. fast-firebird uses minimal bytes.
- §4.3 M1 user-hash component: `SHA1(upper(user))` is additionally passed
  through BigInteger (leading zeros stripped) before hashing into M.
