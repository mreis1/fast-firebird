# Firebird Wire Protocol — Core Reference (FB 3 / 4 / 5)

Authoritative reference for a clean-room TypeScript wire-protocol driver, extracted from the
official Firebird server sources at `references/firebird` (branch `master`, tree is Firebird
6.0-dev, build `6.0.0.2070` — it contains the complete history of protocol versions 10..20, so
everything needed for FB3/4/5 is present and forward-compatible notes for FB6 are included).

All file paths below are relative to `references/firebird/`.

Primary sources:

- `src/remote/protocol.h` — protocol versions, opcodes, packet structures
- `src/remote/protocol.cpp` — XDR (de)serialization of every packet type
- `src/common/xdr.cpp` — XDR primitive encodings (per-SQL-type wire format)
- `src/remote/remote.h`, `src/remote/remote.cpp` — port logic, auth block, wirecrypt, zlib
- `src/remote/inet.cpp` — TCP transport, connect sequence, aux (event) port
- `src/remote/client/interface.cpp` — full client-side call flows
- `src/auth/SecureRemotePassword/` — SRP (`srp.h`, `srp.cpp`, `client/SrpClient.cpp`, `server/SrpServer.cpp`)
- `src/plugins/crypt/arc4/Arc4.cpp` — wire encryption plugin
- `src/include/firebird/impl/consts_pub.h` — DPB/TPB/BPB/SPB tags
- `src/include/firebird/impl/inf_pub.h` — info items
- `src/include/firebird/impl/sqlda_pub.h` — SQL type codes, `DSQL_*` free options
- `src/include/firebird/impl/blr.h` — BLR codes for message descriptions

---

## 0. Transport & XDR basics

- TCP, default port **3050** (service name `gds_db`, `FB_SERVICE_PORT`; see `src/remote/inet.cpp:1005-1009`).
- Every packet is a sequence of XDR items. There is **no length-prefixed packet frame**: the
  stream is self-describing, each packet starts with a 4-byte big-endian opcode
  (`xdr_enum` of `P_OP`) followed by opcode-specific fields (`xdr_protocol()` in
  `src/remote/protocol.cpp:254`).
- XDR primitives (`src/common/xdr.cpp`):
  - `xdr_short` / `xdr_u_short` / `xdr_enum` / `xdr_int` / `xdr_long` / `xdr_u_long` — all sent
    as **4 bytes big-endian** (shorts are widened to 32 bits).
  - `xdr_hyper` (INT64) — two 4-byte big-endian longs, **high 32 bits first, then low**
    (`xdr.cpp:95-153` — on little-endian hosts `temp_long[1]` = high word is put first).
  - `xdr_quad` (SQUAD/blob-id) — 8 bytes: `gds_quad_high` (4 BE) then `gds_quad_low` (4 BE)
    (`xdr.cpp:585`).
  - `xdr_float` — 4-byte IEEE754 BE; `xdr_double` — 8 bytes, high-order IEEE word first
    (`FB_LONG_DOUBLE_FIRST`), i.e. straight big-endian double.
  - `xdr_opaque(len)` — raw bytes, **padded with zero bytes to a multiple of 4** (`xdr.cpp:544`).
  - `xdr_cstring` (counted string, `protocol.cpp:1390`) — 4-byte BE length, then bytes,
    then 0–3 zero pad bytes to a 4-byte boundary.
  - `xdr_string`/`xdr_wrapstring` — same wire form as cstring (used inside status vectors,
    max 65535 bytes).
- Object handles (`OBJCT`) are USHORT; `INVALID_OBJECT = 65535` (`protocol.h:160-162`).
- Buffer-length fields in `op_info_*` and `op_prepare_statement` were USHORT historically; when
  decoding, a value with the top 16 bits all set must be masked to 16 bits
  (`fixupLength`, `protocol.cpp:127`).

Send pipeline order (client → server): XDR encode → zlib deflate (if negotiated) → RC4 encrypt
(if active) → TCP (`REMOTE_deflate` in `remote.cpp:1663`, encrypt in `packet_send`,
`inet.cpp:3164`). Receive is the mirror: decrypt → inflate → XDR decode.

---

## 1. Protocol versions

`src/remote/protocol.h:52-120`. Since protocol 11 the version word has the top bit set
(`FB_PROTOCOL_FLAG = 0x8000`) to distinguish Firebird from InterBase; compare using
`version & 0x7FFF` (`FB_PROTOCOL_MASK`).

| Constant | Value (hex) | Introduced by | What it adds (comments in protocol.h) |
|---|---|---|---|
| `PROTOCOL_VERSION10` | `10` (0x000A) | IB6/FB1 | warnings support; no status-code encode/decode |
| `PROTOCOL_VERSION11` | `0x800B` | FB2.1 | `op_update_account_info`, `op_authenticate_user`, `op_trusted_auth` |
| `PROTOCOL_VERSION12` | `0x800C` | FB2.5 | asynchronous `op_cancel` (TCP only) |
| `PROTOCOL_VERSION13` | `0x800D` | **FB3.0** | auth plugins (`op_cont_auth`), accept-with-data, wirecrypt, **packed (null-bitmap) SQL messages**, zlib compression flag |
| `PROTOCOL_VERSION14` | `0x800E` | FB3.0.1 | fixes a bug in database-crypt key callback (adds `p_cc_reply` to `op_crypt_key_callback`) |
| `PROTOCOL_VERSION15` | `0x800F` | FB3.0.2 | crypt key callback allowed at connect phase (before attach) |
| `PROTOCOL_VERSION16` | `0x8010` | **FB4.0** | statement timeouts (`PROTOCOL_STMT_TOUT`); batch API opcodes ship with FB4 |
| `PROTOCOL_VERSION17` | `0x8011` | FB4.0.1 | `op_batch_sync`, `op_info_batch` |
| `PROTOCOL_VERSION18` | `0x8012` | **FB5.0** | `op_fetch_scroll` (`PROTOCOL_FETCH_SCROLL`) |
| `PROTOCOL_VERSION19` | `0x8013` | FB5.0.2 | `op_inline_blob` (`PROTOCOL_INLINE_BLOB`) |
| `PROTOCOL_VERSION20` | `0x8014` | FB6.0 | prepare flags in `op_prepare_statement` (`PROTOCOL_PREPARE_FLAG`) |

Driver targeting FB3/4/5 should offer 13..19 (offering more is harmless — server picks the
highest it supports; `MAX_CNCT_VERSIONS = 11`, but pre-FB6 servers only read the first 10
offers — `protocol.h:391`).

Architecture codes (`enum P_ARCH`, `protocol.h:124`): **`arch_generic = 1`** (always use this —
canonical/XDR forms), `arch_sun=3, arch_sun4=8, arch_sunx86=9, arch_hpux=10, arch_rt=14,
arch_intel_32=29, arch_linux=36, arch_freebsd=37, arch_netbsd=38, arch_darwin_ppc=39,
arch_winnt_64=40, arch_darwin_x64=41, arch_darwin_ppc64=42, arch_arm=43, arch_winnt_arm64=44`.
With `ASYMMETRIC_PROTOCOLS_ONLY` (default, `protocol.h:46`) the client only offers
`arch_generic`.

Protocol types (`p_acpt_type` / `p_cnct_max_type`, `protocol.h:149-156`):

- `ptype_batch_send = 3` — batch sends, no asynchrony
- `ptype_out_of_band = 4` — batch sends with OOB notification
- `ptype_lazy_send = 5` — deferred packet delivery (modern client always offers this)
- `ptype_MASK = 0xFF` — low byte is the ptype; high byte carries flags:
- `pflag_compress = 0x100` — request/confirm zlib wire compression (P13+)
- `pflag_win_sspi_nego = 0x200` — Win_SSPI Negotiate support

