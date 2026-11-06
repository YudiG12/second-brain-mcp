// Turns Vitest's JSON report into a Markdown comment for the PR.
// Usage: node scripts/test-report.mjs reports/tests.json  (env: GITHUB_REPOSITORY, HEAD_SHA)
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.HEAD_SHA;
const icon = { passed: "✅", failed: "❌", skipped: "⏭️", pending: "⏭️", todo: "📝" };

const tests = report.testResults.flatMap((file) =>
  file.assertionResults.map((t) => {
    const path = relative(process.cwd(), file.name);
    const line = t.location?.line;
    const url = repo && sha ? `https://github.com/${repo}/blob/${sha}/${path}${line ? `#L${line}` : ""}` : null;
    const name = t.fullName.replace(/\|/g, "\\|");
    const firstLine = (t.failureMessages?.[0] ?? "").split("\n")[0].replace(/\|/g, "\\|").replace(/`/g, "'").slice(0, 160);
    return { path, status: t.status, link: url ? `[${name}](${url})` : name, error: firstLine };
  }),
);

const count = (s) => tests.filter((t) => t.status === s).length;
const failed = tests.filter((t) => t.status === "failed");
const ok = failed.length === 0 && report.success !== false;
const out = [];
out.push(`<!-- test-report -->`);
out.push(`### Tests: ${ok ? "✅ all green" : `❌ ${failed.length} failed`} · ${count("passed")} passed${count("skipped") + count("pending") ? ` · ${count("skipped") + count("pending")} skipped` : ""}`);
if (process.env.UI_URL) out.push(`**[Open the full report (Vitest UI)](${process.env.UI_URL})**: every test with its code and errors.\n`);
out.push(`<sub>Commit ${sha ? sha.slice(0, 7) : "local"}. Each test name links to its code at that commit. Tests marked expected-fail (\`it.fails\`) count as passed.</sub>\n`);
if (failed.length) {
  out.push("| | Test | Error |", "|---|---|---|");
  for (const t of failed) out.push(`| ❌ | ${t.link} | \`${t.error}\` |`);
  out.push("");
}
out.push(`<details><summary>All ${tests.length} tests</summary>\n`);
let current = "";
for (const t of tests) {
  if (t.path !== current) out.push(`\n**${(current = t.path)}**\n`);
  out.push(`- ${icon[t.status] ?? "•"} ${t.link}`);
}
out.push("\n</details>");

// History: one row per commit, newest first, each with its own report, so a red run stays visible
// after the next green one. Rows from the previous comment are kept.
const previous = process.env.PREVIOUS && existsSync(process.env.PREVIOUS) ? readFileSync(process.env.PREVIOUS, "utf8") : "";
const oldRows = (previous.split("<!-- history -->")[1] ?? "").split("<!-- /history -->")[0].split("\n").filter((l) => /^\| (\[`|`)/.test(l));
const commitCell = sha ? (repo ? `[\`${sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${sha})` : `\`${sha.slice(0, 7)}\``) : "`local`";
const reportLink = process.env.UI_VERSION_URL ? `[report](${process.env.UI_VERSION_URL})` : "—";
const row = `| ${commitCell} | ${ok ? "✅" : "❌"} ${count("passed")} passed${failed.length ? `, ${failed.length} failed` : ""} | ${reportLink} |`;
const rows = [row, ...oldRows.filter((r) => !sha || !r.includes(sha.slice(0, 7)))].slice(0, 30);
out.push("\n**History** (newest first; each link is that commit's Vitest UI report)\n");
out.push("<!-- history -->", "| Commit | Tests | Report |", "|---|---|---|", ...rows, "<!-- /history -->");
console.log(out.join("\n"));
