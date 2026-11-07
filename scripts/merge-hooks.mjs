#!/usr/bin/env node
// Adds the notes sync hooks (clients/claude-code/settings.hooks.json) to a Claude Code settings
// file, keeping every other setting and hook. Backs the old file up to <file>.bak and writes
// atomically. Leaves a file it can't parse untouched.
//   node scripts/merge-hooks.mjs [~/.claude/settings.json]
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const file = process.argv[2] ?? `${process.env.HOME}/.claude/settings.json`;
const add = JSON.parse(readFileSync(fileURLToPath(new URL("../clients/claude-code/settings.hooks.json", import.meta.url)), "utf8")).hooks;
let settings = {};
if (existsSync(file)) {
  try { settings = JSON.parse(readFileSync(file, "utf8")); }
  catch { console.error(`merge-hooks: can't parse ${file} (comments?); add the hooks from clients/claude-code/settings.hooks.json to it by hand`); process.exit(1); }
  copyFileSync(file, `${file}.bak`);
}
settings.hooks ??= {};
for (const [event, list] of Object.entries(add)) {
  settings.hooks[event] ??= [];
  if (!JSON.stringify(settings.hooks[event]).includes("notes-sync.sh")) settings.hooks[event].push(...list);
}
mkdirSync(dirname(file), { recursive: true });
writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2) + "\n");
renameSync(`${file}.tmp`, file);
