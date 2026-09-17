const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { invokeModel, testModelConnection } = require("../electron/model-gateway.cjs");
const { extractWithModel, extractionBatches } = require("../electron/model-extraction.cjs");
const { extractContractFacts } = require("../electron/contract-facts.cjs");
const { createKnowledgeRetriever, createVectorCache } = require("../electron/knowledge-retrieval.cjs");
const { runReview } = require("../electron/review-runner.cjs");
const { executionModel } = require("../electron/model-runtime.cjs");
const { estimateTokens } = require("../electron/context-assembler.cjs");

const model = (role, patch = {}) => ({ configId: role, name: `test-${role}`, modelId: role, role, status: "active", testStatus: "passed",
  endpoint: "https://models.invalid/v1", credentialRef: "none", contextLength: 16000, maxTokens: 2048, ...patch });
const document = (text) => ({ text, documentType: "docx", pages: [{ page: 1, text }], blocks: [{ block_id: "b1", page: null, logical_page: 1, text }] });
const source = (patch = {}) => ({ file: "law.md", id: "law-v1", source_id: "law-v1", fileVersionId: "law-v1", kind: "legalSnapshots", selected: true,
  clauses: [{ clause_no: "第五百七十七条", title: "违约责任", text: "当事人不履行义务，应承担相应责任。" }], ...patch });

test("向量请求走 embeddings 协议，按 index 排序且不带聊天参数", async () => {
  let request;
  const response = await invokeModel({ model: model("embedding", { endpoint: "https://models.invalid/v1/chat/completions?api-version=test", credentialRef: "test" }),
    input: ["a", "b"], credentialResolver: () => "test-key", fetchImpl: async (url, options) => {
      request = { url, ...options, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }) };
    } });
  assert.equal(request.url, "https://models.invalid/v1/embeddings?api-version=test");
  assert.deepEqual(request.body, { model: "embedding", input: ["a", "b"], encoding_format: "float" });
  assert.equal(request.headers.Authorization, "Bearer test-key");
  assert.deepEqual(response.data.vectors, [[1, 0], [0, 1]]);
});

test("无效向量索引、数量、维度、零向量和字符串数值全部拒绝", async () => {
  for (const data of [[], [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [1, 0] }],
    [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [1] }],
    [{ index: 0, embedding: [0, 0] }, { index: 1, embedding: [1, 0] }],
    [{ index: 0, embedding: ["1", 0] }, { index: 1, embedding: [1, 0] }],
    [{ embedding: [1, 0] }, { index: 1, embedding: [1, 0] }]]) {
    const result = await invokeModel({ model: model("embedding"), input: ["a", "b"], fetchImpl: async () => ({ ok: true, json: async () => ({ data }) }) });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "MODEL_OUTPUT_INVALID");
  }
});

test("真实连接测试按角色验证响应，不将本地字段或未接入角色当作成功", async () => {
  const calls = [];
  const invoke = async (request) => { calls.push(request); return { ok: true, data: request.model.role === "embedding" ? { vectors: [[1, 0]] } : { ok: true } }; };
  for (const role of ["analysis", "extraction", "embedding"]) assert.equal((await testModelConnection({ model: model(role), invokeModel: invoke })).ok, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].operation, "embedding");
  for (const role of ["rerank", "vision"]) assert.equal((await testModelConnection({ model: model(role), invokeModel: invoke })).errorCode, "MODEL_ROLE_UNSUPPORTED");
  assert.equal(calls.length, 3);
  assert.equal((await testModelConnection({ model: model("extraction"), invokeModel: async () => ({ ok: true, data: { risks: [] } }) })).ok, false);
  assert.equal((await testModelConnection({ model: model("analysis"), invokeModel: async () => ({ ok: false, message: "HTTP 401" }) })).message, "HTTP 401");
});