The client sends one `p_cnct_repeat` per offered version with
`{version, arch_generic, min_type=0, max_type=ptype_lazy_send | pflag_compress?, weight}`;
weights are `2,4,6,...` in offer order (`REMOTE_PROTOCOL` macro `protocol.h:411`,
`INET_analyze` `inet.cpp:706-733`).

---

## 2. Opcode table

`enum P_OP`, `src/remote/protocol.h:184-341`. (Commented-out/obsolete codes omitted where noted.)

| Op | # | | Op | # |
|---|---|---|---|---|
| `op_void` | 0 | | `op_allocate_statement` | 62 |
| `op_connect` | 1 | | `op_execute` | 63 |
| `op_exit` | 2 | | `op_exec_immediate` | 64 |
| `op_accept` | 3 | | `op_fetch` | 65 |
| `op_reject` | 4 | | `op_fetch_response` | 66 |
| *(op_protocol)* | 5 | | `op_free_statement` | 67 |
| `op_disconnect` | 6 | | `op_prepare_statement` | 68 |
| *(op_credit/continuation)* | 7,8 | | `op_set_cursor` | 69 |
| `op_response` | 9 | | `op_info_sql` | 70 |
| *(page-server ops)* | 10–18 | | `op_dummy` | 71 |
| `op_attach` | 19 | | `op_response_piggyback` | 72 |
| `op_create` | 20 | | `op_start_and_receive` | 73 |
| `op_detach` | 21 | | `op_start_send_and_receive` | 74 |
| `op_compile` | 22 | | `op_exec_immediate2` | 75 |
| `op_start` | 23 | | `op_execute2` | 76 |
| `op_start_and_send` | 24 | | `op_insert` | 77 |
| `op_send` | 25 | | `op_sql_response` | 78 |
| `op_receive` | 26 | | `op_transact` | 79 |
| `op_unwind` | 27 (unused) | | `op_transact_response` | 80 |
| `op_release` | 28 | | `op_drop_database` | 81 |
| `op_transaction` | 29 | | `op_service_attach` | 82 |
| `op_commit` | 30 | | `op_service_detach` | 83 |
| `op_rollback` | 31 | | `op_service_info` | 84 |
| `op_prepare` | 32 | | `op_service_start` | 85 |
| `op_reconnect` | 33 | | `op_rollback_retaining` | 86 |
| `op_create_blob` | 34 | | `op_update_account_info` | 87 |
| `op_open_blob` | 35 | | `op_authenticate_user` | 88 |
| `op_get_segment` | 36 | | `op_partial` | 89 |
| `op_put_segment` | 37 | | `op_trusted_auth` | 90 |
| `op_cancel_blob` | 38 | | `op_cancel` | 91 |
| `op_close_blob` | 39 | | `op_cont_auth` | 92 |
| `op_info_database` | 40 | | `op_ping` | 93 |
| `op_info_request` | 41 | | `op_accept_data` | 94 |
| `op_info_transaction` | 42 | | `op_abort_aux_connection` | 95 |
| `op_info_blob` | 43 | | `op_crypt` | 96 |
| `op_batch_segments` | 44 | | `op_crypt_key_callback` | 97 |
| *(mgr ops)* | 45–47 | | `op_cond_accept` | 98 |
| `op_que_events` | 48 | | `op_batch_create` | 99 |
| `op_cancel_events` | 49 | | `op_batch_msg` | 100 |
| `op_commit_retaining` | 50 | | `op_batch_exec` | 101 |
| `op_prepare2` | 51 | | `op_batch_rls` | 102 |
| `op_event` | 52 | | `op_batch_cs` | 103 |
| `op_connect_request` | 53 | | `op_batch_regblob` | 104 |
| `op_aux_connect` | 54 | | `op_batch_blob_stream` | 105 |
| `op_ddl` | 55 | | `op_batch_set_bpb` | 106 |
| `op_open_blob2` | 56 | | `op_repl_data` | 107 |
| `op_create_blob2` | 57 | | `op_repl_req` | 108 |
| `op_get_slice` | 58 | | `op_batch_cancel` | 109 |
| `op_put_slice` | 59 | | `op_batch_sync` | 110 (P17+) |
| `op_slice` | 60 | | `op_info_batch` | 111 (P17+) |
| `op_seek_blob` | 61 | | `op_fetch_scroll` | 112 (P18+) |
| | | | `op_info_cursor` | 113 (P18+) |
| | | | `op_inline_blob` | 114 (P19+) |

`op_reject`, `op_disconnect`, `op_dummy`, `op_ping`, `op_abort_aux_connection` and
`op_batch_sync` have **no payload** beyond the opcode (`protocol.cpp:312-317, 1092`).

---

## 3. op_connect (client → server)

XDR layout after opcode 1 (`protocol.cpp:319-355`, struct `P_CNCT` `protocol.h:393`):

```
xdr_enum   p_cnct_operation      // always 0 in modern clients (inet.cpp:2850)
xdr_short  p_cnct_cversion       // CONNECT_VERSION3 = 3 (protocol.h:52)
xdr_enum   p_cnct_client         // client architecture; arch_generic ok
xdr_cstring p_cnct_file          // attach path/db-alias (used for routing/config)
xdr_short  p_cnct_count          // number of protocol offers
xdr_cstring p_cnct_user_id       // user identification block (below)
count ×:
  xdr_short  p_cnct_version      // e.g. 0x800D
  xdr_enum   p_cnct_architecture // arch_generic = 1
  xdr_u_short p_cnct_min_type    // 0 (unused)
  xdr_u_short p_cnct_max_type    // ptype_lazy_send(5) | pflag_compress(0x100)?
  xdr_short  p_cnct_weight       // 2,4,6,... (higher wins)
```

### User identification block (`p_cnct_user_id`)

An **un-tagged clumplet buffer**: repeated `[1-byte tag][1-byte length][data]`
(comment `protocol.h:420-430`). Tags (`protocol.h:432-443`):

| Tag | # | Content |
|---|---|---|
| `CNCT_user` | 1 | OS user name (UTF-8, lowercased on Windows) — `inet.cpp:678` |
| `CNCT_passwd` | 2 | (legacy, unused by modern client) |
| `CNCT_host` | 4 | client host name, lowercase UTF-8 — `inet.cpp:683` |
| `CNCT_group` | 5 | effective unix gid, 4 bytes **network order** — `inet.cpp:694` |
| `CNCT_user_verification` | 6 | zero-length tag; “do full user verification” |
| `CNCT_specific_data` | 7 | auth-plugin data (see chunking below) |
| `CNCT_plugin_name` | 8 | name of the plugin that produced specific_data (e.g. `Srp256`) |
| `CNCT_login` | 9 | login as given in DPB (original case, may be `"quoted"`) |
| `CNCT_plugin_list` | 10 | comma/space list of plugins client supports (default `Srp256, Srp, Legacy_Auth`) |
| `CNCT_client_crypt` | 11 | 4-byte **little-endian** int: WireCrypt level 0=DISABLED, 1=ENABLED, 2=REQUIRED (`config.h:81-83`, `remote.cpp:1147`) |

`CNCT_specific_data` chunking (`addMultiPartConnectParameter`, `remote.cpp:1088-1114`):
clumplet data is limited to 255 bytes, so plugin data is split into ≤254-byte pieces, each
piece prefixed with **one byte part number** (0,1,2,...) and emitted as a separate
`CNCT_specific_data` clumplet. Max total 254*256 = 65024 bytes.

For **Srp/Srp256** the phase-1 `CNCT_specific_data` payload is the client SRP public key `A`
as an **uppercase hexadecimal ASCII text** string (libtommath `mp_to_radix` radix-16 output of
`A = g^a mod N`; `SrpClient.cpp:96-98`, `srp.cpp:109-124`).

