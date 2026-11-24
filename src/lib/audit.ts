// Audit entries for an MCP request body: the JSON-RPC method and, for a tool call, the tool and the
// note paths it touches. Never the note content, the search query or the token.
export type AuditEntry = { rpc: string; tool?: string; paths?: string[] };

const PATH_ARGS = ["path", "from", "to"] as const;

function entry(msg: unknown): AuditEntry | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as { method?: unknown; params?: { name?: unknown; arguments?: Record<string, unknown> } };
  if (typeof m.method !== "string") return null;
  if (m.method !== "tools/call") return { rpc: m.method };
  const args = m.params?.arguments ?? {};
  const paths = PATH_ARGS.map((k) => args[k]).filter((v): v is string => typeof v === "string");
  return { rpc: m.method, tool: typeof m.params?.name === "string" ? m.params.name : undefined, ...(paths.length ? { paths } : {}) };
}

export function auditEntries(body: unknown): AuditEntry[] {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.map(entry).filter((e): e is AuditEntry => e !== null);
}

/**
 * The MCP client behind a tool call, for the commit's audit trail: the SDK's verified client id when
 * it has one, else the one the Worker copied into the request props from the OAuth context.
 */
export function clientOf(extra: unknown, props: Record<string, unknown> | undefined): string | undefined {
  const sdk = (extra as { authInfo?: { clientId?: unknown } } | undefined)?.authInfo?.clientId;
  if (typeof sdk === "string" && sdk) return sdk;
  const fromProps = props?.clientId;
  return typeof fromProps === "string" && fromProps ? fromProps : undefined;
}

/**
 * Trace span for one tool call: logs `{span: "tool", tool, ms, ok, error?}` as one JSON line in Workers Logs.
 * Never the arguments or the result, only whether it worked. A thrown error is logged and rethrown,
 * and an MCP result with `isError` counts as not ok.
 */
export async function span<T>(tool: string, run: () => Promise<T>, log: (line: string) => void = console.log): Promise<T> {
  const start = Date.now();
  try {
    const out = await run();
    const ok = !(out && typeof out === "object" && (out as { isError?: unknown }).isError === true);
    log(JSON.stringify({ span: "tool", tool, ms: Date.now() - start, ok }));
    return out;
  } catch (e) {
    log(JSON.stringify({ span: "tool", tool, ms: Date.now() - start, ok: false, error: String(e).slice(0, 200) }));
    throw e;
  }
}
