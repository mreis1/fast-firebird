import { hostname, userInfo } from 'node:os';
import {
  ARCHITECTURE_GENERIC,
  AUTH_PLUGIN_LIST,
  Cnct,
  CONNECT_VERSION3,
  FB_PROTOCOL_FLAG,
  Op,
  PFLAG_COMPRESS,
  Ptype,
  SUPPORTED_PROTOCOLS,
  WireCryptLevel,
} from './constants.js';
import { ParamBuffer } from './buffers.js';
import { computeProof, generateEphemeral, parseServerAuthData } from './auth/srp.js';
import { legacyHash } from './auth/legacy.js';
import { Arc4Filter } from './crypt/arc4.js';
import { ChaChaFilter } from './crypt/chacha.js';
import { FirebirdAuthError, FirebirdProtocolError } from '../api/errors.js';
import type { WireConnection } from './wire.js';

export interface HandshakeOptions {
  database: string;
  user: string;
  password: string;
  wireCrypt: WireCryptLevel;
  /** Request zlib wire compression (server must have WireCompression on). */
  wireCompression?: boolean;
  /** Wire-crypt plugin to request: Arc4 (default), ChaCha, ChaCha64. */
  wireCryptPlugin?: string;
  authPlugin?: string; // default: first of AUTH_PLUGIN_LIST
  /** @internal Deterministic SRP ephemeral seed — testing only. */
  srpSeed?: Buffer;
}

export interface PendingAuth {
  ephemeral: ReturnType<typeof generateEphemeral>;
  plugin: string;
  user: string;
  password: string;
  /** Legacy_Auth DES-crypt token, when the plugin is Legacy_Auth. */
  legacyToken?: string;
}

export interface HandshakeResult {
  /** Negotiated protocol version (13..16). */
  protocolVersion: number;
  /** Negotiated packet type (ptype_lazy_send for all offers we make). */
  minType: number;
  /** SRP session key when authentication completed with one. */
  sessionKey: Buffer | null;
  /** Auth proof to embed in the attach DPB (op_accept_data path), hex. */
  dpbAuthData: string | null;
  /**
   * Set when the server sent no auth data yet (FB3 with wire crypt
   * disabled): SRP continues in response to op_attach/op_create.
   */
  pendingAuth: PendingAuth | null;
  /** True when the wire is now encrypted. */
  encrypted: boolean;
  /** Negotiated wire-crypt plugin name (Arc4/ChaCha/ChaCha64), or null. */
  cryptPlugin: string | null;
  /** True when zlib wire compression was negotiated. */
  compressed: boolean;
}

/** Split data into 254-byte chunks: [tag, len+1, step, ...chunk] each. */
function addMultiblock(pb: ParamBuffer, tag: number, data: Buffer): void {
  let step = 0;
  for (let off = 0; off < data.length || step === 0; off += 254) {
    pb.bytes(tag, Buffer.concat([Buffer.from([step++]), data.subarray(off, off + 254)]));
  }
}

function buildUserIdentification(opts: HandshakeOptions, plugin: string, pluginList: string, specificData: Buffer): Buffer {
  const pb = new ParamBuffer();
  pb.string(Cnct.login, opts.user);
  pb.string(Cnct.plugin_name, plugin);
  pb.string(Cnct.plugin_list, pluginList);
  addMultiblock(pb, Cnct.specific_data, specificData);
  pb.bytes(Cnct.client_crypt, Buffer.from([opts.wireCrypt, 0, 0, 0])); // int32 LE
  let osUser = 'node';
  try {
    osUser = userInfo().username;
  } catch {
    /* keep default */
  }
  pb.string(Cnct.user, osUser);
  pb.string(Cnct.host, hostname());
  pb.bytes(Cnct.user_verification, Buffer.alloc(0));
  return pb.toBuffer();
}

interface AcceptPacket {
  op: number;
  version: number;
  architecture: number;
  type: number;
  data: Buffer;
  pluginName: string;
  isAuthenticated: boolean;
  keys: string;
}

async function readAccept(wire: WireConnection): Promise<AcceptPacket> {
  const op = await wire.readOp();
  if (op === Op.response) {
    await wire.parseResponseBody(); // throws with the server's error
    throw new FirebirdProtocolError('Server rejected connection');
  }
  if (op === Op.reject) throw new FirebirdProtocolError('Server rejected the connection (op_reject)');
  if (op !== Op.accept && op !== Op.accept_data && op !== Op.cond_accept) {
    throw new FirebirdProtocolError(`Unexpected handshake response op ${op}`);
  }
  let version = await wire.readInt32();
  if (version < 0) version = version & 0xffff;
  const architecture = await wire.readInt32();
  const type = await wire.readInt32();
  if (op === Op.accept) {
    return { op, version, architecture, type, data: Buffer.alloc(0), pluginName: '', isAuthenticated: true, keys: '' };
  }
  const data = Buffer.from(await wire.readOpaque());
  const pluginName = await wire.readString();
  const isAuthenticated = (await wire.readInt32()) === 1;
  const keys = await wire.readString();
  return { op, version, architecture, type, data, pluginName, isAuthenticated, keys };
}

