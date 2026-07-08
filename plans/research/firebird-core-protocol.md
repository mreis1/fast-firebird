# Firebird Wire Protocol — Core Reference (clean-room, for FB 3/4/5 TS driver)

Authoritative reference distilled from the official Firebird server source cloned at
`references/firebird` (build FORMAL BUILD NUMBER 2070,
`PRODUCT_VER_STRING "6.0.0.2070"`, branch `master`). All values are quoted with file + line
context. FB6 is a superset; everything through PROTOCOL_VERSION19 applies to FB3/4/5, and
PROTOCOL_VERSION20 is FB6-only (noted where relevant).

Key files:
- `src/remote/protocol.h` — packet structs, opcodes, protocol versions, arch, ptype
- `src/remote/protocol.cpp` — `xdr_protocol()` wire (de)serialization of every packet
- `src/common/xdr.cpp` — primitive XDR encoders (`xdr_datum`, `xdr_long`, `xdr_hyper`, ...)
- `src/remote/inet.cpp` — connect handshake, aux port, socket send/receive, crypt hookpoint
- `src/remote/remote.cpp` — ClntAuthBlock, wire crypt startup (`tryKeyType`), zlib framing
- `src/remote/client/interface.cpp` — full client state machine (auth, attach, fetch, blob)
- `src/remote/server/server.cpp` — server-side counterpart (`start_crypt`, fetch response)
- `src/auth/SecureRemotePassword/` — SRP (`srp.cpp`, `srp.h`, `client/SrpClient.cpp`, `server/SrpServer.cpp`)
- `src/plugins/crypt/arc4/Arc4.cpp` — RC4 wire crypt plugin
- `src/include/firebird/impl/` — `consts_pub.h`, `inf_pub.h`, `sqlda_pub.h`, `blr.h`, `dsc_pub.h`

---

## 0. Transport framing fundamentals

Every packet is a sequence of XDR-encoded fields. Firebird uses **classic Sun XDR wire rules**
(`src/common/xdr.cpp`):

- **Byte order: big-endian** on the wire. `GETLONG`/`PUTLONG` call `ntohl`/`htonl` unless
  `xdrs->x_local` is set (local/same-machine optimization — never true for a network client).
  A TS driver over TCP must always use big-endian.
- **All integral XDR units are 4 bytes.** `xdr_short`, `xdr_u_short`, `xdr_int`, `xdr_enum`
  all serialize as a 4-byte big-endian long (`xdr_short` writes `SLONG temp = *ip; PUTLONG`).
  So a `USHORT` on the wire occupies 4 bytes. `P_OP` operation code = `xdr_enum` = 4 bytes.
- **64-bit (`xdr_hyper`) is sent low-long-first then high-long** on little-endian hosts, i.e.
  the two 32-bit halves are emitted in the order `[1]` then `[0]` (`src/common/xdr.cpp:110-153`).
  Each half is itself big-endian. Net effect for INT64: it is **not** a plain 8-byte big-endian
  integer; it is two big-endian 32-bit words with the *low* word first. (See §10.)
- **`xdr_quad` (blob/array id, SQUAD)**: high long then low long, each big-endian
  (`src/common/xdr.cpp:585`). Different word order from `xdr_hyper`. Used for blob IDs.
- **`xdr_double`**: two longs, order `FB_LONG_DOUBLE_FIRST`/`SECOND` (platform macro; on
  little-endian these select the natural halves) each via `PUTLONG` (big-endian).
- **`xdr_float`**: reinterpret the 4 float bytes as SLONG, `PUTLONG` (big-endian).
- **Padding to 4 bytes.** `xdr_opaque` and `xdr_cstring` pad every payload up to a 4-byte
  boundary with zero filler: `l = (4 - len) & 3` (`src/common/xdr.cpp:559`, `protocol.cpp:1422`).
- **cstring encoding**: `xdr_long(length)` then `length` raw bytes then pad to 4
  (`src/remote/protocol.cpp:1385-1445`). Length field was `USHORT` historically; `fixupLength()`
  (`protocol.cpp:127`) masks a decoded length whose top 16 bits are all-ones down to 16 bits
  (handles old servers sign-extending a 16-bit length).

Default TCP port: **3050**, service name `gds_db` (`src/remote/inet.cpp:1005-1009`,
`FB_SERVICE_PORT`/`FB_SERVICE_NAME`).

---

## 1. Protocol versions

From `src/remote/protocol.h:52-120`.

```
CONNECT_VERSION3    = 3          // p_cnct_cversion value sent in op_connect

FB_PROTOCOL_FLAG    = 0x8000     // OR'd into version >= 11 to separate from Borland Interbase
FB_PROTOCOL_MASK    = 0x7FFF     // ~FB_PROTOCOL_FLAG

PROTOCOL_VERSION10  = 10         = 0x000A   (no flag)
PROTOCOL_VERSION11  = 0x8000|11  = 0x800B  = 32779
PROTOCOL_VERSION12  = 0x8000|12  = 0x800C  = 32780
PROTOCOL_VERSION13  = 0x8000|13  = 0x800D  = 32781
PROTOCOL_VERSION14  = 0x8000|14  = 0x800E  = 32782
PROTOCOL_VERSION15  = 0x8000|15  = 0x800F  = 32783
PROTOCOL_VERSION16  = 0x8000|16  = 0x8010  = 32784
PROTOCOL_VERSION17  = 0x8000|17  = 0x8011  = 32785
PROTOCOL_VERSION18  = 0x8000|18  = 0x8012  = 32786
PROTOCOL_VERSION19  = 0x8000|19  = 0x8013  = 32787
PROTOCOL_VERSION20  = 0x8000|20  = 0x8014  = 32788   // FB6 only
```

Convenience aliases (protocol.h):
- `PROTOCOL_STMT_TOUT   = PROTOCOL_VERSION16` (statement timeout support gate)
- `PROTOCOL_FETCH_SCROLL= PROTOCOL_VERSION18`
- `PROTOCOL_INLINE_BLOB = PROTOCOL_VERSION19`
- `PROTOCOL_PREPARE_FLAG= PROTOCOL_VERSION20`

**Note on the accept/version echo:** the server returns `p_acpt_version` via `xdr_short`
(`protocol.cpp:359,368`). Because p11+ have bit 0x8000 set, this is a negative SSHORT on the
wire; treat it as an unsigned 16-bit value. On the wire it is still a 4-byte big-endian long
whose low 16 bits carry the version. Compare with `& FB_PROTOCOL_MASK` to get 11..20 and test
`& FB_PROTOCOL_FLAG` to confirm it is a Firebird (not Borland) protocol.

What each version adds (comments in protocol.h):
- **10**: warnings supported; no more status-code encode/decode.
- **11**: user-authentication ops (`op_update_account_info`, `op_authenticate_user`,
  `op_trusted_auth`). First version with `FB_PROTOCOL_FLAG`.
- **12**: async `op_cancel`.
- **13**: **authentication plugins** (`op_cont_auth`), and **packed (NULL-aware) SQL messages**
  (see §10). This is the first version a modern SRP + wire-crypt client should target.
- **14**: fixes a bug in the database crypt-key callback. Wire effect: in
  `op_crypt_key_callback` the `p_cc_reply` short is only present when
  `port_protocol >= PROTOCOL_VERSION14` (or protocol==0 during connect, meaning server is >=p15)
  (`protocol.cpp:844-857`).
- **15**: supports crypt-key callback **at connect phase** (before attach).
- **16**: statement timeouts. Gates the extra `p_sqldata_timeout` u_long in op_execute/execute2
  (`protocol.cpp:673-674`).
- **17**: `op_batch_sync`, `op_info_batch`.
- **18**: `op_fetch_scroll`. Gates `p_sqldata_cursor_flags` u_long in op_execute
  (`protocol.cpp:675-676`) and the fetch op/pos fields (`protocol.cpp:735-739`).
- **19**: `op_inline_blob`. Gates `p_sqldata_inline_blob_size` u_long in op_execute/exec_immediate2
  (`protocol.cpp:677-678`, `701-702`).
- **20** (FB6): flags to `IStatement::prepare`. Gates `p_sqlst_flags` short in
  op_prepare_statement (`protocol.cpp:718-719`).

Which release supports which (from the version comments / historical mapping):
- FB 2.1 → protocol 11
- FB 2.5 → protocol 12
- FB 3.0 → protocol 13 (SRP + wire crypt + packed messages introduced here)
- FB 4.0 → protocols 15/16 (crypt-at-connect, statement timeouts) plus 13/14
- FB 5.0 → protocols 17/18/19 (batch sync/info, scroll, inline blob)
- FB 6.0 → protocol 20

### Architecture (`P_ARCH`, protocol.h:124-143)
```
arch_generic     = 1     // canonical forms — a portable client ALWAYS sends this
arch_sun         = 3
arch_sun4        = 8
arch_sunx86      = 9
arch_hpux        = 10
arch_rt          = 14
arch_intel_32    = 29
arch_linux       = 36
arch_freebsd     = 37
arch_netbsd      = 38
arch_darwin_ppc  = 39
arch_winnt_64    = 40
arch_darwin_x64  = 41
arch_darwin_ppc64= 42
arch_arm         = 43
arch_winnt_arm64 = 44
arch_max         = 45
```
A clean-room client should send `arch_generic (1)` both as `p_cnct_client` and in every
`p_cnct_versions[i].p_cnct_architecture` (that is exactly what `REMOTE_PROTOCOL(...)` macro
does — see §3). Using arch_generic forces canonical/portable XDR (server never enables
`PORT_symmetric`), which is what we want.

### Protocol types (`p_acpt_type`, protocol.h:145-156)
```
ptype_batch_send  = 3    // batch sends, no asynchrony
ptype_out_of_band = 4    // batch sends w/ out-of-band notification
ptype_lazy_send   = 5    // deferred packet delivery  <-- client offers this (see §3)
ptype_MASK        = 0xFF // low byte = type; up to 255 types
```
Upper byte of `p_acpt_type`/`p_cnct_max_type` carries **protocol flags**:
```
pflag_compress    = 0x100   // enable zlib wire compression if possible
pflag_win_sspi_nego = 0x200 // Win_SSPI Negotiate package support
```
The type field is masked with `ptype_MASK` after reading flags (`interface.cpp:8848`).

Statement flags (protocol.h:166-168): `STMT_NO_BATCH = 2`, `STMT_DEFER_EXECUTE = 4`.

Object handle limits: `MAX_OBJCT_HANDLES = 65000`, `INVALID_OBJECT = MAX_USHORT (0xFFFF)`.

---

