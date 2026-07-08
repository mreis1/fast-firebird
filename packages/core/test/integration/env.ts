/** Shared connection settings for the isolated docker test matrix. */
export interface FbServer {
  name: string;
  port: number;
  /** Major server version. */
  version: 3 | 4 | 5;
}

export const FB_SERVERS: FbServer[] = [
  { name: 'fb3', port: 30503, version: 3 },
  { name: 'fb4', port: 30504, version: 4 },
  { name: 'fb5', port: 30505, version: 5 },
];

export const FB_BASE = {
  host: '127.0.0.1',
  database: '/var/lib/firebird/data/test.fdb',
  user: 'SYSDBA',
  password: 'masterkey',
};
