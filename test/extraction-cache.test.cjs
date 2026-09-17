const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorage } = require("../electron/storage.cjs");
const { runReview } = require("../electron/review-runner.cjs");

const MODEL = { configId: "cfg-extract", name: "extract", modelId: "qwen-extract", role: "extraction", status: "active",
  testStatus: "passed", contextLength: 16000, maxTokens: 4096, timeoutMs: 180000 };

function fixture(overrides = {}) {
  const text = "2.1 本合同总价款为人民币壹佰万元整。\n2.3 预付款 30%。";
  const blocks = [{ block_id: "b1", logical_page: 1, clause_no: "2.1", text: "2.1 本合同总价款为人民币壹佰万元整。" },
    { block_id: "b2", logical_page: 1, clause_no: "2.3", text: "2.3 预付款 30%。" }];
  return {
    review: {
      project: { project_id: "p1", file_version_id: "contract_v1", contract_type: "procurement" },
      document: { documentType: "docx", fileVersionId: "contract_v1", text, sha256: "a".repeat(64), pages: [{ page: 1, text }], blocks },
      config: { snapshot: { id: "", status: "draft" }, rules: [], policies: [] },
      task: { task_id: "t1", status: "queued", progress: 0 },
      risks: [],
      ...overrides.review
    },
    state: { knowledge: { legalSnapshots: [], rules: [], policies: [] },
      capabilities: { models: [MODEL], skills: [] }, settings: {} }
  };
}

function cachingServices(storage, counter) {
  return {
    invokeModel: async () => {
      counter.calls += 1;
      return { ok: true, data: { facts: [{ fact_type: "money", value: "1000000", raw_text: "人民币壹佰万元整", block_id: "b1" }] } };
    },
    extractionCache: {
      load: (hash) => storage.loadExtractionCache(hash),
      save: (hash, entry) => storage.saveExtractionCache(hash, entry)
    }
  };
}

function tempStorage() {
  return createStorage(fs.mkdtempSync(path.join(os.tmpdir(), "extract-cache-")));
}

test("同一合同再次审查命中缓存，不再调用抽取模型", async () => {
  const storage = tempStorage();
  const counter = { calls: 0 };
  const first = await runReview({ ...fixture(), services: cachingServices(storage, counter) });
  assert.equal(counter.calls, 1, "首次必须真实调用模型");
  assert.equal(first.review.extraction_source, "model");
  assert.equal(first.review.extraction_cache.hit, false);

  const files = storage.listExtractionCacheHashes();
  assert.deepEqual(files, ["a".repeat(64)], "缓存必须按合同哈希落盘");

  const second = await runReview({ ...fixture(), services: cachingServices(storage, counter) });
  assert.equal(counter.calls, 1, "二次审查不得再调用模型");
  assert.equal(second.review.extraction_source, "cache");
  assert.equal(second.review.extraction_cache.hit, true);
  assert.equal(second.review.execution_summary.extraction.call_count, 0);
  assert.equal(second.review.execution_summary.extraction.source, "cache");
  // 缓存命中仍必须给出与首次一致的事实
  assert.deepEqual(second.review.contract_facts.map((f) => f.raw_text), first.review.contract_facts.map((f) => f.raw_text));
});

test("块结构变化后缓存作废，绝不复用指向旧块的事实", async () => {
  const storage = tempStorage();
  const counter = { calls: 0 };
  await runReview({ ...fixture(), services: cachingServices(storage, counter) });
  assert.equal(counter.calls, 1);

  // 模拟解析器升级：块 id 变了但缓存键没变（键里只有文件哈希，不含块结构）。
  // 这时必须靠逐条重新锚定发现引用失效，否则会复用指向错误位置的事实。
  const next = fixture();
  next.review.document.blocks = [{ block_id: "block_v2_1", logical_page: 1, clause_no: "2.1", text: "2.1 本合同总价款为人民币壹佰万元整。" },
    { block_id: "block_v2_2", logical_page: 1, clause_no: "2.3", text: "2.3 预付款 30%。" }];
  const result = await runReview({ ...next, services: cachingServices(storage, counter) });
  assert.equal(counter.calls, 2, "块结构变化后必须重新抽取");
  assert.equal(result.review.extraction_cache.hit, false);
  assert.equal(result.review.extraction_cache.reason, "stale_refs");
  assert.ok(result.review.extraction_cache.dropped >= 1, "必须报告被丢弃的失效引用数");
  // 重新抽取后的事实只能引用新块结构
  assert.equal(result.review.contract_facts.every((fact) => fact.source_refs.every((ref) => ref.block_id.startsWith("block_v2_"))), true);
});

