export { connect, create as createDatabase, Attachment, type ConnectInput } from './api/attachment.js';
export type { FirebirdConnectionOptions, LegacyOptionAliases, WireCryptOption } from './api/options.js';
export { FirebirdError, FirebirdAuthError, FirebirdConnectionError, FirebirdProtocolError } from './api/errors.js';
export type { FirebirdTranscodeAdapter, DecodeContext, EncodeContext } from './charset/decoder.js';
