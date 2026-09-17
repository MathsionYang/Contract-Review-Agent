const test = require("node:test");
const assert = require("node:assert/strict");
const { runReview } = require("../electron/review-runner.cjs");

const ANALYSIS_MODEL = {
  configId: "cfg-analysis",
  name: "analysis-model",
  modelId: "test-analysis",
  role: "analysis",
  status: "active",
  testStatus: "passed",
  endpoint: "http://127.0.0.1:1/v1/chat/completions",
  contextLength: 16000,
  maxTokens: 2048
};

function baseReview(overrides = {}) {
  return {
    project: { project_id: "cancel-project", file_version_id: "contract_v1", contract_type: "procurement" },
    document: {
      documentType: "docx",
      fileVersionId: "contract_v1",
      text: "第四条 付款\n预付款 40%。\n第五条 保密",
      sha256: "hash-cancel-fixture",
      pages: [{ page: 1, text: "第四条 付款\n预付款 40%。\n第五条 保密" }]
    },
    config: { snapshot: { id: "", status: "draft" }, rules: ["payment-rules"], policies: [] },
    task: { task_id: "cancel-task", status: "queued", progress: 0 },
    risks: [],
    ...overrides
  };
}

function baseState() {
  return {
    knowledge: {
      legalSnapshots: [],
      rules: [{ file: "payment-rules", selected: true, clauses: [{ clause_no: "R-001", title: "预付款比例", text: "预付款比例不得超过 30%" }] }],
      policies: []
    },
    capabilities: { models: [], skills: [] },
    settings: {}
  };
}

test("模型阶段被停止时保留已生成候选风险并把任务落为 cancelled", async () => {
  const controller = new AbortController();
  const result = await runReview({
    review: baseReview(),
    state: { ...baseState(), capabilities: { models: [ANALYSIS_MODEL], skills: [] } },
    services: {
      signal: controller.signal,
      // 模拟网关在收到中断信号后按既有契约返回取消码，而不是抛异常。
      invokeModel: async (options) => {
        assert.equal(options.signal, controller.signal, "审查主链路必须把中断信号传给模型网关");
        controller.abort();
        return { ok: false, errorCode: "MODEL_REQUEST_CANCELLED", message: "模型请求已取消", attempts: 1 };
      }
    }
  });

  assert.equal(result.review.task.status, "cancelled");
  assert.equal(result.validation, null, "已取消的审查不能生成校验结果");
  assert.match(result.review.review_version_id, /-CANCELLED-/);
  assert.equal(result.review.execution_summary.analysis.status, "cancelled");
  assert.ok(result.errors.some((error) => error.code === "REVIEW_CANCELLED" && error.stage === "model"));
  // 取消前完成的本地检查与风险必须保留，不能因为停止而清空。
  assert.ok(result.review.risks.length > 0, "本地确定性风险必须保留");
  assert.ok(result.review.check_results.length > 0, "已执行的确定性检查必须保留");
  assert.equal(result.review.task.progress < 100, true, "取消的任务不能显示为 100% 完成");
});

test("取消发生在语义分析开始前时不发起模型请求", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await runReview({
    review: baseReview(),
    state: { ...baseState(), capabilities: { models: [ANALYSIS_MODEL], skills: [] } },
    services: { signal: controller.signal, invokeModel: async () => { calls += 1; return { ok: true, data: { risks: [] } }; } }
  });
  assert.equal(calls, 0, "已取消的任务不得再调用模型");
  assert.equal(result.review.task.status, "cancelled");
  assert.equal(result.review.task.current_step, "parse");
  assert.deepEqual(result.errors.map((error) => error.code), ["REVIEW_CANCELLED"]);
});

test("取消在开始前落地时任务直接以 cancelled 收尾，不伪造完成", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runReview({
    review: baseReview({ document: null }),
    state: baseState(),
    services: { signal: controller.signal }
  });
  assert.equal(result.review.task.status, "cancelled");
  assert.equal(result.review.task.progress, 0);
  assert.ok(result.errors.length === 0 || result.errors.every((error) => error.code === "REVIEW_CANCELLED"));
});

test("未提供中断信号时行为与既有链路一致", async () => {
  const result = await runReview({
    review: baseReview(),
    state: baseState(),
    services: { invokeModel: async () => ({ ok: false, errorCode: "MODEL_CONFIG_INVALID", message: "测试未配置模型" }) }
  });
  assert.ok(["completed", "partial"].includes(result.review.task.status));
  assert.notEqual(result.review.task.status, "cancelled");
  assert.ok(result.review.risks.length > 0);
});