export function sendContAuth(wire: WireConnection, authData: string, plugin: string, pluginList = AUTH_PLUGIN_LIST): void {
  wire.writer
    .int32(Op.cont_auth)
    .string(authData, 'latin1')
    .string(plugin)
    .string(pluginList)
    .uint32(0); // empty keys
  wire.flush();
}

export async function performHandshake(wire: WireConnection, opts: HandshakeOptions): Promise<HandshakeResult> {
  const isLegacy = opts.authPlugin === 'Legacy_Auth';
  const plugin = isLegacy ? 'Legacy_Auth' : (opts.authPlugin ?? AUTH_PLUGIN_LIST.split(',')[0]!);
  const pluginList = isLegacy ? 'Legacy_Auth' : AUTH_PLUGIN_LIST;
  const ephemeral = generateEphemeral(opts.srpSeed);
  // Legacy_Auth: the DES crypt hash IS the auth token (no SRP salt/key rounds).
  const legacyToken = isLegacy ? legacyHash(opts.password) : null;
  const specificData = Buffer.from(isLegacy ? legacyToken! : ephemeral.publicHex, 'latin1');

  const w = wire.writer;
  w.int32(Op.connect)
    .int32(Op.attach)
    .int32(CONNECT_VERSION3)
    .int32(ARCHITECTURE_GENERIC)
    .string(opts.database)
    .int32(SUPPORTED_PROTOCOLS.length)
    .opaque(buildUserIdentification(opts, plugin, pluginList, specificData));
  for (const [version, arch, minT, maxT, weight] of SUPPORTED_PROTOCOLS) {
    const max = opts.wireCompression ? maxT | PFLAG_COMPRESS : maxT;
    w.uint32(version).int32(arch).int32(minT).int32(max).int32(weight);
  }
  wire.flush();

  const accept = await readAccept(wire);
  const protocolVersion = accept.version & ~FB_PROTOCOL_FLAG & 0xffff;
  wire.protocolVersion = protocolVersion;
  if (protocolVersion < 13) {
    throw new FirebirdProtocolError(
      `Server negotiated protocol ${protocolVersion}; fast-firebird requires Firebird 3+ (protocol 13)`,
    );
  }

  // Compression covers every byte after the accept packet, both directions.
  const compressed = (accept.type & PFLAG_COMPRESS) !== 0;
  if (compressed) wire.transport.enableCompression();

  let sessionKey: Buffer | null = null;
  let dpbAuthData: string | null = null;
  let pendingAuth: PendingAuth | null = null;
  let activePlugin = accept.pluginName || plugin;
  let serverData = accept.data;
  let keys = accept.keys;
  /** Raw p_resp_data clumplet blob carrying wire-crypt plugin IVs, if any. */
  let serverKeyData: Buffer = Buffer.alloc(0);

  if (isLegacy && (!accept.isAuthenticated || accept.op === Op.cond_accept)) {
    // Legacy_Auth is single-round: the DES hash was sent in CNCT_specific_data.
    if (accept.op === Op.cond_accept) {
      // Server wants the token via continuation.
      sendContAuth(wire, legacyToken!, 'Legacy_Auth', 'Legacy_Auth');
      for (;;) {
        const op = await wire.readOp();
        if (op === Op.response) {
          await wire.parseResponseBody();
          break;
        }
        if (op === Op.cont_auth) {
          await wire.readOpaque();
          await wire.readString();
          await wire.readString();
          await wire.readString();
          // A re-offer means the legacy credentials were rejected.
          throw new FirebirdAuthError(
            'Your user name and password are not defined. Ask your database administrator to set up a Firebird login.',
            335544472,
            '28000',
          );
        }
        throw new FirebirdProtocolError(`Unexpected op ${op} during Legacy_Auth continuation`);
      }
    } else {
      // op_accept_data: the token rides in the attach DPB.
      dpbAuthData = legacyToken;
    }
    pendingAuth = { ephemeral, plugin: 'Legacy_Auth', user: opts.user, password: opts.password, legacyToken: legacyToken! };
  } else if (!accept.isAuthenticated || accept.op === Op.cond_accept) {
    // op_cond_accept with no data: server wants continuation rounds now.
    let rounds = 0;
    while (serverData.length === 0 && accept.op === Op.cond_accept) {
      if (++rounds > 4) throw new FirebirdAuthError('SRP negotiation did not converge');
      sendContAuth(wire, ephemeral.publicHex, activePlugin);
      const op = await wire.readOp();
      if (op === Op.response) {
        await wire.parseResponseBody();
        throw new FirebirdProtocolError('Server ended auth negotiation without credentials exchange');
      }
      if (op !== Op.cont_auth) throw new FirebirdProtocolError(`Expected op_cont_auth, got ${op}`);
      serverData = Buffer.from(await wire.readOpaque());
      const nextPlugin = await wire.readString();
      await wire.readString(); // plugin list
      keys = await wire.readString();
      if (nextPlugin) activePlugin = nextPlugin;
    }

    if (serverData.length > 0) {
      if (!activePlugin.startsWith('Srp')) {
        throw new FirebirdAuthError(`Server requested unsupported auth plugin '${activePlugin}'`);
      }
      const sd = parseServerAuthData(serverData);
      const proof = computeProof(activePlugin, opts.user, opts.password, sd.salt, ephemeral, sd.serverKeyHex);
      sessionKey = proof.sessionKey;
      if (accept.op === Op.cond_accept) {
        // Each plugin gets exactly ONE proof attempt. The server re-sends a
        // fresh salt+key when a proof fails (wrong password) rather than an
        // error op_response, so a re-offer of an already-attempted plugin
        // means authentication failed — stop, don't proof again forever.
        const attempted = new Set<string>([activePlugin]);
        sendContAuth(wire, proof.proofHex, activePlugin, activePlugin);
        for (;;) {
          const op = await wire.readOp();
          if (op === Op.response) {
            const resp = await wire.parseResponseBody();
            if (resp.data.length > 0) serverKeyData = resp.data; // may carry crypt IV
            break;
          }
          if (op === Op.cont_auth) {
            const data = Buffer.from(await wire.readOpaque());
            const nextPlugin = (await wire.readString()) || activePlugin;
            await wire.readString(); // plugin list
            const nextKeys = await wire.readString();
            if (nextKeys) keys = nextKeys;
            if (data.length === 0) continue; // server proof (M2) — ignore
            if (attempted.has(nextPlugin)) {
              throw new FirebirdAuthError(
                'Your user name and password are not defined. Ask your database administrator to set up a Firebird login.',
                335544472,
                '28000',
              );
            }
            if (!nextPlugin.startsWith('Srp')) {
              throw new FirebirdAuthError(`Server switched to unsupported auth plugin '${nextPlugin}'`);
            }
            activePlugin = nextPlugin;
            attempted.add(activePlugin);
            const next = parseServerAuthData(data);
            const p2 = computeProof(activePlugin, opts.user, opts.password, next.salt, ephemeral, next.serverKeyHex);
            sessionKey = p2.sessionKey;
            sendContAuth(wire, p2.proofHex, activePlugin, activePlugin);
            continue;
          }
          throw new FirebirdProtocolError(`Unexpected op ${op} during auth continuation`);
        }
      } else {
        dpbAuthData = proof.proofHex; // op_accept_data path: proof rides in the DPB
      }
    }
    // Attach-time continuation stays available in every path: the server can
    // still answer op_attach with op_cont_auth (FB3 crypt-off, or a plugin
    // switch after a DPB-carried proof).
    pendingAuth = { ephemeral, plugin: activePlugin, user: opts.user, password: opts.password };
  }

  // Wire encryption.
  let encrypted = false;
  let cryptPlugin: string | null = null;
  const wantCrypt = opts.wireCrypt !== WireCryptLevel.disabled;
  if (wantCrypt && sessionKey) {
    const plugin = selectCryptPlugin(keys, opts.wireCryptPlugin);
    if (plugin) {
      cryptPlugin = plugin;
      wire.writer.int32(Op.crypt).string(plugin).string('Symmetric');
      wire.flush();
      try {
        if (plugin === 'Arc4') {
          // RC4 engages the instant op_crypt is sent — the response comes back
          // encrypted. (With compression active, installCrypt waits for the
          // compressor to drain op_crypt before engaging tx-encryption.)
          await wire.transport.installCrypt(new Arc4Filter(sessionKey));
          await wire.readResponse();
        } else {
          // ChaCha (FB4+, protocol ≥16): the server pre-shares its IV in the
          // clumplet blob it sent with the auth-completing op_response
          // (TAG_PLUGIN_SPECIFIC), NOT in the op_crypt response. Engage crypt
          // BEFORE reading the op_crypt response, which arrives encrypted.
          const iv = findPluginIv(serverKeyData, plugin);
          if (!iv) {
            throw new FirebirdAuthError(
              `Server did not advertise a ${plugin} IV; this server build only supports Arc4 wire encryption. ` +
                `Use wireCryptPlugin:'Arc4' (default) or wireCrypt:'disabled'.`,
            );
          }
          await wire.transport.installCrypt(new ChaChaFilter(sessionKey, iv));
          await wire.readResponse();
        }
        encrypted = true;
      } catch (err) {
        // A server with WireCrypt=Disabled rejects op_crypt by dropping the
        // connection. Give an actionable error instead of "connection closed".
        if (err instanceof FirebirdAuthError) throw err;
        throw new FirebirdAuthError(
          `Wire encryption (${plugin}) was refused by the server — it likely has WireCrypt=Disabled. ` +
            `Set wireCrypt:'disabled' on the client to connect unencrypted.`,
        );
      }
    }
  }
  if (!encrypted && opts.wireCrypt === WireCryptLevel.required) {
    throw new FirebirdAuthError('wireCrypt=required but wire encryption could not be established');
  }

  return {
    protocolVersion,
    minType: accept.type & Ptype.mask,
    sessionKey,
    dpbAuthData,
    pendingAuth,
    encrypted,
    cryptPlugin,
    compressed,
  };
}