User name handling: the DPB user name is copied to `cliOrigUserName` (sent verbatim in
`CNCT_login`) and normalized to `cliUserName` via `fb_utils::dpbItemUpper`
(`interface.cpp:10270-10273`, `src/common/utils.cpp:1567`): unquoted names are ASCII-uppercased;
`"quoted"` names get quotes stripped, doubled quotes unescaped, case preserved. **The SRP
computation uses the normalized (uppercased) name**; the server normalizes the wire
`CNCT_login` identically (`server.cpp:7515-7523`).

---

## 4. op_accept / op_accept_data / op_cond_accept (server → client)

`op_accept` (3) — P10..12 answer (`protocol.cpp:357`, `P_ACPT` `protocol.h:447`):

```
xdr_short p_acpt_version        // chosen protocol (e.g. 0x800D); mask with 0x7FFF to compare
xdr_enum  p_acpt_architecture
xdr_u_short p_acpt_type         // ptype | flags
```

`op_accept_data` (94) and `op_cond_accept` (98) — P13+ (`protocol.cpp:365-376`, `P_ACPD`
`protocol.h:456`): the three fields above **plus**:

```
xdr_cstring p_acpt_data          // auth data from server plugin
xdr_cstring p_acpt_plugin        // plugin the server continues with (e.g. "Srp256")
xdr_u_short p_acpt_authenticated // 1 = auth already complete (no more rounds needed)
xdr_cstring p_acpt_keys          // known server crypt keys (clumplet, see §6)
```

- `op_accept_data`: attach may proceed immediately (auth either done —
  `p_acpt_authenticated=1` — or continued in the DPB of op_attach).
- `op_cond_accept`: client **must** finish authentication with `op_cont_auth` round-trips
  before `op_attach` (used e.g. when WireCrypt=Required) — `secureAuthentication`,
  `interface.cpp:7842-7870`.
- If `p_acpt_type & pflag_compress` the server accepted compression: both sides enable zlib
  immediately after this packet (`interface.cpp:8845-8851`, `inet.cpp` after accept).
  Then mask: `p_acpt_type &= ptype_MASK`.

### SRP server data format (`p_acpt_data`)

Parsed in `SrpClient.cpp:106-145`; produced in `SrpServer.cpp:330-343`. It is a flat buffer of
two length-prefixed values (NOT XDR, NOT a clumplet):

```
[2-byte little-endian length][salt]   // ≤ 64 bytes
[2-byte little-endian length][B]      // server public key, ≤ 256 bytes
```

Both values are **hex text strings**: the server loads the 32-byte binary salt from the
security DB and re-encodes it via `BigInteger::getText()` (uppercase hex, no leading zeros —
`SrpServer.cpp:324-325`), same for `B`. The client uses the salt **as the received ASCII
string** in all hashes (it never decodes the hex). Sanity limit: total length ≤
`(SRP_SALT_SIZE + SRP_KEY_SIZE + 2) * 2 = (32+128+2)*2 = 324` bytes (`SrpClient.cpp:113`).

If the packet is an `op_cond_accept`/`op_cont_auth` continuation, the same payload appears in
`p_auth_cont.p_data`.

### op_cont_auth (92)

`P_AUTH_CONT` (`protocol.h:682`, xdr `protocol.cpp:813-823`):

```
xdr_cstring p_data   // plugin-specific data (e.g. SRP proof, hex text)
xdr_cstring p_name   // plugin name (client sends current plugin each time)
xdr_cstring p_list   // plugin list (client sends only on first cont_auth)
xdr_cstring p_keys   // server → client: known crypt keys clumplet; client sends empty
```

Auth loop (`authReceiveResponse`, `interface.cpp:8804-8920`): receive
`op_cont_auth`/`op_cond_accept`/`op_trusted_auth` → feed `p_data` to plugin → send
`op_cont_auth` with plugin answer → repeat until a “normal” packet (usually `op_response` of
the pending `op_attach`) arrives ⇒ auth complete. Any error ⇒ `isc_login`.

---

## 5. SRP (Srp / Srp224 / Srp256 / Srp384 / Srp512)

Files: `src/auth/SecureRemotePassword/srp.{h,cpp}`, `client/SrpClient.cpp`, `server/SrpServer.cpp`.
Design follows RFC 5054 with Firebird-specific hashing quirks.

### Group parameters (`srp.cpp:14-19`)

- Prime `N` (1024-bit, hex):
  ```
  E67D2E994B2F900C3F41F08F5BB2627ED0D49EE1FE767A52EFCD565CD6E76881
  2C3E1E9CE8F0A8BEA6CB13CD29DDEBF7A96D4A93B55D488DF099A15C89DCB064
  0738EB2CBDD9A8F7BAB561AB1B0DC1C6CDABF303264A08D1BCA932D1F1EE428B
  619D970F342ABA9A65793B8B2F041AE5364350C16F735F56ECBCA87BD57B29E7
  ```
