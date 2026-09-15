const test = require("node:test");
const assert = require("node:assert/strict");

test("任务流水线按当前步骤和进度标记已完成、执行中与待执行阶段", async () => {
  const { buildReviewPipeline } = await import("../src/services/reviewPipeline.mjs");

  const pipeline = buildReviewPipeline({
    status: "running",
    current_step: "retrieve",
    progress: 52,
    errors: []
  }, { riskCount: 2 });

  assert.deepEqual(pipeline.map((step) => step.status), [
    "completed",
    "completed",
    "running",
    "pending",
    "pending",
    "pending"
  ]);
  assert.equal(pipeline.find((step) => step.key === "retrieve").progress, 52);
  assert.equal(pipeline.find((step) => step.key === "retrieve").riskCount, 2);
});

test("审查进度事件携带规则和模型阶段的风险数量", async () => {
  const { runReview } = require("../electron/review-runner.cjs");
  const events = [];
  const result = await runReview({
    review: {
      project: { project_id: "pipeline-project", file_version_id: "contract_v1", contract_type: "procurement" },
      document: { fileVersionId: "contract_v1", text: "第四条 付款\n预付款 40%。", pages: [{ page: 1, text: "第四条 付款\n预付款 40%。" }] },
      config: { snapshot: { id: "", status: "draft" }, rules: ["payment-rules"], policies: [] },
      task: { task_id: "pipeline-task", status: "queued", progress: 0 }
    },
    state: {
      knowledge: {
        legalSnapshots: [],
        rules: [{ file: "payment-rules", selected: true, type: "金额计算", clauses: [{ clause_no: "R-001", title: "预付款比例", text: "预付款比例不得超过 30%" }] }],
        policies: []
      },
      capabilities: { models: [] },
      settings: {}
    },
    services: { invokeModel: async () => ({ ok: false, errorCode: "MODEL_CONFIG_INVALID", message: "测试未配置模型" }) },
    onProgress: (event) => events.push(event)
  });

  const retrieveEvent = events.find((event) => event.step === "retrieve");
  const persistEvent = events.find((event) => event.step === "persist");
  assert.equal(retrieveEvent.riskCount, 1);
  assert.equal(persistEvent.riskCount, result.review.risks.length);
});