test("模型事实绑定真实块、字符范围和条款，丢弃伪造引文、数值与条款号", async () => {
  const doc = document("2.3 首付款百分之三十，在验收后五个工作日内支付。\n2.4 乙方负责交付源代码。");
  const valid = { fact_type: "ratio", value: 0.3, block_id: "b1", raw_text: "百分之三十", clause_no: "2.3" };
  const result = await extractWithModel(doc, { model: model("extraction"), invokeModel: async () => ({ ok: true, data: { facts: [
    valid, { ...valid, raw_text: "百分之九十" }, { ...valid, value: 0.8 }, { ...valid, clause_no: "8.9" },
    { ...valid, block_id: "fake" }, { ...valid, value: undefined },
    { fact_type: "duration", value: 5, block_id: "b1", raw_text: "五个工作日", clause_no: "2.3", calendar_type: "year" },
    { fact_type: "obligation", block_id: "b1", raw_text: "乙方负责交付源代码", clause_no: "2.4", subject: "乙方", action: "交付源代码" }
  ] } }) });
  assert.equal(result.summary.accepted_fact_count, 2);
  assert.equal(result.summary.duplicate_fact_count, 1);
  assert.equal(result.summary.rejected_fact_count, 5);
  const ratio = result.facts.find((item) => item.fact_type === "ratio");
  assert.equal(ratio.value, 0.3);
  assert.equal(ratio.source_refs[0].page, null);
  assert.equal(doc.text.slice(...ratio.source_refs[0].char_range), "百分之三十");
  assert.equal(result.facts.find((item) => item.origin === "model" && item.fact_type === "duration").calendar_type, "workday");
  assert.equal(result.summary.status, "partial");
});

test("抽取等待、校验、批次完成和结束实时报告，预览只包含原文和接纳事实", async () => {
  const doc = document("2.3 首付款百分之三十。" + "待交付条件。".repeat(50));
  const events = [];
  let finish;
  const pending = extractWithModel(doc, { model: model("extraction"), onProgress: (summary) => events.push(summary),
    invokeModel: () => new Promise((resolve) => { finish = resolve; }) });
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, "requesting");
  assert.equal(events[0].current_batch, 1);
  assert.equal(events[0].completed_batches, 0);
  assert.equal(events[0].current_source.quote, doc.text.slice(0, 180));
  assert.equal(events[0].current_source.page, null);
  assert.equal(events[0].current_source.logical_page, 1);
  finish({ ok: true, data: { facts: [
    { fact_type: "ratio", block_id: "b1", clause_no: "2.3", raw_text: "百分之三十", value: 0.3 },
    { fact_type: "ratio", block_id: "b1", clause_no: "2.3", raw_text: "伪造原文不能显示", value: 0.9 }
  ], reasoning: "不发送内部推理" } });
  const result = await pending;
  assert.deepEqual(events.map((event) => event.phase), ["requesting", "validating", "batch_completed", "finished"]);
  assert.equal(events[0].accepted_fact_count, 0);
  assert.equal(events[0].recent_facts.length, 0);
  assert.equal(events.at(-1).recent_facts[0].quote, "百分之三十");
  assert.equal(events.at(-1).rejected_fact_count, 1);
  assert.equal(events.at(-1).total_fact_count, result.facts.length);
  assert.ok(events.at(-1).completed_at);
  assert.equal(JSON.stringify(events).includes("伪造原文"), false);
  assert.equal(JSON.stringify(events).includes("内部推理"), false);
});

test("抽取未配置及失败也报告终态，不残留等待模型状态", async () => {
  for (const chosen of [null, model("extraction")]) {
    const events = [];
    const result = await extractWithModel(document("2.3 首付30%。"), { model: chosen, onProgress: (event) => events.push(event),
      invokeModel: async () => ({ ok: false, message: "连接失败", errorCode: "MODEL_REQUEST_FAILED" }) });
    assert.equal(events.at(-1).status, chosen ? "degraded" : "not_configured");
    assert.equal(events.at(-1).phase, chosen ? "finished" : "rules_only");
    assert.ok(events.at(-1).completed_at);
    assert.equal(events.at(-1).total_fact_count, result.facts.length);
  }
});

