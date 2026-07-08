#!/usr/bin/env node
/**
 * Generates packages/core/src/protocol/messages.json — a gds-code → message
 * template map — from the Firebird source clone in references/firebird.
 *
 * Codes follow Firebird's layout: 0x14000000 | (facility << 16) | number.
 * Templates keep Firebird's @1/@2… parameter placeholders.
 *
 * Usage: node scripts/generate-messages.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const msgDir = join(root, 'references/firebird/src/include/firebird/impl/msg');
const outFile = join(root, 'packages/core/src/protocol/messages.json');

const FACILITIES = {
  jrd: 0, qli: 1, gfix: 3, gpre: 4, dsql: 7, dyn: 8, install: 10, test: 11,
  gbak: 12, sqlerr: 13, sqlwarn: 14, jrd_bugchk: 15, isql: 17, gsec: 18,
  gstat: 21, fbsvcmgr: 22, utl: 23, nbackup: 24, fbtracemgr: 25,
};

const ISC_BASE = 0x14000000;
const map = {};
let total = 0;

for (const file of readdirSync(msgDir)) {
  if (!file.endsWith('.h') || file === 'all.h') continue;
  const facility = FACILITIES[file.replace('.h', '')];
  if (facility === undefined) continue;
  const text = readFileSync(join(msgDir, file), 'utf8');
  // FB_IMPL_MSG(FACILITY, number, symbol, sqlcode, "class", "sub", "text")
  // and FB_IMPL_MSG_NO_SYMBOL(FACILITY, number, "text")
  const re = /FB_IMPL_MSG(?:_NO_SYMBOL|_SYMBOL)?\s*\(\s*\w+\s*,\s*(\d+)\s*,\s*(?:(\w+)\s*,\s*(-?\d+)\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*)?"((?:[^"\\]|\\.)*)"\s*\)/g;
  let m;
  let count = 0;
  while ((m = re.exec(text)) !== null) {
    const number = Number(m[1]);
    const message = m[6].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const code = ISC_BASE + (facility << 16) + number;
    const entry = { m: message };
    if (m[4] && m[5]) entry.s = m[4] + m[5]; // SQLSTATE
    map[code] = entry;
    count++;
  }
  total += count;
  console.log(`${file}: ${count} messages`);
}

writeFileSync(outFile, JSON.stringify(map));
console.log(`Total: ${total} messages → ${outFile}`);
