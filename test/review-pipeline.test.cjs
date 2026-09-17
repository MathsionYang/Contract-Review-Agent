const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
    "completed",
    "running",
    "pending",
    "pending",
    "pending"
  ]);
  assert.equal(pipeline.find((step) => step.key === "retrieve").progress, 52);
  assert.equal(pipeline.find((step) => step.key === "retrieve").riskCount, 2);
});

test("部分完成显示各自失败阶段，不把已持久化的任务显示为仍在运行", async () => {
  const { buildReviewPipeline } = await import("../src/services/reviewPipeline.mjs");
  const pipeline = buildReviewPipeline({ status: "partial", current_step: "persist", progress: 100,
    errors: [{ code: "CRITICAL_CHECKS_INCOMPLETE" }, { code: "MODEL_REQUEST_TIMEOUT" }] });
  assert.deepEqual(pipeline.map((step) => step.status), ["completed", "completed", "failed", "completed", "failed", "completed", "completed"]);
});

test("停止审查的任务显示为已取消并保留中断前的已完成阶段", async () => {
  const { buildReviewPipeline, pipelineOverallLabel } = await import("../src/services/reviewPipeline.mjs");
  const pipeline = buildReviewPipeline({ status: "cancelled", current_step: "model", progress: 70,
    errors: [{ code: "REVIEW_CANCELLED", stage: "validate", message: "审查已被用户停止" }] });
  assert.deepEqual(pipeline.map((step) => step.status), ["completed", "completed", "completed", "completed", "pending", "failed", "pending"]);
  assert.equal(pipelineOverallLabel({ status: "cancelled" }), "已取消");
});