test("重复比例只保留一份，重复引文必须提供偏移以区分出现位置", async () => {
  const doc = document("2.3 首期 30%，第二期 30%，尾款 40%。");
  const result = await extractWithModel(doc, { model: model("extraction"), invokeModel: async () => ({ ok: true, data: { facts: [
    { fact_type: "ratio", value: 0.3, block_id: "b1", raw_text: "30%", clause_no: "2.3" },
    { fact_type: "ratio", value: 0.3, block_id: "b1", raw_text: "30%", clause_no: "2.3", quote_start: doc.text.indexOf("30%") },
    { fact_type: "ratio", value: 0.4, block_id: "b1", raw_text: "40%", clause_no: "2.3" }
  ] } }) });
  assert.equal(result.facts.filter((item) => item.fact_type === "ratio").length, 3);
  assert.equal(result.summary.duplicate_fact_count, 2);
  assert.equal(result.summary.rejected_fact_count, 1);
});

test("中文条款编号由原文推导，DOCX 不伪造物理页码", async () => {
  const doc = { documentType: "docx", text: "第二条 付款\n首付百分之三十。" };
  const result = await extractWithModel(doc, { model: model("extraction"), invokeModel: async () => ({ ok: true, data: { facts: [
    { fact_type: "ratio", value: 0.3, block_id: "page_1", raw_text: "百分之三十", clause_no: "第二条" }
  ] } }) });
  assert.equal(result.summary.accepted_fact_count, 1);
  assert.equal(result.facts.find((item) => item.origin === "model").source_refs[0].page, null);
});

test("抽取分批覆盖长文，失败保留规则及已完成批次，小窗口不发请求", async () => {
  const doc = document("2.1 价款100元。" + "交付验收条款。".repeat(2000));
  const chosen = model("extraction", { contextLength: 2400, maxTokens: 400 });
  const batches = extractionBatches(doc, chosen);
  assert.ok(batches.length > 1);
  assert.ok(batches.every((batch) => estimateTokens(batch.messages) <= 1488));
  const covered = new Set(batches.flatMap((batch) => batch.blocks.flatMap((block) => Array.from({ length: block.text.length }, (_, i) => i + block.offset))));
  assert.equal(covered.size, doc.text.length);
  let calls = 0;
  const result = await extractWithModel(doc, { model: chosen, invokeModel: async () => ++calls === 1 ? { ok: true, data: { facts: [] } } : { ok: false, errorCode: "MODEL_REQUEST_TIMEOUT", message: "timeout" } });
  assert.equal(result.summary.status, "degraded");
  assert.equal(result.summary.completed_batches, 1);
  assert.deepEqual(result.facts, extractContractFacts(doc).facts);
  const tooSmall = await extractWithModel(doc, { model: model("extraction", { contextLength: 300 }), invokeModel: () => assert.fail("must not call") });
  assert.equal(tooSmall.summary.call_count, 0);
  assert.equal(tooSmall.summary.status, "degraded");
});

test("抽取按批限制原文与请求数，未配置超时时补足以跑完抽取的默认值", async () => {
  // 复现真实事故配置：timeoutMs=60000、contextLength/maxTokens 均为 0（用户只填了角色和模型名）。
  const bare = { configId: "extract", name: "qwen", modelId: "qwen-plus", role: "extraction", status: "active", testStatus: "passed" };
  const doc = document("第一条 付款\n预付款 40%。\n第二条 交付\n交付时间为 2026 年 10 月 15 日。");
  const batches = extractionBatches(doc, bare);
  assert.ok(batches.length >= 1);
  const requested = [];
  const result = await extractWithModel(doc, { model: bare, invokeModel: async (request) => {
    requested.push(request);
    return { ok: true, data: { facts: [] } };
  } });
  // 未配置超时会补足到能容纳推理延迟的默认值，而不是沿用网关的 60 秒。
  assert.equal(requested[0].model.timeoutMs, 180000);
  assert.equal(result.summary.timeout_ms, 180000);
  assert.equal(requested[0].firstDeltaTimeoutMs, 180000, "首段响应必须获得独立宽限");
  assert.equal(requested[0].stream, true);
});

