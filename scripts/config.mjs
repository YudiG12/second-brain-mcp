#!/usr/bin/env node
// Prints one setting of this deployment, read from wrangler.jsonc: the single place to edit when
// you deploy your own copy. Used by the scripts and CI.
//   node scripts/config.mjs <key>
//   node scripts/config.mjs set <key> <value>   (name, account_id, d1_id, kv_id, PUBLIC_URL, CF_ACCOUNT_ID,
//                                              OWNER_GITHUB_ID, GITHUB_CLIENT_ID; keeps comments)
// Keys: account_id, name, namespace (Artifacts), d1, d1_id, kv_id, queue, dlq, any var (PUBLIC_URL, …), and
// subdomain / worker, derived from PUBLIC_URL, which must be https://<worker>.<subdomain>.workers.dev
// (custom domains aren't supported by the scripts). `check` exits non-zero unless the Worker name
// matches PUBLIC_URL and CF_ACCOUNT_ID matches account_id.
// WRANGLER_CONFIG points at another file (tests).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = process.env.WRANGLER_CONFIG ?? fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

/** JSONC → JSON: drops comments and trailing commas outside strings, and a leading BOM. */
function stripJsonc(src) {
  src = src.replace(/^﻿/, "");
  let out = "", inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") out += src[++i];
      else if (c === '"') inStr = false;
    } else if (c === '"') { inStr = true; out += c; }
    else if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; }
    else if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; }
    else if (c === ",") {
      // a comma followed only by whitespace/comments and then } or ] is a trailing comma
      let j = i + 1;
      for (;;) {
        while (j < src.length && /\s/.test(src[j])) j++;
        if (src[j] === "/" && src[j + 1] === "/") { while (j < src.length && src[j] !== "\n") j++; continue; }
        if (src[j] === "/" && src[j + 1] === "*") { j += 2; while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++; j += 2; continue; }
        break;
      }
      if (src[j] !== "}" && src[j] !== "]") out += c;
    } else out += c;
  }
  return out;
}

const die = (msg) => { console.error(`config: ${msg}`); process.exit(1); };
if (process.argv[2] === "set") setValue(process.argv[3], process.argv[4]);
const key = process.argv[2] ?? die("usage: node scripts/config.mjs <key> | set <key> <value>");
let cfg;
try { cfg = JSON.parse(stripJsonc(readFileSync(file, "utf8"))); } catch (e) { die(`can't read ${file}: ${e.message}`); }
const vars = cfg.vars ?? {};

function host() {
  const url = vars.PUBLIC_URL ?? die("PUBLIC_URL is not set in vars");
  let hostname;
  try { hostname = new URL(url).hostname; } catch { die(`PUBLIC_URL (${url}) is not a URL`); }
  const m = hostname.match(/^([^.]+)\.([^.]+)\.workers\.dev$/);
  return m ?? die(`PUBLIC_URL (${url}) must be https://<worker>.<subdomain>.workers.dev; custom domains aren't supported by the scripts`);
}

function check() {
  const [, worker] = host();
  if (cfg.name !== worker) die(`the Worker name in wrangler.jsonc ("${cfg.name}") must match PUBLIC_URL (${worker}.…)`);
  if (vars.CF_ACCOUNT_ID !== cfg.account_id) die(`vars.CF_ACCOUNT_ID (${vars.CF_ACCOUNT_ID}) must equal account_id (${cfg.account_id})`);
  return "ok";
}

/** `set <key> <value>`: rewrites one value in place, keeping comments and layout, then checks it. */
function setValue(k, v) {
  if (!k || v === undefined) die("usage: node scripts/config.mjs set <key> <value>");
  if (/["\\\n]/.test(v)) die(`refusing a value with a quote, backslash or newline: ${k}`);
  const where = { // [section to search after, field name, how to read it back]
    name: [null, "name", (c) => c.name],
    account_id: [null, "account_id", (c) => c.account_id],
    d1_id: ['"d1_databases"', "database_id", (c) => c.d1_databases?.[0]?.database_id],
    kv_id: ['"kv_namespaces"', "id", (c) => c.kv_namespaces?.[0]?.id],
  }[k] ?? (["PUBLIC_URL", "CF_ACCOUNT_ID", "OWNER_GITHUB_ID", "GITHUB_CLIENT_ID"].includes(k) ? ['"vars"', k, (c) => c.vars?.[k]] : die(`can't set ${k}`));
  const [after, field, read] = where;
  const src = readFileSync(file, "utf8");
  const from = after ? src.indexOf(after) : 0;
  if (from < 0) die(`no ${after} in ${file}`);
  const re = new RegExp(`("${field}"\\s*:\\s*)"[^"\\n]*"`, "g");
  re.lastIndex = from;
  const m = re.exec(src) ?? die(`no "${field}" in ${file}`);
  const out = src.slice(0, m.index) + m[1] + JSON.stringify(v) + src.slice(m.index + m[0].length);
  if (read(JSON.parse(stripJsonc(out))) !== v) die(`writing ${k} changed the wrong value; edit ${file} by hand`);
  writeFileSync(file, out);
  process.exit(0);
}

const derived = {
  account_id: () => cfg.account_id,
  name: () => cfg.name,
  namespace: () => cfg.artifacts?.[0]?.namespace,
  d1: () => cfg.d1_databases?.[0]?.database_name,
  d1_id: () => cfg.d1_databases?.[0]?.database_id,
  kv_id: () => cfg.kv_namespaces?.[0]?.id,
  queue: () => cfg.queues?.producers?.[0]?.queue,
  dlq: () => cfg.queues?.consumers?.[0]?.dead_letter_queue,
  subdomain: () => host()[2],
  worker: () => host()[1],
  check,
};
const value = Object.hasOwn(derived, key) ? derived[key]() : Object.hasOwn(vars, key) ? vars[key] : undefined;
if (value === undefined || value === "" || typeof value === "object") die(`unknown or empty key: ${key}`);
console.log(value);