## 2. Full opcode table (`P_OP`, protocol.h:184-341)

Sent as `xdr_enum` (4-byte big-endian). `//` marks values commented-out/obsolete in the header.

```
op_void              = 0    packet voided
op_connect           = 1    client -> server: connect
op_exit              = 2
op_accept            = 3    server accepts (no data)
op_reject            = 4
//op_protocol        = 5
op_disconnect        = 6
//op_credit          = 7
//op_continuation    = 8
op_response          = 9    generic response block
// 10..18 obsolete page-server ops
op_attach            = 19
op_create            = 20
op_detach            = 21
op_compile           = 22
op_start             = 23
op_start_and_send    = 24
op_send              = 25
op_receive           = 26
op_unwind            = 27
op_release           = 28
op_transaction       = 29
op_commit            = 30
op_rollback          = 31
op_prepare           = 32
op_reconnect         = 33
op_create_blob       = 34
op_open_blob         = 35
op_get_segment       = 36
op_put_segment       = 37
op_cancel_blob       = 38
op_close_blob        = 39
op_info_database     = 40
op_info_request      = 41
op_info_transaction  = 42
op_info_blob         = 43
op_batch_segments    = 44    put a bunch of blob segments
// 45..47 obsolete mgr ops
op_que_events        = 48
op_cancel_events     = 49
op_commit_retaining  = 50
op_prepare2          = 51
op_event             = 52    async event delivery (server -> client aux channel)
op_connect_request   = 53    request to establish aux connection
op_aux_connect       = 54
op_ddl               = 55
op_open_blob2        = 56
op_create_blob2      = 57
op_get_slice         = 58
op_put_slice         = 59
op_slice             = 60    successful get_slice response
op_seek_blob         = 61
op_allocate_statement= 62
op_execute           = 63
op_exec_immediate    = 64
op_fetch             = 65
op_fetch_response    = 66
op_free_statement    = 67
op_prepare_statement = 68
op_set_cursor        = 69
op_info_sql          = 70
op_dummy             = 71    keepalive/ping-ish
op_response_piggyback= 72
op_start_and_receive = 73
op_start_send_and_receive = 74
op_exec_immediate2   = 75
op_execute2          = 76
op_insert            = 77
op_sql_response      = 78    response from execute/exec-immediate/insert
op_transact          = 79
op_transact_response = 80
op_drop_database     = 81
op_service_attach    = 82
op_service_detach    = 83
op_service_info      = 84
op_service_start     = 85
op_rollback_retaining= 86
op_update_account_info = 87   (vulcan p11 legacy)
op_authenticate_user = 88     (vulcan p11 legacy)
op_partial           = 89    packet not complete - delay processing
op_trusted_auth      = 90
op_cancel            = 91
op_cont_auth         = 92    continue authentication (p13+)
op_ping              = 93
op_accept_data       = 94    accept + auth data (p13+)
op_abort_aux_connection = 95
op_crypt             = 96    start wire crypt
op_crypt_key_callback= 97    db crypt key callback
op_cond_accept       = 98    accept + data + ask client to continue auth before attach
op_batch_create      = 99
op_batch_msg         = 100
op_batch_exec        = 101
op_batch_rls         = 102
op_batch_cs          = 103   batch completion state
op_batch_regblob     = 104
op_batch_blob_stream = 105
op_batch_set_bpb     = 106
op_repl_data         = 107
op_repl_req          = 108
op_batch_cancel      = 109
op_batch_sync        = 110   (p17+)
op_info_batch        = 111   (p17+)
op_fetch_scroll      = 112   (p18+)
op_info_cursor       = 113
op_inline_blob       = 114   (p19+)
op_max
```

Packets with **no body** (only the op enum): `op_reject, op_disconnect, op_dummy, op_ping,
op_abort_aux_connection` (`protocol.cpp:312-317`) and `op_batch_sync` (`protocol.cpp:1092`).

---

## 3. op_connect (client → server)

Struct `P_CNCT` (protocol.h:393-409) and wire layout in `xdr_protocol` case `op_connect`
(`protocol.cpp:319-355`). `MAX_CNCT_VERSIONS = 11` (servers before FB6 use only first 10).

Wire order (each integer = 4-byte big-endian; each cstring = len(4) + bytes + pad4):
```
xdr_enum   p_operation        = op_connect (1)
xdr_enum   p_cnct_operation   = 0            (unused, set 0 by inet_try_connect:2850)
xdr_short  p_cnct_cversion    = CONNECT_VERSION3 (3)
xdr_enum   p_cnct_client      = arch_generic (1)   (ARCHITECTURE, but generic on wire via macro)
cstring    p_cnct_file        = database path/alias (UTF-8, unescaped)
xdr_short  p_cnct_count       = number of protocol-version entries that follow
cstring    p_cnct_user_id     = "user identification" clumplet buffer (see below)
repeat p_cnct_count times {
    xdr_short p_cnct_version       // one of PROTOCOL_VERSIONnn
    xdr_enum  p_cnct_architecture  // arch_generic (1)
    xdr_u_short p_cnct_min_type    // 0
    xdr_u_short p_cnct_max_type    // ptype_lazy_send (5), OR'd with pflag_compress if offered
    xdr_short p_cnct_weight        // preference weight
}
```

The offered protocol list (`src/remote/inet.cpp:711-729`), built by macro
`REMOTE_PROTOCOL(version, type, weight)` = `{version, arch_generic, 0, type, weight*2}`:
```
REMOTE_PROTOCOL(PROTOCOL_VERSION10, ptype_lazy_send, 1)   // max_type=5, weight=2
REMOTE_PROTOCOL(PROTOCOL_VERSION11, ptype_lazy_send, 2)
REMOTE_PROTOCOL(PROTOCOL_VERSION12, ptype_lazy_send, 3)
REMOTE_PROTOCOL(PROTOCOL_VERSION13, ptype_lazy_send, 4)
REMOTE_PROTOCOL(PROTOCOL_VERSION14, ptype_lazy_send, 5)
REMOTE_PROTOCOL(PROTOCOL_VERSION15, ptype_lazy_send, 6)
REMOTE_PROTOCOL(PROTOCOL_VERSION16, ptype_lazy_send, 7)
REMOTE_PROTOCOL(PROTOCOL_VERSION17, ptype_lazy_send, 8)
REMOTE_PROTOCOL(PROTOCOL_VERSION18, ptype_lazy_send, 9)
REMOTE_PROTOCOL(PROTOCOL_VERSION19, ptype_lazy_send, 10)
REMOTE_PROTOCOL(PROTOCOL_VERSION20, ptype_lazy_send, 11)   // FB6
```
`p_cnct_min_type` is always 0. `p_cnct_max_type` = `ptype_lazy_send (5)`; the client sets
`|= pflag_compress (0x100)` on each entry with version >= 13 when compression is desired and
zlib is available (`inet.cpp:726-729`). Weight passed to macro is doubled (`weight*2`), so the
highest-version protocol gets the highest weight; the server picks the highest mutually
acceptable version/weight.

`p_cnct_weight` on wire is `xdr_short`. `p_cnct_min_type`/`p_cnct_max_type` are `xdr_u_short`.

### User-identification buffer (`p_cnct_user_id`)

An **untagged clumplet list** (`ClumpletWriter(UnTagged, 64000)`), each item:
```
<UCHAR type> <UCHAR length> <length bytes of data>
```
(protocol.h:420-443, comment; assembled in `inet.cpp:658-694` and `remote.cpp:1116-1148`).

CNCT tag codes (protocol.h:432-443):
```
CNCT_user            = 1    OS user name (UTF-8, lowercased on Windows) — inet.cpp:678
CNCT_passwd          = 2
//CNCT_ppo           = 3    obsolete
CNCT_host            = 4    host name (lowercased, UTF-8) — inet.cpp:683
CNCT_group           = 5    effective unix gid (htonl'd 4 bytes) — inet.cpp:694
CNCT_user_verification = 6  present (tag only, no data) when uv/attach-with-verify — inet.cpp:686
CNCT_specific_data   = 7    plugin-generated auth data (multi-part, see below)
CNCT_plugin_name     = 8    name of the plugin that generated CNCT_specific_data
CNCT_login           = 9    same value as isc_dpb_user_name (original, non-uppercased login)
CNCT_plugin_list     = 10   comma/space list of client-available auth plugins
CNCT_client_crypt    = 11   client wire-crypt level (int): 0=DISABLED 1=ENABLED 2=REQUIRED
```

Assembly order the reference client uses (`remote.cpp:1116-1148`, `inet.cpp:658-694`):
1. `CNCT_user` (OS user), `CNCT_host`, then either `CNCT_user_verification` or `CNCT_group`.
2. `CNCT_login` (original login, if present).
3. `CNCT_plugin_name` (current plugin name, e.g. `"Srp256"`).
4. `CNCT_plugin_list` (e.g. `"Srp256,Srp,Legacy_Auth"`).
5. `CNCT_specific_data` — the plugin's first-phase data, **split into 254-byte parts**.
6. `CNCT_client_crypt` — `insertInt` of the wire-crypt level.

`CNCT_client_crypt` is written with `insertInt` (a clumplet int; little-endian VAX-order bytes
inside the clumplet — it is *not* an XDR field, it is inside the opaque clumplet buffer).
Values: `WIRE_CRYPT_DISABLED=0, WIRE_CRYPT_ENABLED=1, WIRE_CRYPT_REQUIRED=2`
(`src/common/config/config.h:81-83`).

#### CNCT_specific_data multi-part encoding (`addMultiPartConnectParameter`, remote.cpp:1088-1113)
A single clumplet item is limited to 255 data bytes. The plugin's `dataFromPlugin` blob is
split into chunks of at most **254** bytes. Each `CNCT_specific_data` clumplet's data is:
```
<UCHAR part_index> <up to 254 bytes of plugin data>
```
`part_index` starts at 0 and increments per chunk. Chunks may arrive in any order; server
reassembles by index. Total supported ≤ 254*256 = 65024 bytes. For SRP phase-1 (a ~128-byte
public key rendered as hex, so ~256 chars) this yields 2 parts (index 0 and 1).

#### What SRP puts in CNCT_specific_data (login/phase-1)
The Srp client's first `authenticate()` call (`SrpClient.cpp:86-104`) generates the client
public key A and stores its **hex text** as the plugin data:
```
client->genClientKey(data);            // data = hex text of A (BigInteger::getText, radix 16)
cb->putData(status, data.length(), data.begin());   // this becomes dataFromPlugin
```
So `CNCT_specific_data` (reassembled) = ASCII hex string of the client public key A.
`CNCT_plugin_name` = `"Srp"` or `"Srp256"` etc. `CNCT_login` = the login as typed.