- Generator `g = 2`.
- Multiplier `k = SHA1( bytes(N) || 127 zero-pad bytes || 0x02 )` (`RemoteGroup` ctor,
  `srp.cpp:29-46`; g is left-padded with zeros to N's byte length). Numerically:
  `k = 1277432915985975349439481660349303019122249719989`
  (`0xDFC212B4BD69674855CFCEB30002B5C306AC60B5`). **k is always SHA-1**, even for Srp256.

Sizes (`srp.h:108-110`): `SRP_KEY_SIZE = 128` bytes (private keys are 128 random bytes mod N),
`SRP_VERIFIER_SIZE = 128`, `SRP_SALT_SIZE = 32` bytes (binary; travels as ≤64-char hex text).

### Hash usage — which algorithm where

`RemotePassword` has a fixed member `SecureHash<Sha1> hash` (`srp.h:91`). Therefore
**everything below is SHA-1 for ALL plugin variants**:

- user hash `x`
- scramble `u`
- session key `K`
- the inner hashes `H(N)`, `H(g)`, `H(I)` inside the proof

The **only** thing the plugin name changes is the **outer proof hash** `makeProof`
(`RemotePasswordImpl<SHA>`, `srp.h:134-152`): Srp→SHA-1 (20-byte proof), Srp256→SHA-256
(32-byte proof), Srp224/384/512 likewise (`SrpClient.cpp:185-199`). Firebird 3+ servers offer
`Srp256` first by default (`AuthClient = Srp256, Srp, Legacy_Auth`).

### Computations (all big-endian big-integer byte strings)

Notation: `account` = uppercased login; `salt` = the ASCII hex salt string as received;
`password` = plaintext password (case-sensitive); `H` = SHA-1; `HP` = plugin hash (proof only).

- `x = H( salt_string , H( account ":" password ) )` (`getUserHash`, `srp.cpp:85-101`; both
  concatenations are plain byte concatenation; result taken as big-endian integer)
- verifier `v = g^x mod N` (server stores `v` and binary salt per user)
- client: `a` random 128 bytes (mod N), `A = g^a mod N`
- server: `b` random, `B = (k·v + g^b) mod N`
- scramble `u = H( strip(A) || strip(B) )` as integer (`computeScramble`, `srp.cpp:147`),
  where `strip()` removes ONE leading zero byte if present (`processStrippedInt`, `srp.h:72-81`)
- client session secret `S = (B − k·g^x)^(a + u·x) mod N` (`clientSessionKey`, `srp.cpp:157-179`)
- server session secret `S = (A·v^u)^b mod N`
- **session key `K = SHA1( strip(S) )` — 20 bytes** (this is `sessionKey`)
- client proof:
  `M = HP( H(N)^H(g) mod N , H(account) , salt_string , bytes(A) , bytes(B) , K )`
  (`clientProof` `srp.cpp:198-217` + `makeProof` `srp.h:137-151`).
  ⚠️ It is **not** the RFC's `H(N) xor H(g)`: Firebird computes `n1 = H(N)`, `n2 = H(g)`, then
  `n1 = n1.modPow(n2, N)` — i.e. `H(N)^H(g) mod N` — and feeds `processInt(n1)`,
  `processInt(H(account))`, `process(salt)`, `processInt(A)`, `processInt(B)`, `process(K)`.
- The proof `M` is sent as **uppercase hex text** (`cProof.getText(data)`,
  `SrpClient.cpp:152-156`) — in `op_cont_auth.p_data`, or in DPB tag
  `isc_dpb_specific_auth_data` (84) when riding on `op_attach`.
- The server computes the same `M` and compares (`SrpServer.cpp:358-366`); **no server proof
  is ever sent back** — success is implied by the following `op_response`.
- Validation: each side rejects a received public key with `key mod N < 2`
  (`setKey`, `srp.cpp:222-229`).

### Wire-crypt key derivation

None — the 20-byte SHA-1 session key `K` **is** the wire key. The client registers it as a
symmetric key of type `"Symmetric"` (`cKey->setSymmetric(status, "Symmetric", 20, K)`,
`SrpClient.cpp:163-172`); the same 20 bytes key both directions.

### Legacy_Auth (P10–P12 or explicit)

`src/auth/SecurityDatabase/LegacyClient.cpp`: `ENC_crypt(password, "9z")`, skip the first 2
chars of the result, send via DPB `isc_dpb_password_enc` (30). No wirecrypt possible.

---

## 6. WireCrypt & WireCompression

### Server key advertisement

`p_acpt_keys` / `p_auth_cont.p_keys` / (also appended to `p_resp_data` of successful attach
responses) is an un-tagged clumplet buffer (`rem_port::addServerKeys`, `remote.cpp:1329-1364`)
with tags (`remote.h:1024-1027`):

- `TAG_KEY_TYPE = 0` — key type string, e.g. `Symmetric`
- `TAG_KEY_PLUGINS = 1` — space-separated plugin list for the preceding type, e.g. `Arc4 ChaCha`
- `TAG_KNOWN_PLUGINS = 2` — server's auth plugin list (used to re-order client plugins)
- `TAG_PLUGIN_SPECIFIC = 3` — `pluginName\0<data>` — e.g. ChaCha nonce/IV (FB4+)

### op_crypt (96) — starting encryption

`P_CRYPT` (`protocol.h:710`, xdr `protocol.cpp:834`): two cstrings —
`p_plugin` (e.g. `"Arc4"`) and `p_key` (key **type** name, `"Symmetric"`).

Timing (`ClntAuthBlock::tryNewKeys` → `rem_port::tryKeyType`, `remote.cpp:1367-1462`):

1. Auth completes (final `op_response` received — either right after handshake for
   `op_cond_accept`, or as the response to `op_attach`).
2. Client matches its keys against server `TAG_KEY_TYPE/TAG_KEY_PLUGINS`, loads the plugin,
   sets the session key, then sends `op_crypt` **in plaintext**.
3. The server installs the cipher and marks crypt complete **before** sending the `op_response`
   (`start_crypt`, `server.cpp:6619-6699`) ⇒ **the response to op_crypt and everything after it
   from the server is already encrypted**; the client decrypts as soon as its plugin is
   installed, and encrypts everything after it validates that response
   (`inet.cpp:3081` decrypt applies whenever plugin present; `inet.cpp:3157-3164` encrypt only
   when `port_crypt_complete`).
4. With `op_cond_accept` this all happens **before** `op_attach`; with plain `op_accept_data`
   + immediate attach, `op_crypt` is sent right after the attach response.
- If client WireCrypt=DISABLED, no `op_crypt` is sent. If server demanded crypt
  (WIRECRYPT_REQUIRED) and none started, the attach fails.

### RC4 (Arc4 plugin)

`src/plugins/crypt/arc4/Arc4.cpp:38-81`: textbook RC4: KSA over the 20-byte session key
(key bytes cycled over the 256-entry state), separate cipher instances for encrypt/decrypt but
**the same key both directions** (getDecryptKey falls back to the encrypt key,
`remote.cpp:1833-1836`). Key type: `"Symmetric"` (`getKnownTypes`). No IV/specific data.
Encryption operates on the **byte stream** (post-compression), not on packet structures.
FB4+ also ship `ChaCha`/`ChaCha64` plugins (key type `Symmetric`, with `TAG_PLUGIN_SPECIFIC`
nonce); Arc4 is the universal baseline.

### op_crypt_key_callback (97)

`P_CRYPT_CALLBACK` (`protocol.h:716`): `xdr_cstring p_cc_data` + (P14+, or during connect
phase) `xdr_short p_cc_reply` (`protocol.cpp:844-857`). Used for **database** encryption key
callbacks (server→client question, client answers with same opcode). P15+ allows it during the
connect/attach phase (`inet.cpp:760-800`). A driver without keyholder support may reply with
`p_cc_data.length = 0`.

### WireCompression (zlib)

- Negotiated **only** via `pflag_compress` (0x100) OR-ed into `p_cnct_max_type` of each offered
  protocol ≥13 (`inet.cpp:726-733`); accepted when the server sets it in `p_acpt_type`.
  It is *not* in the CNCT clumplets and not in the DPB.
- Framing: one **continuous** zlib deflate stream per direction for the rest of the connection
  (`deflateInit` with `Z_DEFAULT_COMPRESSION` ⇒ standard zlib header; each logical packet flush
  uses `deflate(Z_SYNC_FLUSH)`; receiver runs a streaming `inflate`) —
  `rem_port::initCompression` `remote.cpp:1748`, `REMOTE_deflate/REMOTE_inflate`
  `remote.cpp:1570-1737`. There are no per-packet length headers.
- Order: compress **before** encrypt on send.

---

## 7. DPB (Database Parameter Block)

`src/include/firebird/impl/consts_pub.h:33-140`. Buffer format: 1 version byte then clumplets.

- `isc_dpb_version1 = 1` — `[tag:1][len:1][data:len]`, integers little-endian (VAX order).
- `isc_dpb_version2 = 2` — “wide” clumplets: `[tag:1][len:4 LE][data]` (rarely needed).

Key tags for a driver:

| Tag | # | | Tag | # |
|---|---|---|---|---|
| `isc_dpb_page_size` | 4 | | `isc_dpb_no_db_triggers` | 72 |
| `isc_dpb_num_buffers` | 5 | | `isc_dpb_trusted_auth` | 73 |
| `isc_dpb_dbkey_scope` | 13 | | `isc_dpb_process_name` | 74 |
| `isc_dpb_sweep_interval` | 22 | | `isc_dpb_trusted_role` | 75 |
| `isc_dpb_force_write` | 24 | | `isc_dpb_org_filename` | 76 |
| `isc_dpb_no_reserve` | 27 | | `isc_dpb_utf8_filename` | 77 |
| `isc_dpb_user_name` | 28 | | `isc_dpb_auth_block` | 79 |
| `isc_dpb_password` | 29 | | `isc_dpb_client_version` | 80 |
| `isc_dpb_password_enc` | 30 | | `isc_dpb_remote_protocol` | 81 |
| `isc_dpb_lc_messages` | 47 | | `isc_dpb_host_name` | 82 |
| `isc_dpb_lc_ctype` | 48 | | `isc_dpb_os_user` | 83 |
| `isc_dpb_shutdown` | 50 | | `isc_dpb_specific_auth_data` | 84 |
| `isc_dpb_online` | 51 | | `isc_dpb_auth_plugin_list` | 85 |
| `isc_dpb_connect_timeout` | 57 | | `isc_dpb_auth_plugin_name` | 86 |
| `isc_dpb_dummy_packet_interval` | 58 | | `isc_dpb_config` | 87 |
| `isc_dpb_sql_role_name` | 60 | | `isc_dpb_nolinger` | 88 |
| `isc_dpb_set_page_buffers` | 61 | | `isc_dpb_map_attach` | 90 |
| `isc_dpb_sql_dialect` | 63 | | `isc_dpb_session_time_zone` | 91 (FB4+) |
| `isc_dpb_set_db_readonly` | 64 | | `isc_dpb_set_db_replica` | 92 |
| `isc_dpb_set_db_sql_dialect` | 65 | | `isc_dpb_set_bind` | 93 (FB4+) |
| `isc_dpb_set_db_charset` | 68 | | `isc_dpb_decfloat_round` | 94 (FB4+) |
| `isc_dpb_address_path` | 70 | | `isc_dpb_decfloat_traps` | 95 (FB4+) |
| `isc_dpb_process_id` | 71 | | `isc_dpb_clear_map` | 96 |

FB5+: `isc_dpb_parallel_workers=100`, `isc_dpb_worker_attach=101`, `isc_dpb_owner=102`;
FB5.0.2+/6: `isc_dpb_max_blob_cache_size=103`, `isc_dpb_max_inline_blob_size=104`;
FB6: `isc_dpb_search_path=105`, `isc_dpb_blr_request_search_path=106`,
`isc_dpb_gbak_restore_has_schema=107`.

Notes:
- With P13+ auth: do **not** send `isc_dpb_password`; send `isc_dpb_user_name` (original case),
  `isc_dpb_utf8_filename`, and — if plugin produced data at attach time —
  `isc_dpb_specific_auth_data` + `isc_dpb_auth_plugin_name` + `isc_dpb_auth_plugin_list`
  (`authFillParametersBlock`/`extractDataFromPluginTo`, `interface.cpp:10205-10250`).
- `isc_dpb_lc_ctype` (e.g. `UTF8`) selects the connection charset.
- `isc_dpb_session_time_zone` — string like `America/Sao_Paulo` or `-03:00` (FB4+).

---

## 8. TPB (Transaction Parameter Block)

`consts_pub.h:251-277`. Format: version byte then **bare 1-byte tags** (only
`isc_tpb_lock_timeout`, `isc_tpb_lock_read/write`, `isc_tpb_at_snapshot_number` carry
`[len:1][data]` where ints are little-endian).

- `isc_tpb_version1 = 1`, **`isc_tpb_version3 = 3`** (use 3)
- `isc_tpb_consistency = 1` (table-stability isolation)
- `isc_tpb_concurrency = 2` (snapshot)
- `isc_tpb_shared = 3`, `isc_tpb_protected = 4`, `isc_tpb_exclusive = 5` (table-lock modes)
- `isc_tpb_wait = 6`, `isc_tpb_nowait = 7`
- `isc_tpb_read = 8` (read-only), `isc_tpb_write = 9` (read-write)
- `isc_tpb_lock_read = 10`, `isc_tpb_lock_write = 11` — followed by counted table name
- `isc_tpb_verb_time = 12`, `isc_tpb_commit_time = 13` (unimplemented)
- `isc_tpb_ignore_limbo = 14`
- `isc_tpb_read_committed = 15`
- `isc_tpb_autocommit = 16`
- `isc_tpb_rec_version = 17`, `isc_tpb_no_rec_version = 18` (read_committed variants)
- `isc_tpb_restart_requests = 19`, `isc_tpb_no_auto_undo = 20`
- `isc_tpb_lock_timeout = 21` — `[len=4][int32 LE seconds]` (with `isc_tpb_wait`)
- `isc_tpb_read_consistency = 22` (FB4+ read-committed read-consistency)
- `isc_tpb_at_snapshot_number = 23` (FB4+, `[len][int64 LE]` — shared snapshots)
- `isc_tpb_auto_release_temp_blobid = 24` (FB5+), `isc_tpb_lock_table_schema = 25` (FB6)

Wire: `op_transaction` (29): `xdr_short p_sttr_database` (rdb id) + `xdr_cstring` TPB.
Response `op_response` with transaction handle in `p_resp_object`. Commit/rollback etc. use
`P_RLSE` (`xdr_short` object id). Two-phase: `op_prepare` (32) or `op_prepare2` (51)
(`xdr_short` tr-id + cstring message).

---

## 9. Statement protocol (DSQL)

### Allocate / prepare

- `op_allocate_statement` (62): `P_RLSE` — `xdr_short` = database object id. Response:
  statement handle in `p_resp_object`. (With lazy send, clients defer this and use
  statement id `0xFFFF` piggybacked; simplest is to await response.)
- `op_prepare_statement` (68), `P_SQLST` (`protocol.h:628`, xdr `protocol.cpp:706-722`):

```
xdr_short  p_sqlst_transaction    // 0 = none
xdr_short  p_sqlst_statement
xdr_short  p_sqlst_SQL_dialect    // 1 or 3
xdr_cstring p_sqlst_SQL_str
xdr_cstring p_sqlst_items         // SQL info items to return
xdr_long   p_sqlst_buffer_length  // info buffer size (fixupLength caveat)
[P20+/FB6: xdr_short p_sqlst_flags]   // IStatement::PREPARE_PREFETCH_* bits
```
Response: `op_response` with the info-block in `p_resp_data`.

### SQL info items (`inf_pub.h:480-509`) — request codes

`isc_info_sql_select=4, isc_info_sql_bind=5, isc_info_sql_num_variables=6,
isc_info_sql_describe_vars=7, isc_info_sql_describe_end=8, isc_info_sql_sqlda_seq=9,
isc_info_sql_message_seq=10, isc_info_sql_type=11, isc_info_sql_sub_type=12,
isc_info_sql_scale=13, isc_info_sql_length=14, isc_info_sql_null_ind=15,
isc_info_sql_field=16, isc_info_sql_relation=17, isc_info_sql_owner=18,
isc_info_sql_alias=19, isc_info_sql_sqlda_start=20, isc_info_sql_stmt_type=21,
isc_info_sql_get_plan=22, isc_info_sql_records=23, isc_info_sql_batch_fetch=24,
isc_info_sql_relation_alias=25, isc_info_sql_explain_plan=26, isc_info_sql_stmt_flags=27,
isc_info_sql_stmt_timeout_user=28, isc_info_sql_stmt_timeout_run=29,
isc_info_sql_stmt_blob_align=30` (31–33 are FB6).
Structural codes: `isc_info_end=1, isc_info_truncated=2, isc_info_error=3,
isc_info_data_not_ready=4, isc_info_length=126, isc_info_flag_end=127`.

Info **response** encoding: sequence of `[item:1][len:2 LE][data:len]`; integers little-endian.

Statement types (`inf_pub.h:515-528`): `select=1, insert=2, update=3, delete=4, ddl=5,
get_segment=6, put_segment=7, exec_procedure=8, start_trans=9, commit=10, rollback=11,
select_for_upd=12, set_generator=13, savepoint=14`.

### Message BLR

Parameter/row formats are described by BLR sent in `p_sqlst_blr`/`p_sqldata_blr`
(`src/include/firebird/impl/blr.h`):
`blr_version5=5` (dialect 3; `blr_version4=4` for dialect 1), `blr_begin=2`, `blr_message=4`
followed by message number (1 byte) and field count (2 bytes LE) — count is **2× the column
count** because every column is `[type descriptor][blr_short 0]` (the SSHORT null indicator);
terminated `blr_end=255`, `blr_eoc=76`.
Type codes: `blr_text=14 (len:2LE)`, `blr_varying=37 (len:2LE)`, `blr_short=7 (scale:1)`,
`blr_long=8 (scale:1)`, `blr_quad=9 (scale:1)`, `blr_float=10`, `blr_double=27`,
`blr_d_float=11`, `blr_timestamp=35`, `blr_sql_date=12`, `blr_sql_time=13`, `blr_int64=16
(scale:1)`, `blr_blob2=17 (subtype:2LE, charset:2LE)`, `blr_blob=261`, `blr_bool=23`,
`blr_dec64=24`, `blr_dec128=25`, `blr_int128=26 (scale:1)`, `blr_sql_time_tz=28`,
`blr_timestamp_tz=29`, `blr_ex_time_tz=30`, `blr_ex_timestamp_tz=31`, `blr_text2=15`,
`blr_varying2=38 (charset:2LE, len:2LE)`, `blr_cstring=40`, `blr_blob_id=45`.

### Execute

- `op_execute` (63) / `op_execute2` (76), `P_SQLDATA` (`protocol.h:646`, xdr
  `protocol.cpp:638-680`):

```
xdr_short  p_sqldata_statement
xdr_short  p_sqldata_transaction
xdr_cstring p_sqldata_blr              // input message BLR ('' if no params)
xdr_short  p_sqldata_message_number    // 0
xdr_short  p_sqldata_messages          // 1 if params present, else 0
[if messages: one packed input message — see §10]
[op_execute2 only:]
  xdr_cstring p_sqldata_out_blr        // output BLR for singleton result
  xdr_short  p_sqldata_out_message_number
[P16+: xdr_u_long p_sqldata_timeout]        // statement timeout, ms, 0=none
[P18+: xdr_u_long p_sqldata_cursor_flags]   // bit 0x1 = CURSOR_TYPE_SCROLLABLE
[P19+: xdr_u_long p_sqldata_inline_blob_size]
```

- `op_execute2` is for statements returning a singleton (EXECUTE PROCEDURE / RETURNING):
  server answers `op_sql_response` (78): `xdr_short messages` + (if 1) one packed output
  message, followed by `op_response`.
- Plain `op_execute` is answered by `op_response` (object id = statement, also carries
  affected-rows via subsequent `op_info_sql isc_info_sql_records`).
- `op_exec_immediate` (64)/`op_exec_immediate2` (75) combine prepare+execute using `P_SQLST`
  with statement id `0xFFFF`/-1 semantics (xdr `protocol.cpp:682-722`).

### Fetch

- `op_fetch` (65), same `P_SQLDATA` prefix: statement, output blr (send once; empty afterwards),
  `message_number=0`, `p_sqldata_messages` = **number of rows requested** (prefetch count).
- `op_fetch_scroll` (112, P18+) appends `xdr_short p_sqldata_fetch_op` + `xdr_long
  p_sqldata_fetch_pos` (`protocol.cpp:724-741`). `P_FETCH` (`protocol.h:170-178`):
  `fetch_next=0, fetch_prior=1, fetch_first=2, fetch_last=3, fetch_absolute=4,
  fetch_relative=5`.
- Server replies with a **stream of `op_fetch_response` (66)** packets:
  `xdr_long p_sqldata_status` + `xdr_short p_sqldata_messages`; each packet with
  `messages=1` is followed by exactly one packed row; the batch ends with a packet with
  `messages=0` and `status` = `0` (more rows may be fetched) or **`100` = end of cursor / EOF**
  (`server.cpp:4343`, client check `interface.cpp:8231-8260`). Errors come as `op_response`
  instead.

### Cursor / free

- `op_set_cursor` (69), `P_SQLCUR`: `xdr_short statement` + `xdr_cstring` cursor name
  (NUL-terminated in practice) + `xdr_short type` (0). Response `op_response`.
- `op_free_statement` (67), `P_SQLFREE`: `xdr_short statement` + `xdr_short option`:
  **`DSQL_close = 1`, `DSQL_drop = 2`, `DSQL_unprepare = 4`** (`sqlda_pub.h:29-31`).
- `op_info_sql` (70) uses the generic `P_INFO` layout: `xdr_short object`,
  `xdr_short incarnation(0)`, `xdr_cstring items`, `xdr_long buffer_length`.

---

## 10. Row/message wire format (protocol ≥ 13)

`xdr_packed_message`, `src/remote/protocol.cpp:1604-1735` (P<13 uses `xdr_message`: every
column value followed by its 4-byte null SSHORT — `protocol.cpp:1566`).

1. **Null bitmap** first: one bit per column, `columns = fmt_desc.count / 2`;
   `bytes = (columns + 7) / 8`; bit for column *i* is `byte[i >> 3] & (1 << (i & 7))`
   (LSB-first within each byte); bit set = NULL. The bitmap is sent via `xdr_opaque`, i.e.
   **zero-padded to a multiple of 4 bytes**.
2. Then, for each **non-null** column in order, its value in XDR (null columns are wholly
   skipped). Null-indicator SSHORTs are *not* individually transmitted in P13+.

Per-type encodings (`xdr_datum`, `src/common/xdr.cpp:156-335`; SQL type codes from
`sqlda_pub.h:67-89` — low bit of the SQLDA code is the nullable flag, mask with `~1`):

| SQL type | code | Wire encoding |
|---|---|---|
| `SQL_TEXT` | 452 | `dsc_length` raw bytes (charset-padded), zero-pad to ×4 |
| `SQL_VARYING` | 448 | `xdr_short` length (4 bytes BE!) + `length` bytes + pad to ×4 (`xdr.cpp:184-202`) |
| `SQL_SHORT` | 500 | 4-byte BE int (sign-extended) |
| `SQL_LONG` | 496 | 4-byte BE int |
| `SQL_INT64` | 580 | 8 bytes: high 4 BE, low 4 BE |
| `SQL_FLOAT` | 482 | 4-byte IEEE BE |
| `SQL_DOUBLE` | 480 | 8-byte IEEE BE (high word first) |
| `SQL_D_FLOAT` | 530 | as double |
| `SQL_TYPE_DATE` | 570 | 4-byte BE int — days since **17 November 1858** (Modified-Julian-Date epoch; `NoThrowTimeStamp.cpp:188`). ⚠️ not 1898. |
| `SQL_TYPE_TIME` | 560 | 4-byte BE uint — fractions of a day, **1 unit = 1/10000 s** (`ISC_TIME_SECONDS_PRECISION = 10000`, `dsc_pub.h:74`) |
| `SQL_TIMESTAMP` | 510 | 2×4-byte BE: date then time |
| `SQL_BLOB` | 520 / `SQL_ARRAY` 540 / `SQL_QUAD` 550 | 8-byte quad id (high 4 BE, low 4 BE) |
| `SQL_BOOLEAN` | 32764 | 1 byte (0/1) padded to 4 (`dtype_boolean` → opaque len 1) |
| `SQL_NULL` | 32766 | no data (always in null bitmap) |
| `SQL_INT128` | 32752 (FB4) | 16 bytes as two `xdr_hyper`s: **bytes[8..15] (high hyper) first, then bytes[0..7]** on LE hosts — net effect: full 128-bit big-endian two's-complement (`xdr_int128`, `xdr.cpp:437-447`) |
| `SQL_DEC16` | 32760 (FB4) | Decimal64, 8 bytes via `xdr_decfloat_hyper`: word-swapped (IBM decFloat is PDP-endian-ish; send `temp_long[1]` then `temp_long[0]`; `xdr.cpp:392-427`) |
| `SQL_DEC34` | 32762 (FB4) | Decimal128, 16 bytes: `xdr_decfloat_hyper(bytes[8..15])` then `xdr_decfloat_hyper(bytes[0..7])` |
| `SQL_TIME_TZ` | 32756 (FB4) | `xdr_long` UTC time + `xdr_short` tz-id (each 4 bytes on wire) |
| `SQL_TIMESTAMP_TZ` | 32754 (FB4) | `xdr_long` date + `xdr_long` UTC time + `xdr_short` tz-id |
| `SQL_TIME_TZ_EX` | **32750** (FB4) | time + tz-id + `xdr_short` offset-minutes (`dtype_ex_time_tz`, `xdr.cpp:245-253`) |
| `SQL_TIMESTAMP_TZ_EX` | **32748** (FB4) | date + time + tz-id + `xdr_short` offset (`xdr.cpp:303-313`) |

Time-zone ids (`src/common/TimeZoneUtil.*`): USHORT; `65535 = GMT`; ids ≤ 2878 are fixed
offsets encoded as `offset_minutes + 1439` (`displacementToOffsetZone`,
`TimeZoneUtil.cpp:1170-1173`); larger values (descending from 65535) are ICU region ids.
The time component of `*_TZ` values is **UTC**.

Scaled numerics (NUMERIC/DECIMAL) travel as their storage int type (SHORT/LONG/INT64/INT128)
with negative `sqlscale`.

---

## 11. Response packets & status vector

### op_response (9) / op_response_piggyback (72)

`P_RESP` (`protocol.h:467`, xdr `protocol.cpp:432-443`):

```
xdr_short  p_resp_object     // handle / generic value (4 bytes on wire)
xdr_quad   p_resp_blob_id    // 8 bytes (blob/array ids, tr handles for reconnect)
xdr_cstring p_resp_data      // opaque payload (info buffers, blob segments, auth data, aux address)
status vector                // see below
```

### Status vector encoding (`xdr_status_vector`, `protocol.cpp:2057-2153`)

A sequence of 4-byte BE cluster codes (`src/include/firebird/iberror.h:83-99`):

- `isc_arg_end = 0` — terminator
- `isc_arg_gds = 1` — followed by 4-byte ISC error code
- `isc_arg_string = 2` — followed by XDR string (4-byte len + bytes + pad)
- `isc_arg_cstring = 3` — (not sent on wire by server; converted)
- `isc_arg_number = 4` — followed by 4-byte int
- `isc_arg_interpreted = 5` — XDR string
- `isc_arg_vms=6, isc_arg_unix=7, isc_arg_domain=8, isc_arg_dos=9, isc_arg_mpexl=10,
  isc_arg_mpexl_ipc=11, isc_arg_next_mach=15, isc_arg_netware=16, isc_arg_win32=17` —
  numeric args (4-byte int follows for unix/win32/next_mach)
- `isc_arg_warning = 18` — 4-byte code (warning chain)
- `isc_arg_sql_state = 19` — XDR string (SQLSTATE)

An error is present iff the first cluster is `isc_arg_gds` with a non-zero code (`vector[1]`).
A successful op_response is `isc_arg_gds 0 isc_arg_end` (`1 0 0` = 12 bytes). SQLCODE/SQLSTATE
are derived client-side from the gds codes.

### op_fetch_response (66) & op_sql_response (78)

See §9: `op_fetch_response` = `status(4) + messages(4) [+ row]`, status `100` = EOF/end of
cursor; `op_sql_response` = `messages(4) [+ singleton row]`.

---

## 12. Blob operations

### Open / create

`op_create_blob2` (57) / `op_open_blob2` (56), `P_BLOB` (`protocol.h:532`, xdr
`protocol.cpp:465-477`):

```
xdr_cstring p_blob_bpb        // only for the *2 variants
xdr_short   p_blob_transaction
xdr_quad    p_blob_id         // 0 for create; existing id for open
```
Response: blob handle in `p_resp_object`; for create, blob id in `p_resp_blob_id`.
(`op_create_blob` 34 / `op_open_blob` 35 are the BPB-less legacy forms.)

BPB (`consts_pub.h:284-296`): version byte `isc_bpb_version1 = 1`, then
`[tag:1][len:1][data]`: `isc_bpb_source_type=1, isc_bpb_target_type=2, isc_bpb_type=3,
isc_bpb_source_interp=4, isc_bpb_target_interp=5, isc_bpb_filter_parameter=6,
isc_bpb_storage=7`; values `isc_bpb_type_segmented=0x0, isc_bpb_type_stream=0x1,
isc_bpb_storage_main=0x0, isc_bpb_storage_temp=0x2`.

### Segments

`op_get_segment` (36) / `op_put_segment` (37) / `op_batch_segments` (44), `P_SGMT`
(xdr `protocol.cpp:479-487`):

```
xdr_short   p_sgmt_blob      // blob handle
xdr_short   p_sgmt_length    // buffer size requested (get) / data length (put)
xdr_cstring p_sgmt_segment   // data (empty on get request)
```

- **get**: response is `op_response`; `p_resp_data` contains a packed sequence of
  **counted segments: `[2-byte little-endian length][bytes]`, repeated** (client parsing at
  `interface.cpp:5660-5726`). `p_resp_object` = `1` ⇒ last segment in buffer is a fragment
  (more of the same segment pending), `2` ⇒ blob EOF after this buffer, `0` ⇒ more segments
  available (`interface.cpp:5775-5778`).
- **put**: `p_sgmt_segment` is one raw segment (`p_sgmt_length` = its length).
- **op_batch_segments**: same P_SGMT but the cstring holds **multiple** LE-counted segments
  (2-byte LE length prefixes inside the buffer) — used by clients to push many small segments
  in one packet.

### Seek / close / info

- `op_seek_blob` (61), `P_SEEK`: `xdr_short blob`, `xdr_short mode` (0=from start, 1=relative,
  2=from end), `xdr_long offset`; response `op_response` with new offset in `p_resp_blob_id`
  low part / `p_resp_object`.
- `op_close_blob` (39) / `op_cancel_blob` (38): `P_RLSE` (`xdr_short` handle).
- `op_info_blob` (43) items (`inf_pub.h:442-445`): `isc_info_blob_num_segments=4,
  isc_info_blob_max_segment=5, isc_info_blob_total_length=6, isc_info_blob_type=7`.

### Inline blobs (P19+, FB5.0.2+/6)

`op_inline_blob` (114), `P_INLINE_BLOB` (`protocol.h:783`, xdr `protocol.cpp:1147-1180`):
`xdr_short p_tran_id` + `xdr_quad p_blob_id` + `xdr_cstring p_blob_info` (blob info items) +
blob data buffer (u_long length + bytes, `xdr_blobBuffer`). Sent **unsolicited by the server
before** `op_fetch_response`/`op_sql_response` rows when
`p_sqldata_inline_blob_size > 0`; the client caches blob content keyed by (transaction, blob
id). `MAX_INLINE_BLOB_SIZE = 65535` (`remote.h:107`).

---

## 13. Events

### Registration

`op_que_events` (48), `P_EVENT` (`protocol.h:566`, xdr `protocol.cpp:564-579`):

```
xdr_short   p_event_database   // rdb id
xdr_cstring p_event_items      // EPB (below)
xdr_long    p_event_ast        // ignored (debug only)
xdr_long    p_event_arg        // ignored
xdr_long    p_event_rid        // client-side event id (echoed back in op_event)
```
Response: `op_response`, `p_resp_object` = server event id (pass to `op_cancel_events` (49):
`xdr_short database` + `xdr_long rid`).

EPB version-1 format (`gds__event_block`, `src/yvalve/utl.cpp:1897-1918`;
`EPB_version1 = 1`, `src/jrd/event.h:140`):

```
[1 byte]  1                      // EPB_version1
repeat per event:
  [1 byte]  name length n
  [n bytes] event name
  [4 bytes] count, little-endian // client sends current count (initially 0)
```

### Notification

`op_event` (52) arrives on the **auxiliary channel**: same `P_EVENT` layout — database id,
`p_event_items` = EPB with **updated counts**, junk ast/arg, and `p_event_rid` = the client id
passed in op_que_events. Client diffs counts, re-queues with the new counts to keep listening.

### Auxiliary (async) port

- Client sends `op_connect_request` (53), `P_REQ` (xdr `protocol.cpp:378-385`):
  `xdr_short p_req_type` = **`P_REQ_async = 1`** (`protocol.h:593`), `xdr_short p_req_object`
  = rdb id, `xdr_long p_req_partner` = 0.
- Response: `op_response` where `p_resp_data` is a **raw socket address structure**
  (sockaddr_in/in6). Per `aux_connect` (`inet.cpp:1475-1596`) the client must **ignore the
  host** (NAT) and extract only the **port** — for AF_INET/AF_INET6 that is bytes 2–3 of the
  buffer, big-endian — then TCP-connect to the *original server host* at that port.
  `p_resp_partner` (= `p_resp_blob_id.bid_number`) also carries the partner id.
- No handshake occurs on the aux socket; it is server→client only (`op_event`, `op_dummy`),
  and it inherits the main channel's crypt/compression state at time of creation (aux traffic
  from FB servers is sent through the same port crypt plugin if one was installed —
  serverside creates the async port with the same keys; a plain driver may simply read
  packets and apply the same decryption state machine as negotiated).
