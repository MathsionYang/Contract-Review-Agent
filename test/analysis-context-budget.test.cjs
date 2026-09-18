const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { runReview } = require("../electron/review-runner.cjs");
const { parseContract } = require("../electron/parser.cjs");

// 复刻"检索饥饿"场景：事实多到装不下，且数值类排在义务类之前。
function crowdedReview() {
  const text = Array.from({ length: 40 }, (_, i) => `${i + 1}.1 甲方应按第 ${i + 1} 条约定履行相应义务并支付相关款项。`).join("\n");
  const blocks = text.split("\n").map((line, index) => ({ block_id: `b${index + 1}`, page: null, logical_page: 1, text: line }));
  const facts = [];
  // 先放大量裸数值（规则层的自然顺序），再放语义事实
  for (let i = 0; i < 40; i += 1) facts.push({ fact_id: `m${i}`, fact_type: "ratio", value: 0.1, clause_no: `${i + 1}.1`,
    raw_text: "30%", source_refs: [{ block_id: `b${i + 1}`, char_range: [10, 13] }] });
  for (let i = 0; i < 40; i += 1) facts.push({ fact_id: `o${i}`, fact_type: "obligation", value: undefined, clause_no: `${i + 1}.1`,
    raw_text: `甲方应按第 ${i + 1} 条约定履行相应义务并支付相关款项`, subject: "甲方", action: "履行义务",
    source_refs: [{ block_id: `b${i + 1}`, char_range: [0, 20] }] });
  return { review: { project: { project_id: "crowded", file_version_id: "v", contract_type: "software" },
    document: { text, documentType: "docx", fileVersionId: "v", pages: [{ page: 1, text }], blocks },
    contract_facts: facts, checklist_results: [], config: { snapshot: { id: "", status: "draft" }, rules: [], policies: [] },
    task: { task_id: "crowded-task", status: "queued", progress: 0 } } };
}

const SMALL_MODEL = { configId: "an", name: "small", modelId: "small", role: "analysis", status: "active",
  testStatus: "passed", endpoint: "x", credentialRef: "none", contextLength: 3000, maxTokens: 512 };

test("上下文装不下全部事实时，义务/责任类事实优先入场", async () => {
  // 回归：原实现按 contract_facts 数组顺序取前 N 条，实测 74 条事实里进模型的前 10 条
  // 全是裸 money/ratio 数值，31 条 obligation 与 8 条 penalty 全部落在上下文之外——
  // 而"赔偿责任累计不超过总价 5%""单方解除应付 30% 违约金"这类判断风险唯一需要的原料正在其中。
  const payloads = [];
  const base = crowdedReview();
  await runReview({ ...base,
    state: { knowledge: { legalSnapshots: [], rules: [], policies: [] }, capabilities: { models: [SMALL_MODEL] }, settings: {} },
    services: { invokeModel: async (request) => { payloads.push(JSON.parse(request.messages[1].content)); return { ok: true, data: { risks: [] } }; } } });
  assert.ok(payloads.length, "必须调用到分析模型");
  const facts = payloads.flatMap((payload) => payload.facts);
  const semantic = facts.filter((fact) => fact.fact_type === "obligation").length;
  assert.ok(semantic > 0, `义务事实必须入场，实际 ${semantic} 条`);
  assert.ok(semantic >= facts.length / 2,
    `义务事实应占多数：${semantic}/${facts.length}`);
});

test("事实与证据装不进首批时自动补审，完整覆盖后不再提示被剔除", async () => {
  const contexts = [];
  let calls = 0;
  const base = crowdedReview();
  const result = await runReview({ ...base,
    state: { knowledge: { legalSnapshots: [], rules: [], policies: [] }, capabilities: { models: [SMALL_MODEL] }, settings: {} },
    services: { invokeModel: async (request) => { calls += 1; contexts.push(JSON.parse(request.messages[1].content)); return { ok: true, data: { risks: [] } }; } } });
  const snapshot = result.review.model_context;
  assert.ok(snapshot, "必须记录 model_context");
  assert.ok(calls > 1, `超出首批预算时应自动补审，实际调用 ${calls} 次`);
  assert.equal(snapshot.omitted_fact_count, 0, `补审后不应遗留事实剔除，实际 ${snapshot.omitted_fact_count}`);
  assert.equal(snapshot.omitted_evidence_count, 0);
  const codes = (result.review.task.errors || []).map((error) => error.code);
  assert.equal(codes.includes("MODEL_CONTEXT_FACTS_OMITTED"), false, `完整补审后不应告警：${codes.join(",")}`);
  assert.equal(codes.includes("MODEL_CONTEXT_EVIDENCE_OMITTED"), false);
  assert.equal(result.review.task.status, "completed");
  assert.ok(contexts.every((context) => Array.isArray(context.facts)));
});

test("合同正文本身享有优先预算，不被事实与证据挤空", async () => {
  const base = crowdedReview();
  let context = null;
  const result = await runReview({ ...base,
    state: { knowledge: { legalSnapshots: [], rules: [], policies: [] }, capabilities: { models: [SMALL_MODEL] }, settings: {} },
    services: { invokeModel: async (request) => { context = JSON.parse(request.messages[1].content); return { ok: true, data: { risks: [] } }; } } });
  const snapshot = result.review.model_context;
  assert.ok(Number(snapshot.page_char_limit) >= 16,
    `正文每页字符上限不应退化到个位数，实际 ${snapshot.page_char_limit}`);
  assert.ok(String(context.document).length > 0, "合同正文必须进入上下文");
});
