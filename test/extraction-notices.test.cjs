const test = require("node:test");
const assert = require("node:assert/strict");
const { runReview } = require("../electron/review-runner.cjs");
const { extractWithModel } = require("../electron/model-extraction.cjs");
const { buildReviewPipeline, isExtractionFailure, EXTRACTION_FAILURE_CODES } = require("../src/services/reviewPipeline.mjs");

const EXTRACTION_MODEL = {
  configId: "cfg-extraction", name: "extraction-model", modelId: "test-extraction", role: "extraction",
  status: "active", testStatus: "passed", endpoint: "https://models.invalid/v1",
  credentialRef: "none", contextLength: 16000, maxTokens: 2048
};

const TEXT = "2.3 甲方向乙方支付人民币 634,000 元。";

function baseReview() {
  return {
    project: { project_id: "notice-project", file_version_id: "contract_v1", contract_type: "software" },
    document: { documentType: "docx", fileVersionId: "contract_v1", text: TEXT,
      blocks: [{ block_id: "b1", page: null, logical_page: 1, text: TEXT }], pages: [{ page: 1, text: TEXT }] },
    config: { snapshot: { id: "", status: "draft" }, rules: [], policies: [] },
    task: { task_id: "notice-task", status: "queued", progress: 0 },
    risks: []
  };
}

// 模型回传的候选：模型自报 999，引文实际是 634,000 —— 必然被本地数值校验剔除。
const TAMPERED_MONEY = { fact_type: "money", value: "999", i: "b1", raw_text: "人民币 634,000 元" };

function runWithFacts(facts, overrides = {}) {
  return runReview({
    review: { ...baseReview(), ...overrides },
    state: { knowledge: { legalSnapshots: [], rules: [], policies: [] }, capabilities: { models: [EXTRACTION_MODEL] }, settings: {} },
    services: { invokeModel: async () => ({ ok: true, data: { facts } }) }
  });
}

test("一条候选被本地校验剔除，不得把抽取与规则阶段标成异常", async () => {
  // 回归：此前任何 rejection 都会让 summary.status=partial，
  // 而 review-runner 把全部 EXTRACTION_* 告警提升为 errors，
  // 于是"条款事实抽取"和"确定性规则"两个阶段在界面上显示为"异常"，
  // 尽管七个阶段其实全部跑完。用户因此以为抽取/规则工作流坏了。
  const result = await runWithFacts([TAMPERED_MONEY]);
  const summary = result.review.execution_summary.extraction;
  assert.equal(summary.rejected_fact_count, 1, "该候选必须确实被剔除");
  assert.equal(summary.status, "completed", "少量语义类剔除不构成抽取失败");
  assert.equal(result.review.task.status, "completed");
  assert.ok(!result.review.task.errors.some((error) => error.code === "EXTRACTION_FACTS_REJECTED"),
    "校验剔除属于保护机制，不得进入任务错误通道");
  // 阶段必须全部 completed，没有任何一个标红
  const pipeline = buildReviewPipeline(result.review.task, { riskCount: 0 });
  assert.deepEqual(pipeline.filter((step) => step.status === "failed").map((step) => step.key), [],
    "不应有任何阶段被标为失败");
  assert.equal(pipeline.find((step) => step.key === "extract").status, "completed");
  assert.equal(pipeline.find((step) => step.key === "rules").status, "completed");
  // 信息不能丢：告警仍完整保留在 fact_warnings 供核验窗口消费
  assert.ok((result.review.fact_warnings || []).some((warning) => warning.code === "EXTRACTION_FACTS_REJECTED"),
    "剔除告警必须保留在 fact_warnings，只是不再冒充任务错误");
});

test("抽取真实失败仍必须进入错误通道并标红抽取阶段", async () => {
  // 放宽的只能是"提示"，真实故障不能被一起放过。
  const result = await runReview({
    review: baseReview(),
    state: { knowledge: { legalSnapshots: [], rules: [], policies: [] }, capabilities: { models: [EXTRACTION_MODEL] }, settings: {} },
    services: { invokeModel: async () => { const error = new Error("抽取模型请求超时"); error.code = "MODEL_REQUEST_TIMEOUT"; throw error; } }
  });
  const summary = result.review.execution_summary.extraction;
  assert.equal(summary.status, "degraded");
  assert.equal(summary.fallback, "rules", "抽取失败必须如实降级为规则事实");
  assert.ok(result.review.task.errors.some((error) => error.code === "EXTRACTION_DEGRADED"),
    "真实抽取失败必须以 EXTRACTION_DEGRADED 上报");
  const pipeline = buildReviewPipeline(result.review.task, { riskCount: 0 });
  assert.equal(pipeline.find((step) => step.key === "extract").status, "failed", "真实失败必须标红抽取阶段");
  assert.equal(result.review.task.status, "partial");
});

test("失败名单是显式白名单，未登记的码一律按提示处理", async () => {
  // 原实现用 code.startsWith("EXTRACTION_") 做前缀通配，任何新增的 EXTRACTION_* 都会被当成故障。
  assert.deepEqual([...EXTRACTION_FAILURE_CODES].sort(), ["EXTRACTION_DEGRADED", "EXTRACTION_OUTPUT_BUDGET_EXHAUSTED"]);
  assert.equal(isExtractionFailure("EXTRACTION_FACTS_REJECTED"), false);
  assert.equal(isExtractionFailure("EXTRACTION_BUDGET_ESCALATED"), false, "提高预算后重试成功是恢复路径，不是故障");
  assert.equal(isExtractionFailure("EXTRACTION_BATCH_TRUNCATED"), false, "拆批重试是恢复路径，不是故障");
  assert.equal(isExtractionFailure("EXTRACTION_SOMETHING_NEW"), false, "未登记的码不得默认当故障");
  assert.equal(isExtractionFailure(""), false);
  assert.equal(isExtractionFailure(undefined), false);
});

test("抽取状态按拒绝原因区分：锚定失败才降级，值不符不降级", async () => {
  const document = { text: TEXT, documentType: "docx", pages: [{ page: 1, text: TEXT }],
    blocks: [{ block_id: "b1", page: null, logical_page: 1, text: TEXT }] };
  const invoke = (facts) => ({ model: EXTRACTION_MODEL, invokeModel: async () => ({ ok: true, data: { facts } }) });
  const money = (value, blockId) => ({ fact_type: "money", value, i: blockId, raw_text: "人民币 634,000 元" });

  // 模型的引文对不上原文（块号不存在）→ 锚定类失败，抽取确实没起作用
  const anchored = await extractWithModel(document, invoke(Array.from({ length: 6 }, () => money("634000", "docx_block_999"))));
  assert.equal(anchored.summary.status, "partial", "几乎全批锚定失败应降级");
  assert.ok(anchored.summary.rejection_reasons.block_not_in_batch >= 6);

  // 模型抓对了位置、只是自报数值被改写 → 语义类失败，属于正常拦改
  const semantic = await extractWithModel(document, invoke(Array.from({ length: 6 }, () => money("999", "b1"))));
  assert.equal(semantic.summary.status, "completed", "值不符属于正常拦改，不构成抽取失败");
  assert.equal(semantic.summary.discard_ratio, 1);

  // 模型抓对了且规则层已有 → 判重合并，完全正常
  const duplicated = await extractWithModel(document, invoke(Array.from({ length: 6 }, () => money("634000", "b1"))));
  assert.equal(duplicated.summary.status, "completed");
  assert.ok(duplicated.summary.duplicate_fact_count >= 5);
});