---

## 4. op_accept / op_accept_data / op_cond_accept (server → client)

### op_accept (3) — `P_ACPT` (protocol.h:447-452), wire `protocol.cpp:357-363`
```
xdr_short   p_acpt_version       // negotiated PROTOCOL_VERSIONnn (test with FB_PROTOCOL_MASK)
xdr_enum    p_acpt_architecture  // server arch
xdr_u_short p_acpt_type          // low byte = ptype_*, high byte = pflags (compress etc.)
```
This is returned for legacy/no-auth-data path (protocol <13 or no continued auth).

### op_accept_data (94) and op_cond_accept (98) — `P_ACPD` (protocol.h:456-463)
`p_acpd` extends `p_acpt` with four cstrings. Wire (`protocol.cpp:365-376`):
```
xdr_short   p_acpt_version
xdr_enum    p_acpt_architecture
xdr_u_short p_acpt_type
cstring     p_acpt_data          // server auth data for the plugin (SRP salt+B, see below)
cstring     p_acpt_plugin        // name of plugin to continue with
xdr_u_short p_acpt_authenticated // 1 = auth complete in a single step, else 0
cstring     p_acpt_keys          // keys known to the server (wire-crypt key catalogue)
```

- **op_accept_data**: normal case; if `p_acpt_authenticated == 1` the client is already
  authenticated and proceeds to attach. The client stores `p_acpt_data` for the plugin,
  records `authComplete = p_acpt_authenticated`, and calls `addServerKeys(p_acpt_keys)`
  (`inet.cpp:755-760`).
- **op_cond_accept**: server accepts the connection AND requires the client to continue the
  auth exchange (via `op_cont_auth`) **before** the attach call. Same fields as op_accept_data.
  If `p_acpt_type & pflag_compress`, the client turns on compression immediately
  (`interface.cpp:8840-8850`), then masks type with `ptype_MASK`.

#### Format of `p_acpt_data` for SRP (salt + server public key B)
Built by `SrpServer` (`server/SrpServer.cpp:329-341`) — a flat byte buffer, **not** XDR, with
two little-endian 16-bit length prefixes:
```
[salt_len_lo][salt_len_hi]  salt bytes (hex text of salt)
[key_len_lo ][key_len_hi ]  server-pubkey bytes (hex text of B)
```
i.e.:
```
data  = char(salt.length());          // low byte
data += char(salt.length() >> 8);     // high byte
data += salt;                          // salt as hex text (BigInteger::getText)
data += char(serverPubKey.length());
data += char(serverPubKey.length() >> 8);
data += serverPubKey;                  // B as hex text
```
The client parses it symmetrically (`SrpClient.cpp:106-142`): read 2-byte LE `charSize` for salt,
read that many bytes; then 2-byte LE `charSize` for key, read that many bytes. Both salt and key
are **ASCII hex strings** (they are decoded via `BigInteger(text, radix=16)` / `setKey`).
Expected max length: `(SRP_SALT_SIZE + SRP_KEY_SIZE + 2) * 2` = `(32 + 128 + 2)*2 = 324`
(`SrpClient.cpp:113-114`), and salt hex ≤ `SRP_SALT_SIZE*2 = 64` chars.

#### `p_acpt_keys` — server key catalogue (untagged clumplets)
Parsed by `rem_port::addServerKeys` (`remote.cpp:1329-1364`). Tag codes (remote.h:1024-1027):
```
TAG_KEY_TYPE       = 0   // key "type" string (== auth plugin name that produced the key)
TAG_KEY_PLUGINS    = 1   // space-delimited list of wire-crypt plugins usable with this key
TAG_KNOWN_PLUGINS  = 2   // (used in auth plugin-list negotiation)
TAG_PLUGIN_SPECIFIC= 3   // per-plugin specific data: "<pluginname>\0<databytes>"
```
A `KEY_TYPE` establishes the current type; the following `KEY_PLUGINS` creates a key entry
`{type, " plugins "}` (space-wrapped for substring matching). `PLUGIN_SPECIFIC` carries
IV/nonce-style data for a named plugin (e.g. ChaCha), stored as
`pluginName '\0' specificData`.

---

## 5. SRP authentication (`src/auth/SecureRemotePassword/`)

RFC 5054 SRP-6a. Group constants (`srp.cpp:14-19`):

**Prime N (1024-bit, hex):**
```
E67D2E994B2F900C3F41F08F5BB2627ED0D49EE1FE767A52EFCD565C
D6E768812C3E1E9CE8F0A8BEA6CB13CD29DDEBF7A96D4A93B55D488D
F099A15C89DCB0640738EB2CBDD9A8F7BAB561AB1B0DC1C6CDABF303
264A08D1BCA932D1F1EE428B619D970F342ABA9A65793B8B2F041AE5
364350C16F735F56ECBCA87BD57B29E7
```
(concatenate — it is one 256-hex-char / 128-byte number). **Generator g = 2** (`genStr = "02"`).

**Multiplier k = H(N | pad(g))** (`srp.cpp:29-46`, `RemoteGroup` ctor). Always **SHA-1** for k,
regardless of the Srp/Srp256 variant:
```
k = SHA1( bytes(N)  ||  zero_pad  ||  bytes(g) )
```
where `bytes(N)` is the big-endian minimal byte representation of N (128 bytes), and g is left-
padded with zero bytes to the length of N before hashing (`pad = prime.length()-generator.length()`,
zero buffer processed, then g). Concretely k over the FB group computes to:
```
k (hex) = DFC212B4BD69674855CFCEB30002B5C306AC60B5   (SHA-1, 20 bytes)
```
(Verified by reproducing `SHA1(Nbytes || 0x00*127 || 0x02)`.)

### Sizes (`srp.h:108-110`)
```
SRP_KEY_SIZE      = 128   // client/server private key random size, in bytes
SRP_VERIFIER_SIZE = 128
SRP_SALT_SIZE     = 32    // salt is 32 bytes; on wire as hex it is up to 64 chars
```

### Which hash where (critical for interop)
`RemotePassword` uses a **fixed SHA-1** `hash` member for almost everything; only the final
*proof digest* uses the plugin-specific hash (`RemotePasswordImpl<SHA>`):
- **k multiplier**: SHA-1 (always).
- **scramble u = H(A | B)**: SHA-1 (`computeScramble`, srp.cpp:147-155) via
  `processStrippedInt` on both public keys.
- **x = H(salt | H(user | ':' | password))**: SHA-1 (`getUserHash`, srp.cpp:85-101).
  Note: `H(user ':' password)` inner is SHA-1, and outer `H(salt || innerBytes)` is SHA-1.
- **session key K = H(S)**: SHA-1 (`clientSessionKey`/`serverSessionKey`, srp.cpp:157-196) —
  `hash.processStrippedInt(S); hash.getHash(sessionKey)`. So **K is always a 20-byte SHA-1**
  digest of the premaster secret S, even for Srp256.
- **Client/server proof M**: uses the **plugin-specific** SHA (`RemotePasswordImpl<SHA>::makeProof`,
  srp.h:134-152). This is the ONLY place `Srp256` differs from `Srp`:
  - `Srp`    → proof digest = SHA-1
  - `Srp256` → proof digest = SHA-256
  - (`Srp224/Srp384/Srp512` also registered — `SrpClient.cpp:185-198`.)

**So "Srp256" changes only the proof (M) hash to SHA-256.** The verifier, k, x, u, and the
session key K remain SHA-1-based. (The verifier stored server-side is
`v = g^x mod N`, and x is SHA-1; K = SHA1(S).)

### Proof formula (`srp.cpp:198-217`, `srp.h:137-151`)
```
n1 = H(N)                      // SHA-1 digest of N as integer
n2 = H(g)                      // SHA-1 digest of g as integer
n1 = n1 ^ n2  (mod N)          // modPow: n1 = n1.modPow(n2, N)  -- "H(N) ^ H(g)"
n2 = H(I)                      // SHA-1 digest of the account/login name (as processed string)
M  = HASH( n1 || n2 || salt || A || B || K )
```
where `HASH` = SHA-1 for Srp, SHA-256 for Srp256; A, B are integers processed via `processInt`
(full minimal big-endian bytes, including any leading zero from getBytes — note `processInt`
vs `processStrippedInt`). The comment in source: `H(H(prime) ^ H(g), H(I), s, A, B, K)`.
`makeProof` feeds: `processInt(n1); processInt(n2); process(salt); processInt(A);
processInt(B); process(K)`.

Important encoding subtleties for interop:
- `processInt(x)` = SHA over `x.getBytes()` (minimal big-endian, may include a leading 0x00 if
  the high bit is set).
- `processStrippedInt(x)` = SHA over the bytes with a single leading 0x00 removed if present
  (`srp.h:72-81`). Used for scramble and session-key computation (over A, B, S).
- `salt` fed to proof is the **hex text** string of the salt (as received on the wire), not raw
  salt bytes — because the client parsed it into `salt` (a hex string) and passes `salt.c_str()`.

### Client key generation and secret
- Private key a: `makePrivate()` = 128 random bytes mod N (`srp.cpp:75-83`).
- Public key A = g^a mod N, retried until A > 1 (`genClientKey`, srp.cpp:109-124), returned as
  hex text.
- Client premaster S = (B - k·g^x)^(a + u·x) mod N (`clientSessionKey`, srp.cpp:157-179).
- Session key K = SHA1(S) (stripped-int).

### Server side (`server/SrpServer.cpp`)
- Server public key B = (k·v + g^b) mod N, retried until B > 1 (`genServerKey`, srp.cpp:126-145).
- Server premaster S = (A · v^u)^b mod N (`serverSessionKey`, srp.cpp:181-196).
- Server verifies `clientProof == server.clientProof(...)` (`SrpServer.cpp:358-360`).

### Username case handling
- The login carried in `CNCT_login`/DPB is the **original** typed name (`cliOrigUserName`), not
  uppercased (`interface.cpp:10272`, `remote.cpp:1119-1123`).
- For DPB `getLogin()` the client stores an **uppercased** copy (`fb_utils::dpbItemUpper`,
  `interface.cpp:10273`) unless the name was quoted — `dpbItemUpper` strips quotes and only
  uppercases unquoted ASCII (`src/common/utils.cpp:1567+`).
- SRP's `x` is computed over the account name **as the plugin receives it via getLogin()**.
  The server uses `sb->getLogin()` (`SrpServer.cpp:275`) and also uppercases for the security-db
  lookup (`server.cpp:587`, `7523`). Net: for interop, uppercase unquoted logins the same way
  Firebird does (SQL identifier folding) before computing the SRP hash, matching what the server
  stored at user-creation time.