- `op_cancel` (91) (P12+) may be sent on the **main** socket asynchronously: payload
  `xdr_short p_co_kind`: `fb_cancel_disable=1, fb_cancel_enable=2, fb_cancel_raise=3,
  fb_cancel_abort=4` (`consts_pub.h:783-786`).

---

## 14. FB4 / FB5 additions relevant to a driver

### Timeouts

- **Statement timeout**: `p_sqldata_timeout` (ms) in `op_execute/op_execute2` — P16+ only
  (`protocol.cpp:673-674`). Query current values via `op_info_sql` items 28/29.
- **Session idle timeout**: no wire field — set via SQL (`SET SESSION IDLE TIMEOUT`) or read
  via `op_info_database` items `fb_info_ses_idle_timeout_db=129/att=130/run=131`;
  statement timeout db/att = 135/136; `fb_info_protocol_version=137`,
  `fb_info_crypt_plugin=138`, `fb_info_wire_crypt=140`, `fb_info_features=141`
  (`inf_pub.h:146-199`).
- `fb_info_features` response values (`inf_pub.h:207-218`): `multi_statements=1,
  multi_transactions=2, named_parameters=3, session_reset=4, read_consistency=5,
  statement_timeout=6, statement_long_life=7`.

### Session reset

`ALTER SESSION RESET` is plain SQL (no dedicated opcode); feature flag 4 above signals support
(FB4+).

