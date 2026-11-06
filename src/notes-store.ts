// Reads go straight to Artifacts through the binding (ADR 007): no clone, no token.
import { env } from "cloudflare:workers";

const BRANCH = "main";
const repoName = () => (env as unknown as { NOTES_REPO: string }).NOTES_REPO;

export async function headCommit(artifacts: Artifacts): Promise<string | null> {
  using repo = await artifacts.get(repoName());
  const [head] = await repo.log({ ref: BRANCH, limit: 1 });
  return head?.hash ?? null;
}

export async function readNote(artifacts: Artifacts, path: string, ref = BRANCH): Promise<string | null> {
  using repo = await artifacts.get(repoName());
  const blob = await repo.readFile({ ref, path });
  return blob ? blob.text() : null;
}

/** Every .md path at the head of main, optionally under a prefix. */
export async function listNotes(artifacts: Artifacts, prefix = ""): Promise<string[]> {
  using repo = await artifacts.get(repoName());
  const [head] = await repo.log({ ref: BRANCH, limit: 1 });
  if (!head) return [];
  const out: string[] = [];
  const walk = async (tree: string, base: string): Promise<void> => {
    const entries = (await repo.readTree(tree)) ?? [];
    await Promise.all(
      entries.map(async (e) => {
        const path = base + e.name;
        if (e.type === "tree") {
          if (prefix.startsWith(path + "/") || (path + "/").startsWith(prefix)) await walk(e.hash, path + "/");
        } else if (e.type === "blob" && path.endsWith(".md") && path.startsWith(prefix)) out.push(path);
      }),
    );
  };
  await walk(head.treeHash, "");
  return out.sort();
}
