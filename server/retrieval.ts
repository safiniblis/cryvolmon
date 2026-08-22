/**
 * retrieval.ts — Retrieval-scoped memory for the council pipeline.
 *
 * Builds a lightweight in-memory embedding index over:
 *   - codebase source files (*.ts, *.tsx, *.md under server/, client/, shared/)
 *   - data/council-memory.json entries
 *   - data/council-conversation.json entries
 *   - past pipeline summaries (data/pipeline-artifacts/)
 *
 * Uses NVIDIA NIM's free embedding endpoint (nvidia/nv-embedqa-e5-v5) for
 * vectorization and brute-force cosine similarity for retrieval. No external
 * vector DB required — the corpus is small enough (~hundreds of chunks) that
 * a linear scan is instant.
 *
 * Public API:
 *   retrieveRelevant(query, k?) — returns top-k text chunks by similarity
 *   refreshIndex()             — rebuild the index from disk (call periodically
 *                                or after mutations)
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, extname } from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EMBED_MODEL = "nvidia/nv-embedqa-e5-v5";
const EMBED_DIM = 1024;
const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";
const MAX_CHUNK_CHARS = 250; // code has high token density (~1.5 tok/char), stay well under 512-token NIM limit
const MIN_CHUNK_CHARS = 30;

// Directories to index for code
const CODE_DIRS = ["server", "client/src", "shared"];
const CODE_EXTS = new Set([".ts", ".tsx", ".md"]);

// Pipeline artifact dir
const ARTIFACT_DIR = () => join(process.cwd(), "data", "pipeline-artifacts");

// Memory / conversation files
const MEMORY_FILE = () => join(process.cwd(), "data", "council-memory.json");
const CONVERSATION_FILE = () => join(process.cwd(), "data", "council-conversation.json");
const LEDGER_SUMMARY = () => join(process.cwd(), "data", "llm-ledger-summary.json");
const CHANGELOG = () => join(process.cwd(), "data", "changelog.md");

// ---------------------------------------------------------------------------
// Chunk type
// ---------------------------------------------------------------------------

export interface Chunk {
  id: string;
  text: string;
  source: string;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// In-memory index
// ---------------------------------------------------------------------------

let index: { chunks: Chunk[]; vectors: Float32Array[] } = { chunks: [], vectors: [] };

// ---------------------------------------------------------------------------
// Chunking helpers
// ---------------------------------------------------------------------------

function chunkCodeFile(relPath: string, content: string): Chunk[] {
  // Split on blank lines or major section boundaries. Keep each chunk under
  // MAX_CHUNK_CHARS but avoid splitting mid-function where possible.
  const lines = content.split("\n");
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bufLen = 0;

  for (const line of lines) {
    const lineLen = line.length + 1;
    // Flush if adding this line would exceed the limit AND we have something.
    if (bufLen + lineLen > MAX_CHUNK_CHARS && buf.length > 0) {
      const text = buf.join("\n").trim();
      if (text.length >= MIN_CHUNK_CHARS) {
        chunks.push({ id: `code:${relPath}:${chunks.length}`, text, source: relPath });
      }
      buf = [];
      bufLen = 0;
    }
    buf.push(line);
    bufLen += lineLen;
  }
  // Flush remainder.
  const text = buf.join("\n").trim();
  if (text.length >= MIN_CHUNK_CHARS) {
    chunks.push({ id: `code:${relPath}:${chunks.length}`, text, source: relPath });
  }
  return chunks;
}

function chunkMemoryFile(): Chunk[] {
  try {
    const raw = readFileSync(MEMORY_FILE(), "utf8");
    const data = JSON.parse(raw);
    const entries: Array<{ at: string; text: string }> = data.entries ?? [];
    // Group entries into chunks of ~5 to keep chunks meaningful.
    const chunks: Chunk[] = [];
    for (let i = 0; i < entries.length; i += 5) {
      const batch = entries.slice(i, i + 5);
      const text = batch.map((e) => `[${e.at}] ${e.text}`).join("\n");
      chunks.push({ id: `memory:${i}`, text, source: "council-memory", meta: { startIdx: i } });
    }
    return chunks;
  } catch {
    return [];
  }
}

function chunkConversationFile(): Chunk[] {
  try {
    const raw = readFileSync(CONVERSATION_FILE(), "utf8");
    const data = JSON.parse(raw);
    const entries: Array<{ role: string; content: string; at: string; meta?: Record<string, unknown> }> = data.entries ?? [];
    // Group into conversational windows of 4 turns.
    const chunks: Chunk[] = [];
    for (let i = 0; i < entries.length; i += 4) {
      const batch = entries.slice(i, i + 4);
      const text = batch.map((e) => `[${e.role} @ ${e.at}] ${e.content}`).join("\n");
      chunks.push({ id: `conv:${i}`, text, source: "council-conversation", meta: { startIdx: i } });
    }
    return chunks;
  } catch {
    return [];
  }
}

function chunkPipelineArtifacts(): Chunk[] {
  const chunks: Chunk[] = [];
  try {
    const dir = ARTIFACT_DIR();
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), "utf8");
        // Each artifact is a chunk — they're typically short (< 2000 chars).
        const text = content.trim();
        if (text.length >= MIN_CHUNK_CHARS) {
          // Extract pipeline ID from filename.
          const pipelineId = file.split("-").slice(0, 3).join("-");
          chunks.push({
            id: `artifact:${file}`,
            text: `[${file}] ${text}`,
            source: `pipeline-artifacts/${file}`,
            meta: { pipelineId, filename: file },
          });
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // dir doesn't exist yet
  }
  return chunks;
}

function chunkLedgerSummary(): Chunk[] {
  try {
    const raw = readFileSync(LEDGER_SUMMARY(), "utf8");
    const text = `[llm-ledger-summary] ${raw.trim()}`;
    if (text.length >= MIN_CHUNK_CHARS) {
      return [{ id: "ledger:summary", text, source: "llm-ledger-summary" }];
    }
  } catch {
    // doesn't exist
  }
  return [];
}

function chunkChangelog(): Chunk[] {
  try {
    const content = readFileSync(CHANGELOG(), "utf8");
    const lines = content.split("\n");
    const chunks: Chunk[] = [];
    let buf: string[] = [];
    let bufLen = 0;
    for (const line of lines) {
      const lineLen = line.length + 1;
      if (bufLen + lineLen > MAX_CHUNK_CHARS && buf.length > 0) {
        const text = buf.join("\n").trim();
        if (text.length >= MIN_CHUNK_CHARS) {
          chunks.push({ id: `changelog:${chunks.length}`, text, source: "changelog" });
        }
        buf = [];
        bufLen = 0;
      }
      buf.push(line);
      bufLen += lineLen;
    }
    const text = buf.join("\n").trim();
    if (text.length >= MIN_CHUNK_CHARS) {
      chunks.push({ id: `changelog:${chunks.length}`, text, source: "changelog" });
    }
    return chunks;
  } catch {
    return [];
  }
}

function collectCodeChunks(): Chunk[] {
  const cwd = process.cwd();
  const chunks: Chunk[] = [];
  for (const dir of CODE_DIRS) {
    const absDir = join(cwd, dir);
    try {
      walkDir(absDir, absDir, chunks);
    } catch {
      // dir doesn't exist
    }
  }
  return chunks;
}

function walkDir(dir: string, baseDir: string, chunks: Chunk[]) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cwd = process.cwd();
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const st = statSync(fullPath);
      if (st.isDirectory()) {
        if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
        walkDir(fullPath, baseDir, chunks);
      } else if (CODE_EXTS.has(extname(entry))) {
        const relPath = relative(cwd, fullPath);
        try {
          const content = readFileSync(fullPath, "utf8");
          chunks.push(...chunkCodeFile(relPath, content));
        } catch {}
      }
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Embedding via NVIDIA NIM
// ---------------------------------------------------------------------------

async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    console.warn("[Retrieval] No NVIDIA_API_KEY — falling back to random vectors.");
    return texts.map(() => {
      const v = new Float32Array(EMBED_DIM);
      for (let i = 0; i < EMBED_DIM; i++) v[i] = Math.random() * 2 - 1;
      return v;
    });
  }

  const vectors: Float32Array[] = [];
  // Embed in batches of 20 to stay under rate limits.
  const batchSize = 20;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map((t) => (t.length > 340 ? t.slice(0, 340) : t));
    try {
      const res = await fetch(`${NVIDIA_BASE}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: EMBED_MODEL,
          input: batch,
          input_type: "passage",
          encoding_format: "float",
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.warn(`[Retrieval] Embed batch failed (${res.status}): ${errBody.slice(0, 200)}`);
        // Fill with random vectors as fallback.
        for (let j = 0; j < batch.length; j++) {
          const v = new Float32Array(EMBED_DIM);
          for (let k = 0; k < EMBED_DIM; k++) v[k] = Math.random() * 2 - 1;
          vectors.push(v);
        }
        continue;
      }
      const data = await res.json();
      const embeddings: Array<{ embedding: number[] }> = data.data ?? [];
      for (const emb of embeddings) {
        vectors.push(new Float32Array(emb.embedding));
      }
    } catch (e: any) {
      console.warn(`[Retrieval] Embed batch error: ${e?.message}`);
      for (let j = 0; j < batch.length; j++) {
        const v = new Float32Array(EMBED_DIM);
        for (let k = 0; k < EMBED_DIM; k++) v[k] = Math.random() * 2 - 1;
        vectors.push(v);
      }
    }
  }
  return vectors;
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Index build
// ---------------------------------------------------------------------------

export async function refreshIndex(): Promise<{ totalChunks: number; sources: Record<string, number> }> {
  console.log("[Retrieval] Building index...");
  const t0 = Date.now();

  const allChunks: Chunk[] = [];
  const sources: Record<string, number> = {};

  const codeChunks = collectCodeChunks();
  sources.code = codeChunks.length;
  allChunks.push(...codeChunks);

  const memChunks = chunkMemoryFile();
  sources.memory = memChunks.length;
  allChunks.push(...memChunks);

  const convChunks = chunkConversationFile();
  sources.conversation = convChunks.length;
  allChunks.push(...convChunks);

  const artifactChunks = chunkPipelineArtifacts();
  sources.artifacts = artifactChunks.length;
  allChunks.push(...artifactChunks);

  const ledgerChunks = chunkLedgerSummary();
  sources.ledger = ledgerChunks.length;
  allChunks.push(...ledgerChunks);

  const changelogChunks = chunkChangelog();
  sources.changelog = changelogChunks.length;
  allChunks.push(...changelogChunks);

  if (allChunks.length === 0) {
    index = { chunks: [], vectors: [] };
    console.log("[Retrieval] No chunks found — empty index.");
    return { totalChunks: 0, sources };
  }

  // Embed all chunks.
  const texts = allChunks.map((c) => c.text);
  const vectors = await embedTexts(texts);

  index = { chunks: allChunks, vectors };
  const ms = Date.now() - t0;
  console.log(`[Retrieval] Index built: ${allChunks.length} chunks in ${ms}ms`, sources);
  return { totalChunks: allChunks.length, sources };
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export async function retrieveRelevant(query: string, k = 8): Promise<string[]> {
  if (index.chunks.length === 0) {
    await refreshIndex();
  }
  if (index.chunks.length === 0) return [];

  // Embed the query.
  const [queryVec] = await embedTexts([query]);

  // Score all chunks.
  const scored: Array<{ chunk: Chunk; score: number }> = [];
  for (let i = 0; i < index.chunks.length; i++) {
    scored.push({ chunk: index.chunks[i], score: cosine(queryVec, index.vectors[i]) });
  }

  // Sort by descending similarity, take top-k.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => `[${s.chunk.source}] ${s.chunk.text}`);
}
