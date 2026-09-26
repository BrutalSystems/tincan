#!/usr/bin/env node
// Classify every chain break in a Tin Can message log by CAUSE, so a fix can be
// checked against the reason rather than the count.
//
//   node scripts/classify-chain-breaks.mjs [path]     (default ~/.tincan/messages.jsonl)
//
// The distinction that matters: a break where `prev` names an EARLIER record's
// hash is a stale head — the writer chained onto something it had read before.
// A break where `prev` equals the predecessor's OWN `prev` is a genuine race —
// two writers read the same head and both appended. These call for different
// fixes, and the counts alone cannot tell them apart.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const file = process.argv[2] ?? join(homedir(), ".tincan", "messages.jsonl");
const records = [];
for (const line of readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    records.push(JSON.parse(line));
  } catch {
    records.push(null); // unparseable, counted below
  }
}

const byHash = new Map();
records.forEach((r, i) => r?.hash && byHash.set(r.hash, i));

const cause = new Map();
const gap = new Map();
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

let prevHash = null;
let broken = 0;
for (const [i, r] of records.entries()) {
  if (r && "prev" in r && prevHash !== null && r.prev !== prevHash) {
    broken++;
    const before = records[i - 1];
    if (r.prev === "genesis") bump(cause, "prev is genesis");
    else if (before && !("prev" in before)) bump(cause, "follows an unchained record");
    else if (before && before.prev === r.prev) bump(cause, "RACE: same prev as predecessor");
    else if (byHash.has(r.prev)) {
      bump(cause, "STALE HEAD: prev names an earlier record");
      bump(gap, i - byHash.get(r.prev));
    } else bump(cause, "prev names a hash absent from the file");
  }
  prevHash = r?.hash ?? prevHash;
}

const chained = records.filter((r) => r && "prev" in r).length;
const unchained = records.filter((r) => r && !("prev" in r)).length;
console.log(`file        ${file}`);
console.log(`records     ${records.length}  (chained ${chained}, unchained ${unchained}, unparseable ${records.filter((r) => !r).length})`);
console.log(`broken      ${broken}  = ${chained ? ((100 * broken) / chained).toFixed(1) : "0"}% of chained\n`);
console.log("by cause:");
for (const [k, v] of [...cause].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
// Every gap odd is the signature of skipping whole message+outcome pairs: a send
// writes two records, so an even gap would mean landing mid-pair.
console.log("\nstale-head gap (records skipped + 1):");
for (const [k, v] of [...gap].sort((a, b) => a[0] - b[0])) console.log(`  gap ${String(k).padStart(4)}  x${v}${k % 2 === 0 ? "   <-- EVEN, not a whole pair" : ""}`);