### Wire-crypt key derived from SRP
Both sides register the session key K as a **symmetric** crypt key named after the auth plugin:
`cKey->setSymmetric(status, "Symmetric", sessionKey.getCount(), sessionKey.begin())`
(`SrpClient.cpp:163-168`, `SrpServer.cpp:381-386`). So the RC4 key = the 20-byte SHA-1 session
key K directly. `InternalCryptKey::setSymmetric` stores it as both encrypt and decrypt key
(decrypt cleared → getDecryptKey falls back to encrypt) (`remote.cpp:1795-1808`).

### Legacy_Auth (fallback, DES crypt)
`SecurityDatabase/LegacyClient.cpp:38-54`: `ENC_crypt(password, salt="9z")` (Unix DES crypt),
transmit `&result[2]` (drop the 2-char salt prefix). Salt constant
`LEGACY_PASSWORD_SALT = "9z"` (`LegacyHash.h:38`). Only usable when protocol < 13 or explicitly
enabled; never provides wire encryption.

---

## 6. Wire crypt (op_crypt) and wire compression

### op_crypt (96) — `P_CRYPT` (protocol.h:710-714), wire `protocol.cpp:834-842`
```
cstring p_plugin   // wire-crypt plugin name, e.g. "Arc4"
cstring p_key      // key NAME (the crypt-key type = the auth plugin name, e.g. "Srp256")
```
The `p_key` field is the **key type name** (the auth plugin that produced the session key),
NOT the key bytes. The actual key material was set locally via `setKey` before sending.

### When op_crypt is sent
After authentication completes and before/at attach. `ClntAuthBlock::tryNewKeys` →
`rem_port::tryNewKey` → `tryKeyType` (`remote.cpp:1367-1462`):
1. For each server key catalogue entry whose `type` matches the crypt key's `keyName`
   (the auth plugin name), and if client wire-crypt != DISABLED,
2. iterate client's configured `TYPE_WIRE_CRYPT` plugins; pick the first that the server also
   listed in that key's `TAG_KEY_PLUGINS`;
3. `setSpecificData` (if the server sent plugin-specific IV), then `setKey(cryptKey)`;
4. send `op_crypt { p_plugin = chosen plugin, p_key = keyName }`;
5. **receive an op_response** and check it (`checkResponse`) — this response is still sent
   **unencrypted** by the server, but the client's *decryptor* is active; server sets
   `port_crypt_complete` only after sending its OK (`server.cpp:6619-6702`, `start_crypt`).
6. set `port_crypt_complete = true`. From then on **all** packets are encrypted.

The crypt handshake happens right after the accept/auth phase and before op_attach is answered;
`secureAuthentication`/`tryNewKeys` run during connect (`interface.cpp:7840-7871`,
`8862-8866`).

### RC4 keying (`src/plugins/crypt/arc4/Arc4.cpp`)
Standard RC4/ARCFOUR. Key schedule (`Cypher` ctor, Arc4.cpp:40-53):
```
for n in 0..255: state[n] = n
k2 = 0
for k1 in 0..255:
    k2 = (k2 + key[k1 % keylen] + state[k1]) & 0xFF
    swap(state[k1], state[k2])
```
Stream (`transform`, Arc4.cpp:55-68):
```
s1++, s2 += state[s1]; swap(state[s1],state[s2]); out = in ^ state[(state[s1]+state[s2]) & 0xFF]
```
Two independent cyphers: `en` from `getEncryptKey`, `de` from `getDecryptKey`
(Arc4.cpp:115-131). Since SRP set only the encrypt key (decrypt cleared → equals encrypt), the
send and receive RC4 states start from the **same key** (the 20-byte session key K) but are
independent streams — client-encrypt state == server-decrypt state, and vice-versa.
`getKnownTypes` returns `"Symmetric"`. No IV for Arc4 (`getSpecificData` returns null).

Encryption is applied at the socket boundary: `packet_send` encrypts the whole outgoing buffer
in place when `port_crypt_plugin && port_crypt_complete` (`inet.cpp:3164`); received bytes are
decrypted in `packet_receive` (`inet.cpp:3081`).

Other plugins named in `consts_pub.h:176-179`: `"Arc4"`, `"ChaCha"` (ChaCha uses
`TAG_PLUGIN_SPECIFIC`/`setSpecificData` for its nonce).

### Wire compression (zlib)
Compression is **NOT** signaled via a CNCT tag. It is negotiated inside the protocol-version
offer: the client OR's `pflag_compress (0x100)` into `p_cnct_versions[i].p_cnct_max_type` for
each offered version >= 13 when it wants compression (`inet.cpp:726-729`). The server echoes
`pflag_compress` in the accept's `p_acpt_type` high byte. On seeing it the client calls
`port->initCompression()` and sets `PORT_compressed` (`interface.cpp:8847-8850`, also in
op_accept_data path `inet.cpp:8847`).

zlib framing (`remote.cpp` `REMOTE_deflate` / `REMOTE_inflate`, 1533-1810):
- Uses raw zlib streams: `deflateInit(&stream, Z_DEFAULT_COMPRESSION)` and `inflateInit`
  (`initCompression`, remote.cpp:1748-1783). Standard zlib window (not raw-deflate; standard
  `inflateInit`/`deflateInit`, so 15-bit window + zlib header).
- Each logical packet flush uses `deflate(..., Z_SYNC_FLUSH)` so the compressed stream is framed
  per send with a sync flush boundary; `Z_NO_FLUSH` otherwise (`remote.cpp:1693`).
- Compression is a continuous stream over the whole connection (state persists), layered
  **inside** encryption: data is compressed first, then the compressed bytes are what get
  RC4-encrypted by `packet_send`. (Compress-then-encrypt.)
- `versionInfo` appends `:Z` when compressed and `:C` (`C` then `Z`) when both crypt+compress
  (`remote.cpp:1519-1531`).

Requires the server/client to have `WIRE_COMPRESS_SUPPORT` (zlib) compiled in; a TS client can
simply not offer `pflag_compress`.

---

## 7. DPB — Database Parameter Block (`consts_pub.h:33-141`)

Versions: `isc_dpb_version1 = 1`, `isc_dpb_version2 = 2`. The DPB is a byte buffer starting with
the version byte, then a sequence of `<tag byte><length byte><data>` clumplets (v1 uses 1-byte
lengths; v2 uses a different clumplet form — modern clients use v1 with `ClumpletWriter`).

Selected tag values a driver needs (decimal):
```
isc_dpb_cdd_pathname        = 1
isc_dpb_page_size           = 4
isc_dpb_num_buffers         = 5
isc_dpb_sweep_interval      = 22
isc_dpb_force_write         = 24
isc_dpb_no_reserve          = 27
isc_dpb_user_name           = 28
isc_dpb_password            = 29
isc_dpb_password_enc        = 30
isc_dpb_sys_user_name_enc   = 31
isc_dpb_interp              = 32
isc_dpb_overwrite           = 54
isc_dpb_connect_timeout     = 57
isc_dpb_dummy_packet_interval = 58
isc_dpb_gbak_attach         = 59
isc_dpb_sql_role_name       = 60
isc_dpb_set_page_buffers    = 61
isc_dpb_working_directory   = 62
isc_dpb_sql_dialect         = 63
isc_dpb_set_db_readonly     = 64
isc_dpb_set_db_sql_dialect  = 65
isc_dpb_set_db_charset      = 68
isc_dpb_address_path        = 70
isc_dpb_process_id          = 71
isc_dpb_no_db_triggers      = 72
isc_dpb_trusted_auth        = 73
isc_dpb_process_name        = 74
isc_dpb_trusted_role        = 75
isc_dpb_org_filename        = 76
isc_dpb_utf8_filename       = 77
isc_dpb_ext_call_depth      = 78
isc_dpb_auth_block          = 79
isc_dpb_client_version      = 80
isc_dpb_remote_protocol     = 81
isc_dpb_host_name           = 82
isc_dpb_os_user             = 83
isc_dpb_specific_auth_data  = 84    // SRP/plugin data during attach (equivalent of CNCT_specific_data)
isc_dpb_auth_plugin_list    = 85
isc_dpb_auth_plugin_name    = 86
isc_dpb_config              = 87
isc_dpb_nolinger            = 88
isc_dpb_reset_icu           = 89
isc_dpb_map_attach          = 90
isc_dpb_session_time_zone   = 91
isc_dpb_set_db_replica      = 92
isc_dpb_set_bind            = 93
isc_dpb_decfloat_round      = 94
isc_dpb_decfloat_traps      = 95
isc_dpb_clear_map           = 96
isc_dpb_upgrade_db          = 97
isc_dpb_parallel_workers    = 100
isc_dpb_worker_attach       = 101
isc_dpb_owner               = 102
isc_dpb_max_blob_cache_size = 103
isc_dpb_max_inline_blob_size= 104
isc_dpb_search_path         = 105   // FB6
isc_dpb_blr_request_search_path = 106
isc_dpb_gbak_restore_has_schema = 107
```
The **auth-related tags** the client inserts during attach are the DPB analogues of the CNCT
tags: `isc_dpb_auth_plugin_name (86)`, `isc_dpb_auth_plugin_list (85)`,
`isc_dpb_specific_auth_data (84)`, plus `isc_dpb_user_name (28)` and, for legacy,
`isc_dpb_password_enc (30)` / `isc_dpb_trusted_auth (73)`
(`ParametersSet` maps: `plugin_name`, `plugin_list`, `specific_data`, `password_enc`,
`trusted_auth` — `interface.cpp:8785`, `10205-10251`).

`isc_dpb_address_path` sub-clumplet grammar (consts_pub.h:143-201):
```
isc_dpb_address = 1
  isc_dpb_addr_protocol = 1     ("TCPv4"/"TCPv6"/"XNET")
  isc_dpb_addr_endpoint = 2
  isc_dpb_addr_flags    = 3
  isc_dpb_addr_crypt    = 4     (plugin string "Arc4"/"ChaCha")
addr flags: isc_dpb_addr_flag_conn_compressed = 0x01, isc_dpb_addr_flag_conn_encrypted = 0x02
```

SQL dialect values (`sqlda_pub.h:98-107`): `SQL_DIALECT_V5=1`, `SQL_DIALECT_V6_TRANSITION=2`,
`SQL_DIALECT_V6=3` (= current).

---

## 8. TPB — Transaction Parameter Block (`consts_pub.h:251-277`)