/**
 * Choose the wire-crypt plugin to request.
 *
 * The Firebird servers we target send an EMPTY `keys` advertisement during the
 * accept (that channel is used for db-crypt key exchange, not a plain plugin
 * list), so there is no reliable capability signal. Arc4 ships with every
 * FB3+ server, so it is the safe default. ChaCha/ChaCha64 (FB4+) are opt-in
 * via `wireCryptPlugin`. When the server DOES advertise a plugin list we honor
 * it as a filter on the requested plugin.
 */
const TAG_PLUGIN_SPECIFIC = 3;

/**
 * Extract a wire-crypt plugin's IV from a server key-data clumplet blob
 * (`UnTagged` format: `[tag:1][len:1][data:len]`). A TAG_PLUGIN_SPECIFIC
 * entry holds `<plugin-name>\0<specific-data>`; for ChaCha the specific data
 * is the IV. Returns null when the plugin isn't present. See
 * firebird remote.cpp rem_port::addServerKeys.
 */
function findPluginIv(blob: Buffer, plugin: string): Buffer | null {
  let pos = 0;
  while (pos + 2 <= blob.length) {
    const tag = blob[pos]!;
    const len = blob[pos + 1]!;
    const data = blob.subarray(pos + 2, pos + 2 + len);
    pos += 2 + len;
    if (tag !== TAG_PLUGIN_SPECIFIC) continue;
    const nul = data.indexOf(0);
    if (nul <= 0) continue;
    if (data.toString('latin1', 0, nul) === plugin) return Buffer.from(data.subarray(nul + 1));
  }
  return null;
}