test("块 id 不变但文本被替换时，事实不得被复用", async () => {
  const storage = tempStorage();
  const counter = { calls: 0 };
  await runReview({ ...fixture(), services: cachingServices(storage, counter) });
  // 同样的块 id、内容变了：哈希校验必须拦住这种最隐蔽的错位。
  const next = fixture();
  next.review.document.blocks = [{ block_id: "b1", logical_page: 1, clause_no: "2.1", text: "2.1 合同总价款改为人民币贰佰万元整。" },
    { block_id: "b2", logical_page: 1, clause_no: "2.3", text: "2.3 预付款 60%。" }];
  const result = await runReview({ ...next, services: cachingServices(storage, counter) });
  assert.equal(counter.calls, 2, "文本变化必须重新抽取");
  assert.equal(result.review.extraction_cache.reason, "stale_refs");
});

test("缓存内容与当前解析不一致时判为失效并重新抽取", async () => {
  const storage = tempStorage();
  const counter = { calls: 0 };
  await runReview({ ...fixture(), services: cachingServices(storage, counter) });
  // 篡改缓存：把块 id 改成当前文档里不存在的值
  const cached = storage.loadExtractionCache("a".repeat(64));
  cached.facts[0].source_refs[0].block_id = "ghost_block";
  storage.saveExtractionCache("a".repeat(64), cached);

  const result = await runReview({ ...fixture(), services: cachingServices(storage, counter) });
  assert.equal(counter.calls, 2, "引用失效必须重新抽取");
  assert.equal(result.review.extraction_cache.hit, false);
  assert.equal(result.review.extraction_cache.reason, "stale_refs");
});

test("缓存键包含模型与口径，换模型或换档位都不复用", async () => {
  const storage = tempStorage();
  const counter = { calls: 0 };
  await runReview({ ...fixture(), services: cachingServices(storage, counter) });
  assert.equal(counter.calls, 1);
  const changed = fixture();
  changed.state.capabilities.models = [{ ...MODEL, modelId: "another-model" }];
  const result = await runReview({ ...changed, services: cachingServices(storage, counter) });
  assert.equal(counter.calls, 2, "换模型必须重新抽取");
  assert.equal(result.review.extraction_cache.reason, "key_changed");
});

test("删除任务只回收无人引用的抽取缓存", () => {
  const storage = tempStorage();
  storage.saveExtractionCache("a".repeat(64), { key: "k", facts: [] });
  storage.saveExtractionCache("b".repeat(64), { key: "k", facts: [] });
  assert.deepEqual(storage.listExtractionCacheHashes().sort(), ["a".repeat(64), "b".repeat(64)]);
  // 只回收 hash-a：hash-b 仍被别的任务引用
  assert.equal(storage.pruneExtractionCache(["a".repeat(64)]), 1);
  assert.deepEqual(storage.listExtractionCacheHashes(), ["b".repeat(64)]);
  // 整体清理
  const cleared = storage.clearExtractionCache();
  assert.equal(cleared.removed, 1);
  assert.deepEqual(storage.listExtractionCacheHashes(), []);
});

test("取消或降级的抽取不写入缓存，避免后续命中残缺事实", async () => {
  const storage = tempStorage();
  const controller = new AbortController();
  await runReview({
    ...fixture(),
    services: { signal: controller.signal,
      invokeModel: async () => {
        controller.abort();
        return { ok: false, errorCode: "MODEL_REQUEST_CANCELLED", message: "已取消" };
      },
      extractionCache: { load: (hash) => storage.loadExtractionCache(hash), save: (hash, entry) => storage.saveExtractionCache(hash, entry) } }
  });
  assert.deepEqual(storage.listExtractionCacheHashes(), [], "取消的抽取不得留下缓存");
});

