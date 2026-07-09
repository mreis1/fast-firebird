import { hostname, userInfo } from 'node:os';
import {
  ARCHITECTURE_GENERIC,
  AUTH_PLUGIN_LIST,
  Cnct,
  CONNECT_VERSION3,
  FB_PROTOCOL_FLAG,
  Op,
  Ptype,
  SUPPORTED_PROTOCOLS,
  WireCryptLevel,
} from './constants.js';
import { ParamBuffer } from './buffers.js';
import { computeProof, generateEphemeral, parseServerAuthData } from './auth/srp.js';
import { Arc4Filter } from './crypt/arc4.js';
import { FirebirdAuthError, FirebirdProtocolError } from '../api/errors.js';
import type { WireConnection } from './wire.js';

export interface HandshakeOptions {
  database: string;
  user: string;
  password: string;
  wireCrypt: WireCryptLevel;
  authPlugin?: string; // default: first of AUTH_PLUGIN_LIST
  /** @internal Deterministic SRP ephemeral seed — testing only. */
  srpSeed?: Buffer;
}

export interface PendingAuth {
  ephemeral: ReturnType<typeof generateEphemeral>;
  plugin: string;
  user: string;
  password: string;
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
}

/** Split data into 254-byte chunks: [tag, len+1, step, ...chunk] each. */
function addMultiblock(pb: ParamBuffer, tag: number, data: Buffer): void {
  let step = 0;
  for (let off = 0; off < data.length || step === 0; off += 254) {
    pb.bytes(tag, Buffer.concat([Buffer.from([step++]), data.subarray(off, off + 254)]));
  }
}

function buildUserIdentification(opts: HandshakeOptions, publicHex: string, plugin: string): Buffer {
  const pb = new ParamBuffer();
  pb.string(Cnct.login, opts.user);
  pb.string(Cnct.plugin_name, plugin);
  pb.string(Cnct.plugin_list, AUTH_PLUGIN_LIST);
  addMultiblock(pb, Cnct.specific_data, Buffer.from(publicHex, 'latin1'));
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

export function sendContAuth(wire: WireConnection, authData: string, plugin: string): void {
  wire.writer
    .int32(Op.cont_auth)
    .string(authData, 'latin1')
    .string(plugin)
    .string(AUTH_PLUGIN_LIST)
    .uint32(0); // empty keys
  wire.flush();
}

export async function performHandshake(wire: WireConnection, opts: HandshakeOptions): Promise<HandshakeResult> {
  const plugin = opts.authPlugin ?? AUTH_PLUGIN_LIST.split(',')[0]!;
  const ephemeral = generateEphemeral(opts.srpSeed);

  const w = wire.writer;
  w.int32(Op.connect)
    .int32(Op.attach)
    .int32(CONNECT_VERSION3)
    .int32(ARCHITECTURE_GENERIC)
    .string(opts.database)
    .int32(SUPPORTED_PROTOCOLS.length)
    .opaque(buildUserIdentification(opts, ephemeral.publicHex, plugin));
  for (const [version, arch, minT, maxT, weight] of SUPPORTED_PROTOCOLS) {
    w.uint32(version).int32(arch).int32(minT).int32(maxT).int32(weight);
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

  let sessionKey: Buffer | null = null;
  let dpbAuthData: string | null = null;
  let pendingAuth: PendingAuth | null = null;
  let activePlugin = accept.pluginName || plugin;
  let serverData = accept.data;
  let keys = accept.keys;

  if (!accept.isAuthenticated || accept.op === Op.cond_accept) {
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
      const { salt, serverKeyHex } = parseServerAuthData(serverData);
      const proof = computeProof(activePlugin, opts.user, opts.password, salt, ephemeral, serverKeyHex);
      sessionKey = proof.sessionKey;
      if (accept.op === Op.cond_accept) {
        sendContAuth(wire, proof.proofHex, activePlugin);
        // Ignore any op_cont_auth (server proof) until op_response.
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
            keys = await wire.readString();
            continue;
          }
          throw new FirebirdProtocolError(`Unexpected op ${op} during auth continuation`);
        }
      } else {
        dpbAuthData = proof.proofHex; // op_accept_data path: proof rides in the DPB
      }
    } else {
      // op_accept_data with no data (FB3, crypt off): SRP completes in
      // response to the op_attach itself.
      pendingAuth = { ephemeral, plugin: activePlugin, user: opts.user, password: opts.password };
    }
  }

  // Wire encryption.
  let encrypted = false;
  const wantCrypt = opts.wireCrypt !== WireCryptLevel.disabled;
  if (wantCrypt && sessionKey && /(^|[,\s])Arc4([,\s]|$)/.test(keys || 'Arc4')) {
    wire.writer.int32(Op.crypt).string('Arc4').string('Symmetric');
    wire.flush();
    // RC4 starts immediately after op_crypt is sent; the response is encrypted.
    wire.transport.addFilter(new Arc4Filter(sessionKey));
    await wire.readResponse();
    encrypted = true;
  } else if (opts.wireCrypt === WireCryptLevel.required) {
    throw new FirebirdAuthError('wireCrypt=required but wire encryption could not be established');
  }

  return {
    protocolVersion,
    minType: accept.type & Ptype.mask,
    sessionKey,
    dpbAuthData,
    pendingAuth,
    encrypted,
  };
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
