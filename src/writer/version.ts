/** A note's version: the first 12 hex chars of the SHA-256 of its content. read_note returns it; write_note checks it. */
export async function noteVersion(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content.replace(/^\uFEFF/, "")) /* Blob.text() drops a BOM, fs.readFile keeps it: hash the same text on both sides */);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}