function selectCryptPlugin(keys: string, requested?: string): string | null {
  const want = requested ?? 'Arc4';
  if (!keys) return want; // no advertisement → trust the request
  const lower = keys.toLowerCase();
  const advertised = (name: string) => new RegExp(`(^|[,\\s:\\0])${name}([,\\s\\0]|$)`).test(lower);
  if (advertised(want.toLowerCase())) return want;
  // Requested plugin not advertised: degrade to Arc4 if offered, else give up.
  return advertised('arc4') ? 'Arc4' : null;
}

/**
 * Read a response that may first require SRP continuation rounds
 * (server answers op_attach/op_create with op_cont_auth — FB3 with
 * wire crypt disabled).
 */
export async function readResponseWithAuth(
  wire: WireConnection,
  pending: PendingAuth | null,
): Promise<import('./wire.js').GenericResponse> {
  for (;;) {
    const op = await wire.readOp();
    if (op === Op.response) return wire.parseResponseBody();
    if (op === Op.cont_auth && pending) {
      const data = Buffer.from(await wire.readOpaque());
      const nextPlugin = await wire.readString();
      await wire.readString(); // plugin list
      await wire.readString(); // keys
      const usePlugin = nextPlugin || pending.plugin;
      if (pending.legacyToken) {
        // Legacy_Auth is one-shot; resend the DES token if asked again.
        sendContAuth(wire, pending.legacyToken, 'Legacy_Auth', 'Legacy_Auth');
        continue;
      }
      if (data.length === 0) {
        sendContAuth(wire, pending.ephemeral.publicHex, usePlugin);
        continue;
      }
      const { salt, serverKeyHex } = parseServerAuthData(data);
      const proof = computeProof(usePlugin, pending.user, pending.password, salt, pending.ephemeral, serverKeyHex);
      sendContAuth(wire, proof.proofHex, usePlugin);
      continue;
    }
    throw new FirebirdProtocolError(`Unexpected op ${op} while awaiting response`);
  }
}
