# Authentication, encryption & compression

## Defaults

`wireCrypt` is `'enabled'` by default (Arc4 negotiated; `'required'` /
`'disabled'` available). ChaCha/ChaCha64 are negotiated on FB4+ via
`wireCryptPlugin`. SRP256/SRP are the default authentication for modern
servers — the driver implements Firebird's exact (non-standard) SRP-6a
variant with `node:crypto` + BigInt.

```ts
const db = await connect({
  host, database, user, password,
  wireCrypt: 'required',          // refuse an unencrypted wire
  wireCryptPlugin: 'ChaCha',      // FB4+; Arc4 is the universal fallback
});
```

## Wire compression

`wireCompression` (zlib) is off by default and requires
`WireCompression = true` on the server; when both are on, the wire is
compressed then encrypted, matching fbclient.

```ts
const db = await connect({ host, database, user, password, wireCompression: true });
```

## Legacy_Auth (old servers)

For migrating from legacy setups (`AuthServer = Legacy_Auth`):

```ts
const db = await connect({
  host, database, user: 'MYUSER', password: 'secret',
  authPlugin: 'Legacy_Auth',
  wireCrypt: 'disabled',   // Legacy_Auth servers typically disable wire crypt
});
```

Uses the DES `crypt(3)` hash (UTF-8 password bytes, matching node-firebird and
fbclient).

## Connect timeouts

`connectTimeout` covers the **whole handshake** — TCP connect, protocol
negotiation, authentication, and wire-crypt setup — not just the socket
connect, so a hung server can't stall startup indefinitely.
