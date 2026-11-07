#!/usr/bin/env node
// Prints one setting of this deployment, read from wrangler.jsonc: the single place to edit when
// you deploy your own copy. Used by the scripts and CI.
//   node scripts/config.mjs <key>
// Keys: account_id, PUBLIC_URL (or any other var), namespace (Artifacts), subdomain and worker
// (both from PUBLIC_URL, which must be <worker>.<subdomain>.workers.dev).
// WRANGLER_CONFIG points at another file (tests).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = process.env.WRANGLER_CONFIG ?? fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

/** JSONC → JSON: drops // and /* *\/ comments outside strings, and trailing commas. */
function stripJsonc(src) {
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
    else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const die = (msg) => { console.error(`config: ${msg}`); process.exit(1); };
const key = process.argv[2] ?? die("usage: node scripts/config.mjs <key>");
let cfg;
try { cfg = JSON.parse(stripJsonc(readFileSync(file, "utf8"))); } catch (e) { die(`can't read ${file}: ${e.message}`); }
const vars = cfg.vars ?? {};

function host() {
  const url = vars.PUBLIC_URL ?? die("PUBLIC_URL is not set in vars");
  const m = new URL(url).hostname.match(/^([^.]+)\.([^.]+)\.workers\.dev$/);
  return m ?? die(`PUBLIC_URL (${url}) is not <worker>.<subdomain>.workers.dev; set the subdomain and worker by hand for a custom domain`);
}

const value = {
  account_id: () => cfg.account_id,
  namespace: () => cfg.artifacts?.[0]?.namespace,
  subdomain: () => host()[2],
  worker: () => host()[1],
}[key]?.() ?? vars[key];
if (value === undefined || value === "") die(`unknown or empty key: ${key}`);
console.log(value);