### Batch API (FB4+, P16; sync/info P17)

Flow: `op_batch_create` → N × `op_batch_msg` (+ blob ops) → `op_batch_exec` →
`op_batch_cs` (completion state) → `op_batch_rls`.

- `op_batch_create` (99), `P_BATCH_CREATE` (xdr `protocol.cpp:859-870`): `xdr_short statement`,
  `xdr_cstring blr` (input message format), `xdr_u_long p_batch_msglen` (aligned message
  length), `xdr_cstring p_batch_pb` — parameters block, version byte `IBatch::VERSION1 = 1`
  then clumplets with tags (`FirebirdInterface.idl:539-560`): `TAG_MULTIERROR=1,
  TAG_RECORD_COUNTS=2, TAG_BUFFER_BYTES_SIZE=3, TAG_BLOB_POLICY=4, TAG_DETAILED_ERRORS=5`;
  blob policies `BLOB_NONE=0, BLOB_ID_ENGINE=1, BLOB_ID_USER=2, BLOB_STREAM=3`.
- `op_batch_msg` (100), `P_BATCH_MSG` (xdr `protocol.cpp:872-936`): `xdr_short statement`,
  `xdr_u_long messages`, then that many **packed messages** (null bitmap + values, §10);
  receiver-side buffer stride = `FB_ALIGN(fmt_length, 8)`.