test("取消阶段无法定位时按当前游标收尾，不把整条流水线标成待执行", async () => {
  const { buildReviewPipeline } = await import("../src/services/reviewPipeline.mjs");
  const pipeline = buildReviewPipeline({ status: "cancelled", current_step: "retrieve", progress: 52, errors: [] });
  assert.deepEqual(pipeline.map((step) => step.status), ["completed", "completed", "completed", "pending", "pending", "pending", "pending"]);
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

test("真实软件采购合同在无分析模型时仍执行结构化检查并保留覆盖率", async () => {
  const { parseContract } = require("../electron/parser.cjs");
  const { runReview } = require("../electron/review-runner.cjs");
  const filePath = path.join(__dirname, "..", "data", "软件采购合同.docx");
  const document = await parseContract(filePath);
  document.fileVersionId = "contract_fixture_v1";
  const result = await runReview({
    review: {
      project: { project_id: "fixture-project", file_version_id: "contract_fixture_v1", contract_type: "procurement" },
      document,
      config: { snapshot: { id: "", status: "draft" }, rules: [], policies: [] },
      task: { task_id: "fixture-task", status: "queued", progress: 0 }
    },
    state: { knowledge: { legalSnapshots: [], rules: [], policies: [] }, capabilities: { models: [] }, settings: {} }
  });

  assert.ok(Array.isArray(result.review.contract_facts));
  assert.ok(Array.isArray(result.review.check_results));
  assert.ok(result.review.check_results.some((item) => item.check_id === "amount.total_vs_uppercase" && item.status === "conflict"));
  assert.ok(result.review.check_results.some((item) => item.check_id === "penalty.stacking" && item.status === "conflict"));
  assert.ok(result.review.check_results.some((item) => item.check_id === "completeness.data_disposition" && item.status === "missing"));
  assert.ok(result.review.coverage && result.review.coverage.total >= 15);
  assert.ok(result.review.risks.some((item) => item.risk_topic === "amount_consistency"));
  assert.ok(result.review.risks.some((item) => item.risk_topic === "missing_clause"));
  assert.equal(result.review.checklist_results.length, 95);
  assert.equal(result.review.checklist_coverage.total, 95);
  assert.ok(result.review.checklist_coverage.unverifiable > 0);
  assert.equal(result.review.task.status, "partial");
  assert.equal(result.review.execution_summary.analysis.status, "not_configured");
  assert.ok(result.review.risks.some((item) => item.checklist_ids?.includes("GC-4-23")));
});

test("模型收到检查计划且不能用空风险结果覆盖通用清单未核验状态", async () => {
  const { runReview } = require("../electron/review-runner.cjs");
  let payload;
  const text = "1.1 软件服务合同，双方约定按期交付。";
  const result = await runReview({
    review: {
      project: { project_id: "model-checklist", file_version_id: "v", contract_type: "software" },
      document: { text, blocks: [{ block_id: "b1", page: null, text }], pages: [{ page: 1, text }] },
      config: { rules: [], policies: [] }
    },
    state: { capabilities: { models: [{ name: "mock", role: "analysis", status: "active" }] } },
    services: { invokeModel: async (request) => { payload = JSON.parse(request.messages[1].content); return { ok: true, data: { risks: [] } }; } }
  });
  assert.ok(payload.check_plan.some((c) => c.check_id === "GC-3-02"));
  assert.ok(payload.check_plan.every((c) => c.criterion && c.evidence_requirement));
  assert.ok(Array.isArray(payload.facts));
  assert.equal(result.review.execution_summary.analysis.status, "completed");
  assert.equal(result.review.checklist_results.find((c) => c.check_id === "GC-1-03").status, "unverifiable");
  assert.equal(result.review.task.status, "partial");
});

test("结构化文档的关键检查无法执行时任务降级为部分完成", async () => {
  const { runReview } = require("../electron/review-runner.cjs");
  const result = await runReview({
    review: {
      project: { project_id: "incomplete-project", file_version_id: "incomplete_v1", contract_type: "procurement" },
      document: {
        fileVersionId: "incomplete_v1",
        text: "采购合同仅包含标题，缺少金额、期限和责任条款。",
        pages: [{ page: 1, text: "采购合同仅包含标题，缺少金额、期限和责任条款。" }],
        blocks: [{ block_id: "page_1", block_type: "page", page: 1, page_status: "resolved", text: "采购合同仅包含标题，缺少金额、期限和责任条款。" }]
      },
      config: { snapshot: { id: "", status: "draft" }, rules: [], policies: [] },
      task: { task_id: "incomplete-task", status: "queued", progress: 0 }
    },
    state: { knowledge: { legalSnapshots: [], rules: [], policies: [] }, capabilities: { models: [] }, settings: {} }
  });

  assert.equal(result.review.task.status, "partial");
  assert.ok(result.errors.some((error) => error.code === "CRITICAL_CHECKS_INCOMPLETE"));
  assert.ok(result.review.coverage.unverifiable > 0);
});

test("95 项检查计划计入上下文预算，合同删节留痕，小窗口不发超长请求", async () => {
  const { runReview } = require("../electron/review-runner.cjs");
  const { estimateTokens } = require("../electron/context-assembler.cjs");
  const text = "软件服务合同交付与验收。".repeat(3000);
  const review = { project: { project_id: "budget", file_version_id: "v", contract_type: "software" },
    document: { text, pages: [{ page: 1, text }], blocks: [{ block_id: "b1", text, page: 1 }] }, config: {} };
  const model = { name: "mock", role: "analysis", status: "active", contextLength: 16000, maxTokens: 2048 };
  let calls = 0;
  const services = { invokeModel: async (request) => {
    calls += 1;
    assert.ok(estimateTokens(request.messages) <= model.contextLength - model.maxTokens - 512);
    return { ok: true, data: { risks: [] } };
  } };
  const first = await runReview({ review, state: { capabilities: { models: [model] } }, services });
  assert.equal(calls, 1);
  assert.deepEqual(first.review.model_context.truncated_pages, [1]);
  assert.ok(first.errors.some((e) => e.code === "MODEL_CONTEXT_TRUNCATED"));
  model.contextLength = 2000;
  const second = await runReview({ review, state: { capabilities: { models: [model] } }, services });
  assert.equal(calls, 1);
  assert.ok(second.errors.some((e) => e.code === "MODEL_CONTEXT_INSUFFICIENT"));
});
