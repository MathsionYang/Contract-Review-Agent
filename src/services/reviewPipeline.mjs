import { LEGACY_NOTICE_CODES } from "./extractionNotices.mjs";

// 供既有调用方沿用（ExtractionReview 等）。名单本身在 extractionNotices.mjs。
export { EXTRACTION_FAILURE_CODES, isExtractionFailure } from "./extractionNotices.mjs";

export const REVIEW_PIPELINE_STEPS = [
  { key: "parse", label: "解析合同", domain: "L6 文本与形式", description: "读取合同文本、页码和文件版本" },
  { key: "extract", label: "条款事实抽取", domain: "结构化事实与原文定位", description: "抽取模型、规则补充与原文校验" },
  { key: "rules", label: "确定性规则", domain: "L1 主体与效力 · L2 标的与商务", description: "执行金额、日期、必备条款和硬伤检查" },
  { key: "retrieve", label: "检索审查依据", domain: "L5 合规与程序", description: "匹配法律快照、企业制度和规则依据" },
  { key: "model", label: "语义风险分析", domain: "L3 权利义务 · L4 风险与救济", description: "调用 analysis 模型生成候选风险" },
  { key: "validate", label: "结果校验", domain: "证据、等级与结论", description: "校验定位、依据、状态和导出条件" },
  { key: "persist", label: "保存审查版本", domain: "审查输出与追踪", description: "保存风险、任务状态和审计记录" }
];

const TERMINAL_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);
// 被用户停止或出现错误的任务：按错误所在阶段标注失败步骤，其余步骤保留已完成状态。
const INTERRUPTED_STATUSES = new Set(["failed", "partial", "cancelled"]);
const STEP_KEYS = new Set(REVIEW_PIPELINE_STEPS.map((step) => step.key));
// 明确的失败码 → 阶段映射。原先用 `code.startsWith("EXTRACTION_")` 做前缀通配，
// 会把未来新增的任何 EXTRACTION_* 默认当成故障，是"条款事实抽取"被误标异常的结构性来源。
const STEP_FAILURE_CODES = new Map([
  ["EXTRACTION_DEGRADED", "extract"],
  ["EXTRACTION_OUTPUT_BUDGET_EXHAUSTED", "extract"],
  ["REVIEW_CANCELLED", "extract"],
  ["DOCUMENT_TEXT_UNAVAILABLE", "parse"],
  ["CRITICAL_CHECKS_INCOMPLETE", "rules"],
  ["CHECKLIST_REVIEW_REQUIRED", "rules"]
]);

function clampProgress(value) {
  return Math.min(Math.max(Number(value) || 0, 0), 100);
}

function errorStep(errors = []) {
  // 编排写入的 stage 就是最准确的阶段归属，优先采用，避免只能定位到抽取和检索两步。
  // 但诊断提示自带 stage 也只是"产生位置"，不代表该阶段失败，必须先排除。
  const decisive = errors.filter((item) => !LEGACY_NOTICE_CODES.has(String(item?.code || "")));
  const staged = decisive.find((item) => STEP_KEYS.has(String(item?.stage || "")));
  if (staged) return String(staged.stage);
  const mapped = decisive.map((item) => STEP_FAILURE_CODES.get(String(item?.code || ""))).filter(Boolean);
  if (mapped.length) return mapped[0];
  if (decisive.some((item) => String(item.code).startsWith("EMBEDDING_"))) return "retrieve";
  if (decisive.some((item) => String(item.code).startsWith("MODEL_"))) return "model";
  if (decisive.some((item) => String(item.code).startsWith("FILE_"))) return "parse";
  if (decisive.some((item) => String(item.code).includes("VALIDAT") || String(item.code).startsWith("EXPORT_"))) return "validate";
  return "";
}

export function buildReviewPipeline(task = {}, summary = {}) {
  const status = String(task.status || "queued");
  const currentKey = String(task.current_step || "parse");
  const currentIndex = Math.max(0, REVIEW_PIPELINE_STEPS.findIndex((step) => step.key === currentKey));
  const failedKey = INTERRUPTED_STATUSES.has(status) ? errorStep(Array.isArray(task.errors) ? task.errors : []) : "";
  const failedIndex = failedKey ? REVIEW_PIPELINE_STEPS.findIndex((step) => step.key === failedKey) : -1;
  // 取消或错误未能定位到具体阶段时，退回已完成步骤之后的当前游标，避免整条流水线被标成待执行。
  const activeIndex = failedIndex >= 0 ? failedIndex : INTERRUPTED_STATUSES.has(status) ? Math.max(currentIndex, 0) : currentIndex;
  const progress = clampProgress(task.progress);
  const riskCount = Math.max(0, Number(summary.riskCount) || 0);

  return REVIEW_PIPELINE_STEPS.map((step, index) => {
    let stepStatus = "pending";
    if (status === "completed") stepStatus = "completed";
    else if (INTERRUPTED_STATUSES.has(status)) {
      // 带错误的步骤优先标记为失败；partial/failed 已走完全部步骤，cancelled 则停在当前步骤。
      const hasError = (task.errors || []).some((error) => errorStep([error]) === step.key);
      const passed = status === "cancelled" ? index < currentIndex : true;
      stepStatus = hasError ? "failed" : passed ? "completed" : "pending";
    }
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
    cancelling: "正在停止",
    completed: "已完成",
    failed: "异常",
    partial: "部分完成",
    cancelled: "已取消",
    pending: "待执行"
  }[status] || "待执行";
}

export function pipelineOverallLabel(task = {}) {
  const status = String(task.status || "queued");
  if (TERMINAL_STATUSES.has(status)) return pipelineStatusLabel(status);
  return pipelineStatusLabel(status === "queued" ? "queued" : "running");
}
