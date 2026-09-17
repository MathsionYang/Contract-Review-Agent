const { runReview } = require("./electron/review-runner.cjs");
const { buildReviewPipeline } = require("./src/services/reviewPipeline.mjs");
const model = { configId: "ex", name: "mock", modelId: "mock", role: "extraction", status: "active", testStatus: "passed",
  endpoint: "https://models.invalid/v1", credentialRef: "none", contextLength: 16000, maxTokens: 2048 };
const text = "1.1 乙方应按附件三《服务水平协议》执行，服务费为人民币 634,000 元。";
const mk = () => ({ project: { project_id: "p", file_version_id: "v", contract_type: "software" },
  document: { text, blocks: [{ block_id: "b1", page: null, logical_page: 1, text }], pages: [{ page: 1, text }] }, config: { rules: [], policies: [] } });
(async () => {
  const r = await runReview({ review: mk(), state: { capabilities: { models: [model] } },
    services: { invokeModel: async () => ({ ok: true, data: { facts: [
      { fact_type: "reference", i: "b1", raw_text: "附件三《服务水平协议》", value: "附件三《服务水平协议》" },  // 应采纳
      { fact_type: "obligation", i: "b1", raw_text: "乙方应按附件三《服务水平协议》执行", subject: "乙方", action: "按附件三《服务水平协议》执行", value: "按附件三《服务水平协议》执行" }, // 与规则重复
      { fact_type: "money", value: "999", i: "b1", raw_text: "人民币 634,000 元" }] } }) } });
  const s = r.review.execution_summary.extraction;
  console.log("抽取结果: 采纳", s.accepted_fact_count, "重复", s.duplicate_fact_count, "拒绝", s.rejected_fact_count, "→ 抽取状态:", s.status);
  console.log("任务状态:", r.review.task.status);
  console.log("提升为 errors 的告警:", r.review.task.errors.map(e=>e.code).join(", "));
  console.log("\n流水线各阶段渲染：");
  for (const step of buildReviewPipeline(r.review.task, { riskCount: 0 })) {
    const mark = step.status === "failed" ? "  ← 显示为【异常】" : "";
    console.log(`  ${step.key.padEnd(9)} ${step.label.padEnd(12)} ${step.status}${mark}`);
  }
})();
