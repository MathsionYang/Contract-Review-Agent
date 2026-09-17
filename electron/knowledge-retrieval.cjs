const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { buildKnowledgeItem, searchKnowledgeSources, sourceMatchesQuery } = require("./knowledge.cjs");
const { invokeModel, validateVectors } = require("./model-gateway.cjs");
const { modelIdentity } = require("./model-runtime.cjs");

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function createVectorCache(directory = null, limit = 2000) {
  const memory = new Map();
  const file = (key) => {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid vector cache key");
    return path.join(directory, `${key}.json`);
  };
  return {
    get(key) {
      if (memory.has(key)) return memory.get(key);
      if (!directory) return null;
      try { return JSON.parse(fs.readFileSync(file(key), "utf8")); } catch (_) { return null; }
    },
    set(key, vector) {
      memory.set(key, vector);
      if (memory.size > limit) memory.delete(memory.keys().next().value);
      if (!directory) return;
      // Only numeric vectors are persisted; the key is a one-way content/config hash.
      fs.mkdirSync(directory, { recursive: true });
      const destination = file(key);
      const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
      try { fs.writeFileSync(temporary, JSON.stringify(vector)); fs.renameSync(temporary, destination); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
  };
}

function knowledgeChunks(sources, maxChars = 1200) {
  const chunks = [];
  for (const raw of sources) {
    const source = buildKnowledgeItem(raw);
    if (!source.selected || source.parse_status === "failed") continue;
    for (const [clauseIndex, clause] of source.clauses.entries()) {
      const text = String(clause.text || "").trim();
      const title = String(clause.title || "").slice(0, Math.min(160, Math.floor(maxChars / 4)));
      const contentLimit = Math.max(1, maxChars - title.length - 1);
      for (let start = 0; start < text.length;) {
        const excerpt = text.slice(start, start + contentLimit);
        chunks.push({ source_id: source.source_id, source_type: source.source_type, file_name: source.file_name,
          file_version_id: source.file_version_id, version: source.version, snapshot_id: source.source_type === "legal_snapshot" ? source.id : undefined,
          clause_no: clause.clause_no, clause_title: clause.title, excerpt,
          chunk_id: digest(JSON.stringify([source.source_id, source.file_version_id, clauseIndex, start, excerpt])),
          char_range: [start, start + excerpt.length], embedding_text: `${title}\n${excerpt}` });
        if (start + contentLimit >= text.length) break;
        start += Math.max(1, contentLimit - Math.min(100, Math.floor(contentLimit / 5)));
      }
    }
  }
  return chunks;
}

function cosine(a, b) {
  let dot = 0;
  const normA = Math.hypot(...a);
  const normB = Math.hypot(...b);
  for (let i = 0; i < a.length; i += 1) dot += (a[i] / normA) * (b[i] / normB);
  return dot;
}

function hybridHits(chunks, vectors, query, queryVector, limit = 8) {
  const lexical = chunks.map((chunk, index) => ({ index, score: sourceMatchesQuery({ title: chunk.clause_title, text: chunk.excerpt }, query) }))
    .filter((hit) => hit.score >= 0.05).sort((a, b) => b.score - a.score);
  const semantic = vectors.map((vector, index) => ({ index, score: cosine(vector, queryVector) }))
    .filter((hit) => hit.score >= 0.45).sort((a, b) => b.score - a.score).slice(0, 30);
  const combined = new Map();
  for (const [kind, hits] of [["keyword", lexical.slice(0, 30)], ["vector", semantic]]) {
    hits.forEach((hit, rank) => {
      const value = combined.get(hit.index) || { index: hit.index, score: 0 };
      value.score += 1 / (60 + rank + 1);
      value[`${kind}_score`] = hit.score;
      combined.set(hit.index, value);
    });
  }
  const seen = new Set();
  return [...combined.values()].sort((a, b) => b.score - a.score).filter((hit) => {
    const chunk = chunks[hit.index];
    const key = `${chunk.source_id}:${chunk.file_version_id}:${chunk.clause_no}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit).map(({ index, ...scores }) => {
    const { embedding_text: _text, ...chunk } = chunks[index];
    return { ...chunk, ...scores, retrieval_method: "hybrid", verification_status: "candidate" };
  });
}

function createKnowledgeRetriever(options = {}) {
  const sources = options.sources || [];
  const model = options.model;
  const maxInputChars = Math.max(16, Math.min(1200, Math.floor((Number(model?.contextLength) || 8192) * 0.7)));
  const chunks = knowledgeChunks(sources, maxInputChars);
  const cache = options.cache || createVectorCache();
  const fingerprint = digest(JSON.stringify(["embedding-v2", model?.configId, model?.endpoint, model?.modelId, model?.version, model?.credentialRef, model?.lastTestedAt]));
  const summary = { ...modelIdentity(model), status: model ? (chunks.length ? "pending" : "skipped") : "not_configured",
    reason: chunks.length ? null : "no_knowledge", fallback: model ? null : "keyword", chunk_count: chunks.length,
    cache_hit_count: 0, call_count: 0, query_count: 0, truncated_query_count: 0, dimension: null, latency_ms: 0 };
  let vectors = null;
  let disabled = !model || !chunks.length;
  const queries = new Map();
  const notify = () => options.onProgress?.({ ...summary });
  const fallback = (query, limit) => searchKnowledgeSources(sources, query, { limit, minScore: 0.05 })
    .map((hit) => ({ ...hit, retrieval_method: "keyword", verification_status: "candidate" }));

  async function embed(input) {
    if (options.signal?.aborted) throw Object.assign(new Error("检索已取消"), { code: "MODEL_REQUEST_CANCELLED" });
    summary.call_count += 1;
    notify();
    const start = Date.now();
    const response = await (options.invokeModel || invokeModel)({ model, operation: "embedding", input, signal: options.signal });
    summary.latency_ms += Date.now() - start;
    if (!response?.ok) throw Object.assign(new Error(response?.message || "向量模型调用失败"), { code: response?.errorCode });
    if (!validateVectors(response.data?.vectors, input.length)) throw new Error("向量响应数量或维度无效");
    const dimension = response.data.vectors[0].length;
    if (summary.dimension && summary.dimension !== dimension) throw new Error("索引和查询向量维度不一致，请检查模型版本");
    summary.dimension = dimension;
    return response.data.vectors;
  }

  async function ensureIndex() {
    if (vectors) return;
    vectors = new Array(chunks.length);
    const missing = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const key = digest(`${fingerprint}:${chunks[i].embedding_text}`);
      const cached = cache.get(key);
      if (validateVectors([cached], 1) && (!summary.dimension || summary.dimension === cached.length)) {
        vectors[i] = cached;
        summary.dimension = cached.length;
        summary.cache_hit_count += 1;
      } else missing.push({ index: i, key });
    }
    for (let start = 0; start < missing.length; start += 16) {
      const batch = missing.slice(start, start + 16);
      const result = await embed(batch.map((item) => chunks[item.index].embedding_text));
      batch.forEach((item, i) => {
        vectors[item.index] = result[i];
        try { cache.set(item.key, result[i]); } catch (_) { summary.cache_write_failed = true; }
      });
    }
  }

  // Serialize calls so streaming risks share one index and a single failure circuit breaker.
  let queue = Promise.resolve();
  function searchMany(input, { limit = 8 } = {}) {
    const work = async () => {
      const values = input.map((query) => String(query || "").trim());
      if (!disabled) {
        try {
          summary.status = "running";
          await ensureIndex();
          const missing = [...new Set(values.filter((query) => query && !queries.has(query)))];
          for (let start = 0; start < missing.length; start += 16) {
            const batch = missing.slice(start, start + 16);
            const texts = batch.map((query) => {
              if (query.length > maxInputChars) summary.truncated_query_count += 1;
              return query.slice(0, maxInputChars);
            });
            const result = await embed(texts);
            batch.forEach((query, index) => queries.set(query, result[index]));
            summary.query_count += batch.length;
          }
          summary.status = "completed";
        } catch (error) {
          // 用户取消时向上抛出，避免把主动中断记成向量降级。
          if (options.signal?.aborted) throw error;
          disabled = true;
          summary.status = "degraded";
          summary.fallback = "keyword";
          summary.error_code = error.code || "EMBEDDING_FAILED";
          summary.message = error.message;
        }
        notify();
      }
      return values.map((query) => !disabled && queries.has(query) ? hybridHits(chunks, vectors, query, queries.get(query), limit) : fallback(query, limit));
    };
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }
  return { summary, searchMany, async search(query, options) { return (await searchMany([query], options))[0]; } };
}

module.exports = { createVectorCache, createKnowledgeRetriever, knowledgeChunks, hybridHits };