Buffer starts with version byte `isc_tpb_version3 = 3` (modern) or `isc_tpb_version1 = 1`, then
option bytes (each option is a single tag byte; some take data).
```
isc_tpb_version1        = 1
isc_tpb_version3        = 3
isc_tpb_consistency     = 1     // table-stability isolation
isc_tpb_concurrency     = 2     // snapshot (default)
isc_tpb_shared          = 3
isc_tpb_protected       = 4
isc_tpb_exclusive       = 5
isc_tpb_wait            = 6
isc_tpb_nowait          = 7
isc_tpb_read            = 8     // read-only
isc_tpb_write           = 9     // read-write (default)
isc_tpb_lock_read       = 10    // <table name> reservation, read
isc_tpb_lock_write      = 11    // <table name> reservation, write
isc_tpb_verb_time       = 12
isc_tpb_commit_time     = 13
isc_tpb_ignore_limbo    = 14
isc_tpb_read_committed  = 15
isc_tpb_autocommit      = 16
isc_tpb_rec_version     = 17    // read-committed record-version
isc_tpb_no_rec_version  = 18    // read-committed no-record-version
isc_tpb_restart_requests= 19
isc_tpb_no_auto_undo    = 20
isc_tpb_lock_timeout    = 21    // takes a value (lock wait timeout, seconds)
isc_tpb_read_consistency= 22    // FB4+ read-committed read-consistency
isc_tpb_at_snapshot_number = 23 // FB4+, takes int64 snapshot number
isc_tpb_auto_release_temp_blobid = 24
isc_tpb_lock_table_schema  = 25 // FB6
```
Typical default read-write snapshot TPB: `[3, isc_tpb_write(9), isc_tpb_concurrency(2),
isc_tpb_wait(6)]`. `isc_tpb_lock_timeout` is followed by a length byte and the timeout value
bytes.

---

## 9. Statement (DSQL) protocol

### op_allocate_statement (62)
Request body = `P_RLSE` form (`protocol.cpp:545-549`): a single `xdr_short p_rlse_object` =
database object id. Response `op_response` returns the new statement handle in
`p_resp_object`.

### op_prepare_statement (68) — `P_SQLST` (protocol.h:628-644), wire `protocol.cpp:706-722`
Shares the `case op_exec_immediate/op_prepare_statement` branch:
```
xdr_short   p_sqlst_transaction
xdr_short   p_sqlst_statement
xdr_short   p_sqlst_SQL_dialect
cstring     p_sqlst_SQL_str        // the SQL text (in the connection charset)
cstring     p_sqlst_items          // requested info items (see below)
xdr_long    p_sqlst_buffer_length  // max info response size  (was USHORT historically)
[ if protocol >= PROTOCOL_PREPARE_FLAG (20):
  xdr_short p_sqlst_flags ]         // FB6 prepare flags (PREPARE_PREFETCH_*)
```
`op_exec_immediate2` (75) additionally serializes input/output BLR + messages first
(`protocol.cpp:682-704`) and, for p19+, `p_sqlst_inline_blob_size` (u_long).

Response to prepare = `op_response` whose `p_resp_data` contains the info block answering
`p_sqlst_items` (describe of output/input columns).

### SQL info items (request, `inf_pub.h:480-509`)
```
isc_info_sql_select         = 4
isc_info_sql_bind           = 5
isc_info_sql_num_variables  = 6
isc_info_sql_describe_vars  = 7
isc_info_sql_describe_end   = 8
isc_info_sql_sqlda_seq      = 9
isc_info_sql_message_seq    = 10
isc_info_sql_type           = 11
isc_info_sql_sub_type       = 12
isc_info_sql_scale          = 13
isc_info_sql_length         = 14
isc_info_sql_null_ind       = 15
isc_info_sql_field          = 16
isc_info_sql_relation       = 17
isc_info_sql_owner          = 18
isc_info_sql_alias          = 19
isc_info_sql_sqlda_start    = 20
isc_info_sql_stmt_type      = 21
isc_info_sql_get_plan       = 22
isc_info_sql_records        = 23
isc_info_sql_batch_fetch    = 24
isc_info_sql_relation_alias = 25
isc_info_sql_explain_plan   = 26
isc_info_sql_stmt_flags     = 27
isc_info_sql_stmt_timeout_user = 28
isc_info_sql_stmt_timeout_run  = 29
isc_info_sql_stmt_blob_align   = 30
isc_info_sql_exec_path_blr_bytes = 31
isc_info_sql_exec_path_blr_text  = 32
isc_info_sql_relation_schema     = 33   // FB6
```
Common structural codes (`inf_pub.h:32-37`): `isc_info_end=1`, `isc_info_truncated=2`,
`isc_info_error=3`, `isc_info_data_not_ready=4`, `isc_info_length=126`, `isc_info_flag_end=127`.

Statement-type return values (`inf_pub.h:515-528`, value of `isc_info_sql_stmt_type`):
```
isc_info_sql_stmt_select         = 1
isc_info_sql_stmt_insert         = 2
isc_info_sql_stmt_update         = 3
isc_info_sql_stmt_delete         = 4
isc_info_sql_stmt_ddl            = 5
isc_info_sql_stmt_get_segment    = 6
isc_info_sql_stmt_put_segment    = 7
isc_info_sql_stmt_exec_procedure = 8
isc_info_sql_stmt_start_trans    = 9
isc_info_sql_stmt_commit         = 10
isc_info_sql_stmt_rollback       = 11
isc_info_sql_stmt_select_for_upd = 12
isc_info_sql_stmt_set_generator  = 13
isc_info_sql_stmt_savepoint      = 14
```
A describe response is a nested sequence: `isc_info_sql_select`/`isc_info_sql_bind` opens the
column group; `isc_info_sql_describe_vars` gives the count; each column is a run of
`isc_info_sql_sqlda_seq`, `isc_info_sql_type`, `isc_info_sql_sub_type`, `isc_info_sql_scale`,
`isc_info_sql_length`, `isc_info_sql_field`, `isc_info_sql_relation`, `isc_info_sql_owner`,
`isc_info_sql_alias` (+ `relation_alias`), terminated by `isc_info_sql_describe_end`. Each info
item value is a little-endian length-prefixed value inside the info buffer (classic
`isc_XXX_info` clumplet format — NOT XDR).

### op_execute (63) / op_execute2 (76) — `P_SQLDATA` (protocol.h:646-662), wire `protocol.cpp:638-680`
```
xdr_short   p_sqldata_statement
xdr_short   p_sqldata_transaction
xdr_sql_blr p_sqldata_blr           // input-message BLR (cstring) + sets up message format
xdr_short   p_sqldata_message_number
xdr_short   p_sqldata_messages      // number of input messages (0 or 1 typically)
[ if p_sqldata_messages > 0: the packed input message (see §10) ]
[ if op_execute2:
    xdr_sql_blr p_sqldata_out_blr   // output-message BLR
    xdr_short   p_sqldata_out_message_number ]
[ if protocol >= PROTOCOL_STMT_TOUT(16): xdr_u_long p_sqldata_timeout ]        // statement timeout (ms)
[ if protocol >= PROTOCOL_FETCH_SCROLL(18): xdr_u_long p_sqldata_cursor_flags ]// cursor flags (CURSOR_TYPE_SCROLLABLE=0x1)
[ if protocol >= PROTOCOL_INLINE_BLOB(19): xdr_u_long p_sqldata_inline_blob_size ]
```
`op_execute2` is used when the statement both takes input and returns a singleton output message
(EXECUTE PROCEDURE ... RETURNING, or exec with output). Plain `op_execute` for
SELECT-cursor-open / DML without RETURNING. Response = `op_sql_response` (for op_execute2 output
row) then `op_response`, or just `op_response`.

`cursor_flags`: `CURSOR_TYPE_SCROLLABLE = 0x01`
(`FirebirdInterface.idl:496`, `IdlFbInterfaces.h:1960`).

### op_fetch (65) / op_fetch_scroll (112) — wire `protocol.cpp:724-741`
```
xdr_short   p_sqldata_statement
xdr_sql_blr p_sqldata_blr           // output-message BLR (direction=true)
xdr_short   p_sqldata_message_number
xdr_short   p_sqldata_messages      // number of rows client is willing to receive (batch size)
[ if op_fetch_scroll:
    xdr_short p_sqldata_fetch_op    // P_FETCH enum (below)
    xdr_long  p_sqldata_fetch_pos ] // position for absolute/relative
```
`P_FETCH` enum (protocol.h:170-180): `fetch_next=0, fetch_prior=1, fetch_first=2, fetch_last=3,
fetch_absolute=4, fetch_relative=5`; `fetch_execute = fetch_next = 0`.

### op_fetch_response (66) — server → client, wire `protocol.cpp:743-756`
```
xdr_long    p_sqldata_status     // EOF status: 0 = row present, 100 = end of cursor
xdr_short   p_sqldata_messages   // number of messages that follow (0 or 1 per response packet)
[ if messages > 0: one packed output message ]
```
Semantics (`interface.cpp:5060`, `8230-8266`; server sets `p_sqldata_status = success?0:100` at
`server.cpp:4343`):
- Server streams a **batch** of `op_fetch_response` packets, one row each
  (`p_sqldata_messages = 1`, `p_sqldata_status = 0`), until the batch is exhausted.
- The batch terminator is a response with `p_sqldata_status == 100` and `p_sqldata_messages == 0`
  → end of cursor (sets EOF for forward fetch, BOF for backward scroll).
- `MAX_PACKETS_PER_BATCH`/`MIN_ROWS_PER_BATCH` bound how many rows the server pushes per
  op_fetch (server.cpp:4337-4341). The client requests `p_sqldata_messages` rows.

### op_set_cursor (69) — `P_SQLCUR` (protocol.h:670-675), wire `protocol.cpp:765-771`
```
xdr_short   p_sqlcur_statement
cstring     p_sqlcur_cursor_name
xdr_short   p_sqlcur_type
```

### op_free_statement (67) — `P_SQLFREE` (protocol.h:664-668), wire `protocol.cpp:758-763`
```
xdr_short   p_sqlfree_statement
xdr_short   p_sqlfree_option
```
Options (`sqlda_pub.h:29-31`): `DSQL_close = 1`, `DSQL_drop = 2`, `DSQL_unprepare = 4`.

### op_sql_response (78) — server → client, wire `protocol.cpp:773-779`
```
xdr_short   p_sqldata_messages     // 0 or 1
[ if 1: one packed message (the output/singleton row) ]
```

---

## 10. On-the-wire message format (protocol >= 13: packed / NULL-aware)