test("单批原文与块数受限，避免一次响应承载整份合同", async () => {
  const blocks = Array.from({ length: 60 }, (_, index) => ({ block_id: `b${index + 1}`, page: null, logical_page: 1, text: "第 X 条 付款与交付约定内容。".repeat(30) }));
  const doc = { text: blocks.map((block) => block.text).join(""), documentType: "docx", pages: [{ page: 1, text: "" }], blocks };
  const batches = extractionBatches(doc, model("extraction", { timeoutMs: 180000 }));
  assert.ok(batches.length > 1, "长合同必须拆成多个批次");
  for (const batch of batches) {
    assert.ok(batch.blocks.length <= 24, "单批请求块数必须受限");
    const chars = batch.blocks.reduce((total, block) => total + block.text.length, 0);
    assert.ok(chars <= 2400, `单批原文过长：${chars}`);
  }
  // 覆盖率不能因为拆批而丢失任何原文偏移（offset 是块内偏移，按 block_id 分别核对）。
  const covered = new Map();
  for (const batch of batches) {
    for (const block of batch.blocks) {
      const range = covered.get(block.block_id) || new Set();
      for (let index = 0; index < block.text.length; index += 1) range.add(block.offset + index);
      covered.set(block.block_id, range);
    }
  }
  assert.equal(covered.size, blocks.length);
  for (const block of blocks) assert.equal(covered.get(block.block_id).size, block.text.length);
});

test("空闲超时按首字节前后区分，推理长时间无输出也能等到结果", async () => {
  const call = (firstDeltaTimeoutMs, deltas) => invokeModel({
    model: { name: "m", modelId: "m", role: "analysis", endpoint: "https://models.invalid/v1", timeoutMs: 1000, retries: 0, maxTokens: 64 },
    stream: true,
    firstDeltaTimeoutMs,
    onDelta: () => {},
    retryTimeouts: false,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      setTimeout(() => resolve({ ok: true, body: new ReadableStream({ start(controller) {
        for (const delta of deltas) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      } }) }), 1200);
    })
  });
  // 未给首段宽限时，1000ms 内没有首字节即判定空闲超时。
  const timedOut = await call(0, [{ content: '{"risks":[]}' }]);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.errorCode, "MODEL_REQUEST_TIMEOUT");
  // 给了首段宽限后，同样的延迟可以正常拿到结果。
  const recovered = await call(5000, [{ content: '{"risks":[]}' }]);
  assert.equal(recovered.ok, true);
});

test("向量语义召回非同词知识，保留候选状态、快照和来源定位", async () => {
  const retriever = createKnowledgeRetriever({ sources: [source()], model: model("embedding"), invokeModel: async ({ input }) => ({ ok: true, data: { vectors: input.map(() => [1, 0]) } }) });
  const hits = await retriever.search("迟延交货如何追偿");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].snapshot_id, "law-v1");
  assert.equal(hits[0].retrieval_method, "hybrid");
  assert.equal(hits[0].verification_status, "candidate");
  assert.equal(retriever.summary.call_count, 2);
  assert.equal(retriever.summary.dimension, 2);
});