- `op_batch_exec` (101): `xdr_short statement` + `xdr_short transaction`.
- `op_batch_cs` (103) response (xdr `protocol.cpp:950-1089`): `xdr_short statement`,
  `xdr_u_long reccount`, `xdr_u_long updates` (count of per-record update counters),
  `xdr_u_long vectors` (count of `[u_long recno][status vector]` pairs), `xdr_u_long errors`
  (count of `u_long` recnos without vectors); then the three arrays in that order.
- `op_batch_rls` (102) / `op_batch_cancel` (109): `P_RLSE`. (`rls` answered by op_response,
  deferrable.)
- `op_batch_sync` (110, P17+): opcode only; forces server to flush pending batch responses.
- `op_info_batch` (111, P17+): generic `P_INFO`; item `IBatch::INF_BUFFER_BYTES_SIZE=10` etc.
- Blobs in batch: `op_batch_regblob` (104): `xdr_short statement` + `xdr_quad exist_id` +
  `xdr_quad blob_id`; `op_batch_blob_stream` (105): `xdr_short statement` + blob stream —
  `xdr_u_long` total length then a stream aligned to `BLOB_STREAM_ALIGN = 4`
  (`src/dsql/DsqlBatch.h:60`), each blob = header `[8-byte quad id][u_long blob total
  size][u_long bpb size]` + BPB + data (segmented blobs: inner `[2-byte LE length][segment]`),
  headers 4-aligned within the stream (`xdr_blob_stream`, `protocol.cpp:1244+`);
  `op_batch_set_bpb` (106): `xdr_short statement` + `xdr_cstring` default BPB.