Two paths in `xdr_sql_message` (`protocol.cpp:2002-2054`):
- protocol < 13 → `xdr_message` (unpacked; each column always present, NULL indicated by a
  separate SSHORT indicator column, values XDR'd unconditionally).
- protocol >= 13 → `xdr_packed_message` (`protocol.cpp:1604-1735`).

**Message format model:** the message format (`rem_fmt`) is derived from the BLR and always has
an **even number** of descriptors — they come in pairs `(value_desc, null_indicator_desc)`. The
null indicator is a `dtype_short` (SSHORT): 0 = not null, -1 = null.

### Packed message layout (protocol >= 13)
1. **NULL bitmap** first: `flagBytes = (numColumns + 7) / 8` where
   `numColumns = fmt_desc.getCount() / 2` (`protocol.cpp:1658-1660`). Bit `i` (for column i) is
   set if column i is NULL: `data[i>>3] |= (1 << (i&7))` — i.e. **LSB-first within each byte,
   little-endian bit order** (`NullBitmap::setNull`, protocol.cpp:1642-1650).
2. The bitmap is emitted via `xdr_opaque` → its `flagBytes` bytes **followed by padding to the
   next 4-byte boundary** (`xdr_opaque` pads with `(4-len)&3` zero bytes, protocol.cpp:559,1679).
   So a table with ≤4 columns → 1 bitmap byte + 3 pad; 5..8 cols → 1 byte + 3 pad; 33..64 cols
   → 8 bytes + 0 pad (already multiple of 4), etc. (bitmap length padded to 4, not each byte).
3. Then, for each **non-NULL** column in order, its value is XDR-encoded via `xdr_datum`
   (`protocol.cpp:1685-1694`). NULL columns contribute **no value bytes** at all — they are
   skipped entirely. The separate SSHORT null-indicator descriptors are NOT sent; they are
   reconstructed from the bitmap on decode (`protocol.cpp:1707-1716`, indicator set to -1/0).

On decode the receiver zero-fills the whole message buffer first, reads the bitmap, sets each
indicator to -1 (null) or 0, then reads only the non-null values.

### Per-type XDR encoding (`xdr_datum`, `src/common/xdr.cpp:156-335`)
The descriptor `dsc_dtype` drives encoding. SQL type → dtype mapping and wire form:

| SQL type (sqlda_pub.h) | value | dtype | Wire encoding (xdr_datum) |
|---|---|---|---|
| SQL_TEXT | 452 | dtype_text | `xdr_opaque(dsc_length bytes)` + pad4. Fixed CHAR, space-padded. |
| SQL_VARYING | 448 | dtype_varying | `xdr_short(vary_length)` [4 bytes on wire] then `xdr_opaque(min(dsc_length-2, vary_length))` + pad4. |
| SQL_SHORT | 500 | dtype_short | `xdr_short` → 4 bytes big-endian (sign-extended). Scaled integer. |
| SQL_LONG | 496 | dtype_long | `xdr_long` → 4 bytes big-endian. |
| SQL_INT64 | 580 | dtype_int64 | `xdr_hyper` → 8 bytes as two big-endian longs, **low long first** (see §0). |
| SQL_FLOAT | 482 | dtype_real | `xdr_float` → 4 bytes big-endian IEEE-754. |
| SQL_DOUBLE | 480 | dtype_double | `xdr_double` → 8 bytes, two longs (platform order) each big-endian. |
| SQL_D_FLOAT | 530 | dtype_d_float | (legacy VAX F/G; treat as double) |
| SQL_TYPE_DATE | 570 | dtype_sql_date | `xdr_long` → 4 bytes. Days since epoch (below). |
| SQL_TYPE_TIME | 560 | dtype_sql_time | `xdr_long` → 4 bytes. Units of 1/10000 s since midnight. |
| SQL_TIMESTAMP | 510 | dtype_timestamp | two `xdr_long`: `[0]`=date (days), `[1]`=time (1/10000 s). 8 bytes. |
| SQL_BLOB | 520 | dtype_blob | `xdr_quad` → 8 bytes (SQUAD blob id: high long then low long). |
| SQL_ARRAY | 540 | dtype_array | `xdr_quad` → 8 bytes (array id, same as blob). |
| SQL_QUAD | 550 | dtype_quad | `xdr_quad` → 8 bytes. |
| SQL_BOOLEAN | 32764 | dtype_boolean | `xdr_opaque(dsc_length)` — 1 byte value (0/1) + pad to 4. |
| SQL_NULL | 32766 | (n/a) | Type marker only; carries no data (always NULL). |
| SQL_INT128 | 32752 | dtype_int128 | `xdr_int128`: bytes[8..15] then bytes[0..7], each via xdr_hyper. 16 bytes. |
| SQL_DEC16 | 32760 | dtype_dec64 | `xdr_dec64` (Decimal64): 8 bytes, PDP-endian word swap (below). |
| SQL_DEC34 | 32762 | dtype_dec128 | `xdr_dec128` (Decimal128): 16 bytes, word-swapped halves. |
| SQL_TIME_TZ | 32756 | dtype_sql_time_tz | `xdr_long(time)` + `xdr_short(time_zone)`. 4 + 4 = 8 bytes on wire. |
| SQL_TIMESTAMP_TZ | 32754 | dtype_timestamp_tz | 2×`xdr_long`(date,time) + `xdr_short`(zone). 12 bytes on wire. |
| SQL_TIME_TZ_EX | 32750 | dtype_ex_time_tz | `xdr_long(time)` + `xdr_short(zone)` + `xdr_short(offset)`. |
| SQL_TIMESTAMP_TZ_EX | 32748 | dtype_ex_timestamp_tz | 2×`xdr_long` + `xdr_short(zone)` + `xdr_short(offset)`. |

Notes:
- **Every `xdr_short` costs 4 bytes on the wire** (varying length prefix, null indicators inside
  unpacked messages, time-zone ids). Budget accordingly.
- SQL types are always **even**; the low bit is the "has NULL indicator" flag in the SQLDA
  (`sqltype | 1`). The wire/BLR uses the base even type.
- **SQL_NULL (32766)** is a column that is always NULL (used for untyped NULL literals); it
  occupies a bitmap bit and sends no data.

### Decimal float word order (`xdr.cpp:384-434`)
DecFloat has PDP-like layout: within each 4-byte word bytes are endian-dependent, but the words
are endian-independent, so Firebird swaps the two longs. `xdr_dec64` = `xdr_decfloat_hyper`
(swap the two 32-bit halves). `xdr_dec128` = `xdr_decfloat_hyper(&bytes[8])` then
`xdr_decfloat_hyper(&bytes[0])` (high 8 bytes first, each half-swapped).

### INT128 word order (`xdr.cpp:437-447`)
`xdr_int128` on little-endian: `xdr_hyper(&bytes[8])` then `xdr_hyper(&bytes[0])` — the high
64-bit half first, each half emitted low-long-first per `xdr_hyper`.

### Date/time epoch and units
- **Date epoch: day 0 = November 17, 1858** (Modified Julian Date base — confirmed
  `src/common/classes/NoThrowTimeStamp.cpp:188,192`: "November 17, 1858 -- used as a base date
  in Firebird"). `SQL_TYPE_DATE` value = signed day count from that base.
- **Time unit: 1/10000 second** — `ISC_TIME_SECONDS_PRECISION = 10000`,
  `ISC_TIME_SECONDS_PRECISION_SCALE = -4` (`src/include/firebird/impl/dsc_pub.h:74-75`). So a
  `SQL_TYPE_TIME` value 0..863,999,999 spans a day; multiply seconds by 10000.
- **TIMESTAMP** = (date_long, time_long) pair as above; both stored UTC-naive (local) for the
  non-TZ types.

### Time zone id encoding (`src/common/TimeZoneUtil.cpp`)
The `time_zone` USHORT is either a named-region id or an offset code:
- **Named regions**: ids `> ONE_DAY*2` (where `ONE_DAY = 24*60 - 1 = 1439`, i.e. > 2878) map to
  the ICU region table. `GMT_ZONE = 65535` (`TimeZoneUtil.h:59`).
- **Offset zones**: id `<= 2878` (`isOffset`, TimeZoneUtil.cpp:1157-1160). The signed minute
  displacement is `displacement = id - ONE_DAY` (i.e. `id - 1439`), range ±1439 minutes
  (`offsetZoneToDisplacement`, :1163-1168). Encode with `id = displacement_minutes + 1439`
  (`displacementToOffsetZone`, :1170-1173). Example: UTC (offset 0) → id 1439 = 0x059F.
- The `_EX` variants additionally send an explicit `offset` SSHORT (resolved minutes offset)
  after the zone id.

---

## 11. Response packets

### op_response (9) / op_response_piggyback (72) — `P_RESP` (protocol.h:467-475), wire `protocol.cpp:432-443`
```
xdr_short         p_resp_object          // object id (new handle, count, etc.)
xdr_quad          p_resp_blob_id         // 8-byte SQUAD (blob id / partner id)
xdr_response      p_resp_data            // cstring (variable payload: info buffers, keys, aux-port addr...)
xdr_status_vector p_resp_status_vector   // the status vector (see below)
```
`p_resp_object` meaning is op-dependent: new statement/transaction/blob handle after allocate;
segment-state (1=partial segment, 2=EOF) after op_get_segment; etc. `#define p_resp_partner
p_resp_blob_id.bid_number` (protocol.h:475).

`xdr_response` (protocol.cpp:1373-1383) is `xdr_cstring` but, on the client decode side, honors a
preallocated buffer limit (`UseStandardBuffer`), so info responses fill a caller buffer.

### Status vector encoding (`xdr_status_vector`, protocol.cpp:2057-2160)
A sequence of `xdr_long` tokens, each a status "cluster", terminated by `isc_arg_end`:
```
loop:
  xdr_long  arg_type
  switch(arg_type):
    isc_arg_end (0):                       -> stop
    isc_arg_interpreted (5),
    isc_arg_string (2),
    isc_arg_sql_state (19):                -> xdr_wrapstring (a string: xdr_long len + bytes + pad4, max 65535)
    isc_arg_number (4), isc_arg_unix (7),
    isc_arg_win32 (17), isc_arg_gds (1),
    isc_arg_warning (18), isc_arg_next_mach (15): -> xdr_long (a following numeric/code long)
    default:                               -> stop (unknown)
```
`isc_arg_*` codes (`src/include/firebird/iberror.h:83-99`):
```
isc_arg_end=0  isc_arg_gds=1  isc_arg_string=2  isc_arg_cstring=3  isc_arg_number=4
isc_arg_interpreted=5  isc_arg_vms=6  isc_arg_unix=7  isc_arg_domain=8  isc_arg_dos=9
isc_arg_mpexl=10  isc_arg_mpexl_ipc=11  isc_arg_next_mach=15  isc_arg_netware=16
isc_arg_win32=17  isc_arg_warning=18  isc_arg_sql_state=19
```
Error decoding: a status vector begins with `isc_arg_gds <errcode>`; subsequent `isc_arg_gds`
clusters and `isc_arg_string`/`isc_arg_number` provide message parameters; `isc_arg_warning`
introduces a warning; `isc_arg_sql_state` carries the SQLSTATE string. An empty error (success)
is just `isc_arg_gds 0 isc_arg_end` or `isc_arg_end`. Note `isc_arg_cstring (3)` is used
in-memory but on the wire strings go as `isc_arg_string`/`isc_arg_interpreted`/`isc_arg_sql_state`
(the client rewrites cstring clusters, remote.cpp:1280-1291).

### op_fetch_response (66) and op_sql_response (78): see §9.

### xdr_protocol_overhead (protocol.cpp:1211-1266)
For batching-window sizing: op_response overhead = 4(op) + 4(object) + 8(blob_id) +
4(min cstring) + 3*4(min status vector) bytes; op_fetch_response = 4 + 4 + 4.

---

## 12. BLOB wire operations

### op_create_blob (34) / op_open_blob (35) — `P_BLOB` (protocol.h:532-537), wire `protocol.cpp:471-477`
```
xdr_short p_blob_transaction
xdr_quad  p_blob_id            // 8-byte blob id (for open; ignored/output for create)
```
### op_create_blob2 (57) / op_open_blob2 (56) — wire `protocol.cpp:465-477`
Same, preceded by:
```
cstring   p_blob_bpb          // Blob Parameter Block
xdr_short p_blob_transaction
xdr_quad  p_blob_id
```
Response `op_response`: `p_resp_object` = new blob handle, `p_resp_blob_id` = the blob id
(for create).

BPB tags (`consts_pub.h:284-296`): version byte `isc_bpb_version1 = 1`, then clumplets:
```
isc_bpb_source_type      = 1
isc_bpb_target_type      = 2
isc_bpb_type             = 3     // value: isc_bpb_type_segmented=0x0 / isc_bpb_type_stream=0x1
isc_bpb_source_interp    = 4     // source charset id
isc_bpb_target_interp    = 5     // target charset id
isc_bpb_filter_parameter = 6
isc_bpb_storage          = 7     // isc_bpb_storage_main=0x0 / isc_bpb_storage_temp=0x2
```
Blob subtypes (`consts_pub.h:719-732`): `isc_blob_untyped=0, isc_blob_text=1, isc_blob_blr=2,
isc_blob_acl=3, ... isc_blob_debug_info=9, isc_blob_max_predefined_subtype=10`.

### op_get_segment (36) / op_put_segment (37) / op_batch_segments (44) — `P_SGMT` (protocol.h:539-544), wire `protocol.cpp:479-487`
```
xdr_short p_sgmt_blob      // blob handle
xdr_short p_sgmt_length    // requested length (get) / segment length (put)
cstring   p_sgmt_segment   // data (empty for get request)
```
For **op_get_segment**, the request sends `p_sgmt_length` = buffer size wanted and empty
`p_sgmt_segment`. The response is an `op_response` whose `p_resp_data` cstring is a **packed
buffer of one-or-more segments** using **2-byte little-endian length prefixes**
(`interface.cpp:5665-5717`):
```
[len_lo][len_hi] <len bytes> [len_lo][len_hi] <len bytes> ...
```
i.e. each segment = 2-byte LE length then that many raw bytes, concatenated (NO 4-byte
alignment/padding between segments — this is inside the opaque `p_resp_data`, not XDR). The
client reads the count word as `l = *p++; l += *p++ << 8;` (`interface.cpp:5680-5681`).
`p_resp_object` in the get response: **1** = the buffer ends mid-segment (more of this segment
pending, RESULT_SEGMENT), **2** = EOF pending after this buffer (`interface.cpp:5773-5777`).

For **op_put_segment**, `p_sgmt_length` and `p_sgmt_segment` carry one segment. **op_batch_segments**
packs multiple segments into `p_sgmt_segment` using the same 2-byte LE length framing.

### op_seek_blob (61) — `P_SEEK` (protocol.h:546-551), wire `protocol.cpp:489-495`
```
xdr_short p_seek_blob     // blob handle
xdr_short p_seek_mode     // 0=from start, 1=from current, 2=from end
xdr_long  p_seek_offset
```
### op_close_blob (39) / op_cancel_blob (38) — release form (`protocol.cpp:538-539`): single `xdr_short` object id.

### Blob info items (`inf_pub.h:442-445`)
```
isc_info_blob_num_segments  = 4
isc_info_blob_max_segment   = 5
isc_info_blob_total_length  = 6
isc_info_blob_type          = 7
```
op_info_blob (43) uses the generic `P_INFO` (see below). `isc_info_blob_type` value: 0 =
segmented, 1 = stream.

### op_info_* generic (`P_INFO`, protocol.h:555-562), wire `protocol.cpp:505-523`
```
xdr_short p_info_object          // handle (db/tra/blob/statement)
xdr_short p_info_incarnation
cstring   p_info_items           // requested item bytes
[ if op_service_info: cstring p_info_recv_items ]
xdr_long  p_info_buffer_length   // max response length (fixupLength applied)
```
Covers op_info_database(40), op_info_request(41), op_info_transaction(42), op_info_blob(43),
op_service_info(84), op_info_sql(70), op_info_batch(111), op_info_cursor(113).

---

## 13. Events and aux (async) connection

### op_connect_request (53) / op_aux_connect (54) — `P_REQ` (protocol.h:585-593), wire `protocol.cpp:378-385`
```
xdr_short p_req_type      // P_REQ_async = 1  (request an auxiliary asynchronous port)
xdr_short p_req_object
xdr_long  p_req_partner
```
`P_REQ_async = 1` (protocol.h:593). The client sends `op_connect_request { P_REQ_async }`; the
server responds with an `op_response` whose `p_resp_data` cstring contains a **`SockAddr`
(sockaddr) blob** describing the aux port to connect to.

Aux port address parsing (`inet.cpp:1475-1596`, `aux_connect`):
- Server builds `p_resp_data` from `SockAddr` (`aux_request`, inet.cpp:1701-1702:
  `memcpy(p_resp_data.cstr_address, port_address.ptr(), port_address.length())`).
- Client constructs `SockAddr resp_address(p_resp_data.cstr_address, p_resp_data.cstr_length)`
  and **uses only the port number from it**, combining with the *original* server IP (to survive
  NAT) — `address.setPort(resp_address.port())` (inet.cpp:1558-1568). Then it opens a new TCP
  socket and connects. The async/event channel then delivers `op_event` packets.

`SockAddr` is a raw `struct sockaddr_in`/`sockaddr_in6` byte image (see `src/remote/SockAddr.h`).

### op_que_events (48) / op_event (52) / op_cancel_events (49) — `P_EVENT` (protocol.h:566-573)
op_que_events wire (`protocol.cpp:564-580`):
```
xdr_short p_event_database
cstring   p_event_items       // Event Parameter Block (EPB)
xdr_long  p_event_ast         // (transmitted but ignored by client; debug only)
xdr_long  p_event_arg         // (ignored)
xdr_long  p_event_rid         // client-side remote-event id
```
op_cancel_events wire (`protocol.cpp:582-589`): `xdr_short p_event_database` + `xdr_long p_event_rid`.

### Event Parameter Block (EPB) format
Version byte `EPB_version1 = 1` (`src/jrd/event.h:140`), then per event
(`src/yvalve/utl.cpp:1896-1919`):
```
[EPB_version1]  for each event: [name_len byte][name bytes][count 4 bytes little-endian]
```
Concretely: `*p++ = strlen(name)`; copy the name bytes; then **4 bytes of current count**
(written as four separate bytes, low-order first — a little-endian ULONG). In the initial
`isc_event_block` the counts are zeroed. The result buffer returned in `op_event` has the same
structure with updated counts, from which the client computes per-event deltas.

`op_event` (delivered on the aux channel) carries the updated EPB and the `p_event_rid` so the
client matches it to the registered callback (wire same struct as op_que_events,
`protocol.cpp:564-580`).

---

## 14. FB4 / FB5 additions relevant to a driver

### Statement / session timeouts (FB4, protocol >= 16)
- `op_execute`/`op_execute2` carry `p_sqldata_timeout` (u_long, ms) when
  `port_protocol >= PROTOCOL_STMT_TOUT (16)` (`protocol.cpp:673-674`).
- Info items `isc_info_sql_stmt_timeout_user=28`, `isc_info_sql_stmt_timeout_run=29`
  (inf_pub.h). DB info `fb_info_statement_timeout_db=135`, `fb_info_statement_timeout_att=136`,
  and idle-timeout items `fb_info_ses_idle_timeout_db=129 / _att=130 / _run=131` (inf_pub.h).

### Scrollable cursors (FB5, protocol >= 18)
- `op_fetch_scroll (112)` with `p_sqldata_fetch_op` (P_FETCH) + `p_sqldata_fetch_pos`
  (see §9). Enabled by `p_sqldata_cursor_flags & CURSOR_TYPE_SCROLLABLE (0x1)` set on
  op_execute (present when protocol >= 18).

### Inline blobs (FB5, protocol >= 19)
- `op_inline_blob (114)` — `P_INLINE_BLOB` (protocol.h:783-789), wire `protocol.cpp:1147-1180`:
  ```
  xdr_short p_tran_id
  xdr_quad  p_blob_id
  xdr_response p_blob_info    // blob info clumplets
  <blob data buffer>          // via xdr_blobBuffer
  ```
  The server proactively pushes a small blob's contents alongside a fetched row so the client
  can serve `getSegment` from cache without a round trip. Gated by `p_sqldata_inline_blob_size`
  (u_long, protocol.cpp:677-678) and DPB `isc_dpb_max_inline_blob_size (104)`.
  `MAX_INLINE_BLOB_SIZE = DEFAULT_INLINE_BLOB_SIZE = MAX_USHORT (65535)` (remote.h:107-108).

### Batch API (FB4+, opcodes 99-111)
Structs in protocol.h:723-772; wire in protocol.cpp:859-1134.
- **op_batch_create (99)** — `P_BATCH_CREATE`:
  ```
  xdr_short p_batch_statement
  cstring   p_batch_blr        // input-message BLR
  xdr_u_long p_batch_msglen    // explicit message length
  cstring   p_batch_pb         // batch parameters block
  ```
  Batch PB tags (`FirebirdInterface.idl:539-560`, IBatch): version `VERSION1 = 1`;
  `TAG_MULTIERROR=1, TAG_RECORD_COUNTS=2, TAG_BUFFER_BYTES_SIZE=3, TAG_BLOB_POLICY=4,
  TAG_DETAILED_ERRORS=5`. Blob policy values: `BLOB_NONE=0, BLOB_ID_ENGINE=1, BLOB_ID_USER=2,
  BLOB_STREAM=3`. Info items: `INF_BUFFER_BYTES_SIZE=10, INF_DATA_BYTES_SIZE=11,
  INF_BLOBS_BYTES_SIZE=12, INF_BLOB_ALIGNMENT=13, INF_BLOB_HEADER=14`, and
  `INF_RECORD_COUNT=10` (IBatchCompletionState).
- **op_batch_msg (100)** — `P_BATCH_MSG`: `xdr_short statement; xdr_u_long p_batch_messages;`
  then `p_batch_messages` **packed messages** (each via `xdr_packed_message`, aligned to
  `FB_ALIGN(fmt_length, FB_ALIGNMENT)` = `rsr_batch_size`) (protocol.cpp:872-936).
- **op_batch_exec (101)** — `P_BATCH_EXEC`: `xdr_short statement; xdr_short transaction`.
- **op_batch_rls (102)** — release; single object id (protocol.cpp:546).
- **op_batch_cs (103)** — `P_BATCH_CS` completion state, server→client
  (protocol.cpp:950-1090):
  ```
  xdr_short  p_batch_statement
  xdr_u_long p_batch_reccount   // total records
  xdr_u_long p_batch_updates    // count of update-counter longs that follow
  xdr_u_long p_batch_vectors    // count of (recno + status-vector) pairs
  xdr_u_long p_batch_errors     // count of status-less error recnos
  <p_batch_updates × xdr_long>                 // per-record update counts
  <p_batch_vectors × (xdr_u_long pos + status_vector)>
  <p_batch_errors × xdr_u_long pos>
  ```
- **op_batch_regblob (104)** — `P_BATCH_REGBLOB`: `xdr_short statement; xdr_quad exist_id;
  xdr_quad blob_id` (register existing blob) (protocol.cpp:1117-1125).
- **op_batch_blob_stream (105)** — `P_BATCH_BLOB`: `xdr_short statement` then a blob stream
  (`xdr_blob_stream`, protocol.cpp:1127-1135). Stream framing (protocol.cpp `xdr_blob_stream`):
  a `xdr_u_long` total length, then repeated blob headers each =
  `ISC_QUAD blobId (xdr_quad) + ULONG blobSize (xdr_u_long) + ULONG bpbSize (xdr_u_long)`
  (`SIZEOF_BLOB_HEAD = sizeof(ISC_QUAD)+2*sizeof(ULONG) = 16`, remote.h:714), followed by BPB
  bytes then segment/blob data, **4-byte aligned** (`BLOB_STREAM_ALIGN = 4`, dsql/DsqlBatch.h:60).
- **op_batch_set_bpb (106)** — `P_BATCH_SETBPB`: `xdr_short statement; cstring bpb`
  (protocol.cpp:1097-1115).
- **op_batch_cancel (109)** — single object id (protocol.cpp:547).
- **op_batch_sync (110)** — no body (protocol.cpp:1092), protocol >= 17. Round-trip barrier.
- **op_info_batch (111)** — generic `P_INFO` (protocol.cpp:511), protocol >= 17.

### Session reset (ALTER SESSION RESET)
Feature-flag advertised via DB info `fb_info_features` list value
`fb_feature_session_reset = 4` (`inf_pub.h:207-218`). Executed as a normal DSQL statement
`ALTER SESSION RESET` — no dedicated opcode. Related DPB: `isc_dpb_reset_icu (89)`.
Feature flags list: `fb_feature_multi_statements=1, multi_transactions=2, named_parameters=3,
session_reset=4, read_consistency=5, statement_timeout=6, statement_long_life=7`.

### Compression negotiation flag
`pflag_compress = 0x100` in the protocol-version offer's `p_cnct_max_type` high byte (§3, §6).
Not a separate opcode or DPB tag on the connect path (DPB `isc_dpb_addr_flag_conn_compressed`
is only used inside the address-path clumplet for informational purposes).

---

## Appendix A — Handshake sequence (client view), protocol 13+ with SRP + wire crypt

1. TCP connect to host:3050.
2. Send `op_connect` (§3): file=db path, offer protocols 10..19(/20), user_id clumplets with
   `CNCT_login`, `CNCT_plugin_name="Srp256"`, `CNCT_plugin_list`, `CNCT_specific_data`
   (SRP client public key A hex, multi-part), `CNCT_client_crypt`.
3. Receive one of:
   - `op_accept` (3): plain accept, no auth data (legacy) → proceed to attach with credentials
     in DPB.
   - `op_accept_data` (94): has `p_acpt_data` (SRP salt+B), `p_acpt_plugin`,
     `p_acpt_authenticated`, `p_acpt_keys`. If `authenticated==1`, auth done.
   - `op_cond_accept` (98): same data but must continue auth via `op_cont_auth` before attach.
   - `op_reject` (4): connection refused.
   - `op_crypt_key_callback` (97): db-crypt-key callback during connect (p15+); answer and loop.
4. If continuing: compute SRP client proof M from salt+B (§5), send `op_cont_auth (92)`
   `{ p_data = M hex, p_name = plugin, p_list = plugin list (first time only), p_keys }`.
   Server replies `op_cont_auth` again (more data) or an `op_response`/accept meaning success.
5. On auth success, if wire crypt enabled: `tryNewKeys` → send `op_crypt (96)`
   `{ p_plugin="Arc4", p_key="Srp256" }` keyed with session key K; read the (unencrypted) OK
   `op_response`; set crypt-complete → all further traffic RC4-encrypted (and optionally zlib
   compressed underneath).
6. Send `op_attach (19)` (or `op_create (20)`): `{ p_atch_database=0, p_atch_file, p_atch_dpb }`.
   DPB carries `isc_dpb_user_name`, and for the finished SRP the auth is already done via the
   key exchange (no password in DPB). Response `op_response` with `p_resp_object` = db handle.

## Appendix B — op_attach / op_create / op_service_attach (protocol.h:479-484, protocol.cpp:387-395)
```
xdr_short p_atch_database    // 0 on attach
cstring   p_atch_file        // db path/alias (UTF-8)
cstring   p_atch_dpb         // Database Parameter Block
```

## Appendix C — op_transaction / op_reconnect (P_STTR, protocol.h:496-500, protocol.cpp:497-503)
```
xdr_short p_sttr_database
cstring   p_sttr_tpb
```
Response `op_response` → `p_resp_object` = transaction handle.

## Appendix D — op_compile / op_ddl / op_prepare2 / op_release
- op_compile (22): `xdr_short p_cmpl_database; cstring p_cmpl_blr` (protocol.cpp:397-402).
- op_ddl (55): `xdr_short p_ddl_database; xdr_short p_ddl_transaction; cstring p_ddl_blr`
  (protocol.cpp:591-599).
- op_prepare2 (51): `xdr_short p_prep_transaction; cstring p_prep_data` (2-phase commit prep,
  protocol.cpp:557-562).
- op_commit(30)/op_rollback(31)/op_prepare(32)/op_detach(21)/op_drop_database(81)/
  op_commit_retaining(50)/op_rollback_retaining(86)/op_allocate_statement(62): all use the
  release form = single `xdr_short` object id (protocol.cpp:533-555).

## Appendix E — BLR type codes (`src/include/firebird/impl/blr.h`) needed to build message BLR
Message BLR wraps the SQLDA into a format the server parses (`PARSE_msg_format`). Core scalar
codes (each often followed by parameters):
```
blr_version4 = 4     blr_version5 = 5     blr_eoc = 76     blr_end = 255
blr_begin = 2        blr_message = 4      blr_bool_as_value = 201
blr_short   = 7   (followed by scale byte)
blr_long    = 8   (scale)
blr_quad    = 9   (scale)
blr_float   = 10
blr_d_float = 11
blr_sql_date= 12
blr_sql_time= 13
blr_text    = 14  (len word)         blr_text2   = 15 (charset word + len word)
blr_int64   = 16  (scale)
blr_blob2   = 17
blr_double  = 27
blr_varying = 37  (len word)         blr_varying2= 38 (charset + len)
blr_cstring = 40  (len)              blr_cstring2= 41 (charset + len)
blr_blob_id = 45
blr_bool    = 23
blr_dec64   = 24
blr_dec128  = 25
blr_int128  = 26  (scale)
blr_sql_time_tz     = 28
blr_timestamp_tz    = 29
blr_ex_time_tz      = 30
blr_ex_timestamp_tz = 31
blr_timestamp = 35   (blr_date is alias)
blr_boolean   = 71
blr_blob      = 261  (unsigned short — the descriptor form)
```
A DSQL input/output message BLR is typically:
`blr_version5, blr_begin, blr_message, <msg#>, <2*ncol word>, <per-col: type-blr, blr_short 0
(null indicator)>..., blr_end, blr_eoc`. Each SQL column emits its value descriptor followed by
a `blr_short` (the NULL indicator), which is why `fmt_desc.getCount()` is always even (§10).

---

### Cross-reference: constants a TS implementation must hardcode
- Big-endian XDR, 4-byte units, 4-byte padding.
- Protocol versions 10..20 with 0x8000 flag on 11+ (§1).
- Opcodes 0..114 (§2).
- CNCT tags 1..11 (§3); DPB/TPB/BPB tags (§7/§8/§12).
- SRP: N (1024-bit hex above), g=2, k=SHA1(N‖pad(g))=DFC212B4BD69674855CFCEB30002B5C306AC60B5,
  salt 32B, key 128B, session key K=SHA1(S), proof hash = SHA1 (Srp) / SHA256 (Srp256) (§5).
- RC4 key = 20-byte session key K; "Symmetric"; plugin "Arc4" (§6).
- Packed message NULL bitmap: `(ncol+7)/8` bytes, LSB-first, padded to 4 (§10).
- Date base = 1858-11-17; time unit = 1/10000 s; offset TZ id = minutes + 1439 (§10).
- Blob segment framing = 2-byte little-endian length prefixes inside p_resp_data (§12).
- Fetch EOF = op_fetch_response with p_sqldata_status == 100 (§9).
- DSQL_close=1 / DSQL_drop=2 / DSQL_unprepare=4 (§9).