test("索引可跨实例复用，内容或模型变更失效，未选和已删除知识不会复活", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vector-index-"));
  let calls = 0;
  const options = { sources: [source()], model: model("embedding"), invokeModel: async ({ input }) => {
    calls += 1; return { ok: true, data: { vectors: input.map(() => [1, 0]) } };
  } };
  const run = async (patch = {}) => {
    const retriever = createKnowledgeRetriever({ ...options, cache: createVectorCache(directory), ...patch });
    await retriever.search("延迟交付");
    return retriever.summary;
  };
  assert.equal((await run()).cache_hit_count, 0);
  assert.equal((await run()).cache_hit_count, 1);
  assert.equal(calls, 3);
  assert.equal((await run({ model: model("embedding", { modelId: "new" }) })).cache_hit_count, 0);
  assert.equal((await run({ sources: [source({ clauses: [{ clause_no: "第五百七十七条", text: "新内容" }] })] })).cache_hit_count, 0);
  const before = calls;
  assert.equal((await run({ sources: [] })).status, "skipped");
  assert.equal((await run({ sources: [source({ selected: false })] })).chunk_count, 0);
  assert.equal(calls, before);
  const saved = fs.readdirSync(directory).map((file) => fs.readFileSync(path.join(directory, file), "utf8")).join("");
  assert.equal(saved.includes("当事人"), false);
  assert.equal(saved.includes("models.invalid"), false);
});

test("向量失败只尝试一次流程，后续查询降级关键词，不把低相似度充当依据", async () => {
  let calls = 0;
  const fallback = createKnowledgeRetriever({ sources: [source()], model: model("embedding"), invokeModel: async () => { calls += 1; throw new Error("network failed"); } });
  assert.equal((await fallback.search("违约责任"))[0].retrieval_method, "keyword");
  await fallback.search("当事人");
  assert.equal(calls, 1);
  assert.equal(fallback.summary.status, "degraded");
  let index = true;
  const unrelated = createKnowledgeRetriever({ sources: [source()], model: model("embedding"), invokeModel: async ({ input }) => {
    const vector = index ? [1, 0] : [0, 1]; index = false;
    return { ok: true, data: { vectors: input.map(() => vector) } };
  } });
  assert.deepEqual(await unrelated.search("完全无关查询"), []);
});

test("查询向量与缓存维度不一致时不得计算伪相似度", async () => {
  let calls = 0;
  const retriever = createKnowledgeRetriever({ sources: [source()], model: model("embedding"), invokeModel: async ({ input }) => {
    calls += 1; return { ok: true, data: { vectors: input.map(() => calls === 1 ? [1, 0] : [1, 0, 0]) } };
  } });
  await retriever.search("违约责任");
  assert.equal(retriever.summary.status, "degraded");
  assert.match(retriever.summary.message, /维度不一致/);
});

test("同名多模型按 configId 和角色精确选取，不串用其他角色", () => {
  const state = { capabilities: { models: [model("extraction", { name: "same" }), model("analysis", { name: "same" }), model("extraction", { name: "same", configId: "second" })] } };
  assert.equal(executionModel(state, { config: { execution: { models: { extraction: { configId: "second" } } } } }, "extraction").configId, "second");
  assert.equal(executionModel(state, { config: { execution: { models: { extraction: { configId: "analysis" } } } } }, "extraction"), null);
});

test("抽取与向量失败时继续分析和本地检查，但必须记录降级而非伪造完成", async () => {
  const calls = [];
  const result = await runReview({ review: { project: { project_id: "p", file_version_id: "v" }, document: document("2.3 预付款40%。"), config: { snapshot: { id: "law-v1", status: "published" } } },
    state: { capabilities: { models: ["extraction", "embedding", "analysis"].map((role) => model(role)) }, knowledge: { legalSnapshots: [source({ status: "published" })] } },
    services: { invokeModel: async (request) => {
      calls.push(request.model.role);
      return request.model.role === "analysis" ? { ok: true, data: { risks: [] } } : { ok: false, errorCode: "MODEL_REQUEST_TIMEOUT", message: "timeout" };
    } } });
  assert.deepEqual(calls, ["extraction", "embedding", "analysis"]);
  assert.equal(result.review.execution_summary.analysis.status, "completed");
  assert.equal(result.review.execution_summary.extraction.status, "degraded");
  assert.equal(result.review.execution_summary.embedding.status, "degraded");
  assert.equal(result.review.task.status, "partial");
  assert.ok(result.review.contract_facts.some((fact) => fact.fact_type === "ratio" && fact.value === 0.4));
  assert.ok(result.errors.some((item) => item.code === "EXTRACTION_DEGRADED" && item.stage === "extract"));
  assert.ok(result.errors.some((item) => item.code === "EMBEDDING_DEGRADED" && item.stage === "retrieve"));
});

