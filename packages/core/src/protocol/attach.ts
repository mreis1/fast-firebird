import { Dpb, Op } from './constants.js';
import { ParamBuffer } from './buffers.js';
import { readResponseWithAuth, type PendingAuth } from './handshake.js';
import type { WireConnection } from './wire.js';
import type { ResolvedOptions } from '../api/options.js';

function buildDpb(opts: ResolvedOptions, dpbAuthData: string | null, forCreate: boolean): Buffer {
  const pb = new ParamBuffer(Dpb.version1);
  pb.string(Dpb.lc_ctype, opts.charset);
  pb.bytes(Dpb.utf8_filename, Buffer.alloc(0));
  pb.string(Dpb.user_name, opts.user);
  if (dpbAuthData) pb.string(Dpb.specific_auth_data, dpbAuthData, (s) => Buffer.from(s, 'latin1'));
  if (opts.role) pb.string(Dpb.sql_role_name, opts.role);
  pb.int32(Dpb.process_id, process.pid);
  pb.string(Dpb.process_name, (process.title || 'node').slice(-250));
  if (forCreate) {
    pb.int32(Dpb.page_size, opts.pageSize);
    pb.byte(Dpb.sql_dialect, 3);
    pb.byte(Dpb.force_write, 1);
    pb.byte(Dpb.overwrite, 0);
    pb.string(Dpb.set_db_charset, opts.charset === 'NONE' ? 'NONE' : opts.charset);
  }
  return pb.toBuffer();
}

/** op_attach → attachment (database object) handle. */
export async function attachDatabase(
  wire: WireConnection,
  opts: ResolvedOptions,
  dpbAuthData: string | null,
  pendingAuth: PendingAuth | null = null,
): Promise<number> {
  wire.writer.int32(Op.attach).int32(0).string(opts.database).opaque(buildDpb(opts, dpbAuthData, false));
  wire.flush();
  return (await readResponseWithAuth(wire, pendingAuth)).handle;
}

/** op_create → creates the database file and attaches to it. */
export async function createDatabase(
  wire: WireConnection,
  opts: ResolvedOptions,
  dpbAuthData: string | null,
  pendingAuth: PendingAuth | null = null,
): Promise<number> {
  wire.writer.int32(Op.create).int32(0).string(opts.database).opaque(buildDpb(opts, dpbAuthData, true));
  wire.flush();
  return (await readResponseWithAuth(wire, pendingAuth)).handle;
}

export async function detachDatabase(wire: WireConnection): Promise<void> {
  wire.writer.int32(Op.detach).int32(0);
  wire.flush();
  await wire.readResponse();
}

export async function dropDatabase(wire: WireConnection, dbHandle: number): Promise<void> {
  wire.writer.int32(Op.drop_database).int32(dbHandle);
  wire.flush();
  await wire.readResponse();
}
