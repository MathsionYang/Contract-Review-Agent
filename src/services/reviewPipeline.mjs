export const REVIEW_PIPELINE_STEPS = [
  { key: "parse", label: "解析合同", domain: "L6 文本与形式", description: "读取合同文本、页码和文件版本" },
  { key: "rules", label: "确定性规则", domain: "L1 主体与效力 · L2 标的与商务", description: "执行金额、日期、必备条款和硬伤检查" },
  { key: "retrieve", label: "检索审查依据", domain: "L5 合规与程序", description: "匹配法律快照、企业制度和规则依据" },
  { key: "model", label: "语义风险分析", domain: "L3 权利义务 · L4 风险与救济", description: "调用 analysis 模型生成候选风险" },
  { key: "validate", label: "结果校验", domain: "证据、等级与结论", description: "校验定位、依据、状态和导出条件" },
  { key: "persist", label: "保存审查版本", domain: "审查输出与追踪", description: "保存风险、任务状态和审计记录" }
];

const TERMINAL_STATUSES = new Set(["completed", "partial", "failed"]);

function clampProgress(value) {
  return Math.min(Math.max(Number(value) || 0, 0), 100);
}

function errorStep(errors = []) {
  const codes = errors.map((item) => String(item?.code || ""));
  if (codes.some((code) => code === "DOCUMENT_TEXT_UNAVAILABLE" || code.startsWith("FILE_"))) return "parse";
  if (codes.some((code) => code.startsWith("MODEL_"))) return "model";
  if (codes.some((code) => code.includes("VALIDAT") || code.startsWith("EXPORT_"))) return "validate";
  return "";
}

export function buildReviewPipeline(task = {}, summary = {}) {
  const status = String(task.status || "queued");
  const currentKey = String(task.current_step || "parse");
  const currentIndex = Math.max(0, REVIEW_PIPELINE_STEPS.findIndex((step) => step.key === currentKey));
  const failedKey = status === "failed" || status === "partial" ? errorStep(Array.isArray(task.errors) ? task.errors : []) : "";
  const failedIndex = failedKey ? REVIEW_PIPELINE_STEPS.findIndex((step) => step.key === failedKey) : -1;
  const activeIndex = failedIndex >= 0 ? failedIndex : currentIndex;
  const progress = clampProgress(task.progress);
  const riskCount = Math.max(0, Number(summary.riskCount) || 0);

  return REVIEW_PIPELINE_STEPS.map((step, index) => {
    let stepStatus = "pending";
    if (status === "completed") stepStatus = "completed";
    else if (status === "queued") stepStatus = index === 0 ? "queued" : "pending";
    else if (index < activeIndex) stepStatus = "completed";
    else if (index === activeIndex) stepStatus = failedIndex >= 0 ? "failed" : "running";

    return {
      ...step,
      status: stepStatus,
      progress: index === activeIndex && stepStatus === "running" ? progress : stepStatus === "completed" ? 100 : 0,
      riskCount
    };
  });
}

export function pipelineStatusLabel(status) {
  return {
    queued: "待开始",
    running: "执行中",
    completed: "已完成",
    failed: "异常",
    partial: "部分完成",
    pending: "待执行"
  }[status] || "待执行";
}

export function pipelineOverallLabel(task = {}) {
  const status = String(task.status || "queued");
  if (TERMINAL_STATUSES.has(status)) return pipelineStatusLabel(status);
  return pipelineStatusLabel(status === "queued" ? "queued" : "running");
}