### Scrollable cursors (FB5, P18)

- `op_execute` gains `p_sqldata_cursor_flags`; set `0x1` (`IStatement::CURSOR_TYPE_SCROLLABLE`,
  `FirebirdInterface.idl:496`) to open scrollable.
- `op_fetch_scroll` (112) with `P_FETCH` op + position (§9); `op_info_cursor` (113, P18+)
  for cursor info items.

### Compression flag

`pflag_compress = 0x100` OR-ed into `p_cnct_max_type` per offer; echoed by server in
`p_acpt_type` (§6). FB3.0.1+ (both ends need zlib built in).

### FB6 / P20 look-ahead (present in this tree)

`p_sqlst_flags` (prepare flags) appended to `op_prepare_statement` / `op_exec_immediate*`;
11th protocol offer slot; `isc_dpb_search_path`; schema-aware items
(`isc_info_sql_relation_schema=33`). A FB3/4/5 driver can ignore all of this.

---

## Appendix A — canonical client call flow (P13+, e.g. FB3+)

```
TCP connect :3050
→ op_connect (offers P13..P19, user_id: CNCT_login/plugin_name=Srp256/plugin_list/
              CNCT_specific_data=hex(A)/CNCT_client_crypt/CNCT_user/CNCT_host)
← op_accept_data | op_cond_accept   (salt+B in p_acpt_data, plugin, authenticated?, keys)
   [op_cond_accept:]
   → op_cont_auth (p_data = hex(M) proof)          — repeat as needed
   ← op_response (auth ok; server keys in p_resp_data)
   → op_crypt ("Arc4"/"Symmetric")                 — plaintext
   ← op_response                                   — already RC4-encrypted
→ op_attach (file, DPB[user_name, lc_ctype, specific_auth_data?, ...])
← op_response (rdb id)          [for op_accept_data path: op_cont_auth loop may wrap this,
                                 then op_crypt happens here]
→ op_transaction (TPB)          ← op_response (tr handle)
→ op_allocate_statement         ← op_response (stmt handle)
→ op_prepare_statement (items: stmt_type, select/bind describe_vars...) ← op_response(info)
→ op_execute (blr + packed params)                ← op_response
→ op_fetch (n rows)             ← op_fetch_response × k (status 100 at EOF)
→ op_free_statement (DSQL_drop) ← op_response
→ op_commit                     ← op_response
→ op_detach ← op_response 