test("事实过多时仍为检索依据保留上下文预算", async () => {
  let payload;
  const text = Array.from({ length: 200 }, (_, index) => `3.${index + 1} 第${index + 1}项费用金额${index + 100}元。`).join("\n");
  const result = await runReview({ review: { project: { project_id: "p", file_version_id: "v" }, document: document(text), config: { snapshot: { id: "law-v1", status: "published" } } },
    state: { capabilities: { models: [model("analysis"), model("embedding")] }, knowledge: { legalSnapshots: [source({ status: "published" })] } },
    services: { invokeModel: async (request) => {
      if (request.model.role === "embedding") return { ok: true, data: { vectors: request.input.map(() => [1, 0]) } };
      payload = JSON.parse(request.messages[1].content);
      return { ok: true, data: { risks: [] } };
    } } });
  assert.ok(result.review.model_context.omitted_fact_count > 0);
  assert.ok(payload.facts.length > 0);
  assert.ok(payload.evidence.length > 0);
});

test("小上下文向量模型的知识和查询输入均受限，索引仍覆盖完整知识", async () => {
  const lengths = [];
  const retriever = createKnowledgeRetriever({ sources: [source({ clauses: [{ clause_no: "1", title: "长标题".repeat(100), text: "条款正文".repeat(100) }] })],
    model: model("embedding", { contextLength: 128 }), invokeModel: async ({ input }) => {
      lengths.push(...input.map((text) => text.length));
      return { ok: true, data: { vectors: input.map(() => [1, 0]) } };
    } });
  await retriever.search("较长查询".repeat(100));
  assert.ok(lengths.every((length) => length <= Math.floor(128 * 0.7)));
  assert.ok(retriever.summary.chunk_count > 1);
  assert.equal(retriever.summary.truncated_query_count, 1);
  assert.equal(retriever.summary.status, "completed");
});

test("完整审查真实通过本地 HTTP 服务执行三个模型协议并保存阶段记录", async (t) => {
  const calls = [];
  let analysisPayload;
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    calls.push({ url: request.url, role: body.model });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/embeddings") {
      response.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
    } else {
      let data;
      if (body.model === "extraction") data = { facts: [{ fact_type: "ratio", value: 0.3, block_id: "b1", raw_text: "百分之三十", clause_no: "2.3" }] };
      else { analysisPayload = JSON.parse(body.messages[1].content); data = { risks: [] }; }
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const events = [];
  const result = await runReview({ review: { project: { project_id: "p", file_version_id: "v", contract_type: "software" },
    document: document("2.3 首付款百分之三十。"), config: { snapshot: { id: "law-v1", status: "published" } } },
    state: { capabilities: { models: ["extraction", "embedding", "analysis", "rerank", "vision"].map((role) => model(role, { endpoint })) },
      knowledge: { legalSnapshots: [source({ status: "published" })] } }, onProgress: (event) => events.push(event) });
  assert.deepEqual([...new Set(calls.map((call) => call.role))].sort(), ["analysis", "embedding", "extraction"]);
  assert.ok(calls.some((call) => call.url === "/v1/embeddings"));
  assert.ok(analysisPayload.facts.some((fact) => fact.fact_type === "ratio" && fact.value === 0.3));
  assert.ok(analysisPayload.evidence.some((hit) => hit.source_id === "law-v1"));
  for (const role of ["analysis", "embedding", "extraction"]) assert.equal(result.review.execution_summary[role].status, "completed");
  assert.equal(result.review.execution_summary.rerank.status, "not_integrated");
  assert.ok(events.some((event) => event.step === "extract" && event.executionSummary.extraction.call_count === 1));
  assert.equal(JSON.stringify(result.review.execution_summary).includes(endpoint), false);
  assert.equal(JSON.stringify(result.review.config.execution).includes(endpoint), false);
});
