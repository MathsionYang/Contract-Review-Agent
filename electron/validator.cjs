const ALLOWED_LEVELS = new Set(["critical", "high", "medium", "low", "info"]);
const crypto = require("node:crypto");
const catalog = require("./general-checklist-catalog.json");
const { coverageFrom, validHumanReview } = require("./checklist-policy.cjs");
const ALLOWED_CATEGORIES = new Set(["legal", "commercial", "company_policy", "text_quality", "evidence"]);
const ALLOWED_CONCLUSIONS = new Set(["candidate", "confirmed", "needs_verification", "rejected"]);
const ALLOWED_EVIDENCE = new Set(["verified", "partially_verified", "unverified", "invalid", "not_applicable"]);
const ALLOWED_HUMAN = new Set([
  "pending_review",
  "accepted",
  "modified",
  "false_positive",
  "deferred",
  "added_by_human",
  "deleted"
]);
const ALLOWED_FORMATS = new Set(["DOCX", "PDF", "XLSX", "JSON"]);
const EXPORT_POLICY_VERSION = "review-export@2.0.0";
const DRAFT_WARNING_CODES = new Set([
  "CONTRACT_TYPE_MISSING", "DOCUMENT_TEXT_UNAVAILABLE", "SNAPSHOT_NOT_FOUND",
  "CRITICAL_CHECK_SKIPPED", "CHECKLIST_REVIEW_REQUIRED", "REVIEW_INCOMPLETE",
  "HIGH_RISK_LOCATION_UNRESOLVED", "LOCATION_INVALID", "LOCATION_UNVERIFIED",
  "PENDING_HUMAN_REVIEW", "EVIDENCE_INCOMPLETE", "INVALID_EVIDENCE",
  "LEGAL_SOURCE_INVALID", "SNAPSHOT_MISMATCH"
]);

function checkItem(items, id, label, status, code, message, suggestion, riskId) {
  items.push({
    id,
    label,
    status,
    code: code || null,
    message,
    suggestion: suggestion || "",
    riskId: riskId || null
  });
}

function locationHasAnchor(location) {
  return Boolean(
    location && (
      String(location.quote || "").trim() ||
      Array.isArray(location.char_range) ||
      Array.isArray(location.coordinate_range) ||
      Array.isArray(location.bbox)
    )
  );
}

function validBlockAnchor(location, document) {
  if (document?.documentType !== "docx" || location?.location_status !== "resolved") return false;
  const refs = location.source_refs?.length ? location.source_refs : [location];
  return refs.some((ref) => {
    const block = document.blocks?.find((b) => b.block_id === ref.block_id);
    if (!block || !ref.quote || ref.quote !== location.quote) return false;
    const text = String(block.text || "");
    const hash = `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
    // 兼容历史事实证据：只在哈希一致且原文在块内唯一时补认未保存的范围。
    const start = text.indexOf(ref.quote);
    const range = ref.char_range === undefined && start >= 0 && text.indexOf(ref.quote, start + 1) === -1
      ? [start, start + ref.quote.length] : ref.char_range;
    return ref.text_hash === hash && Array.isArray(range) && range.length === 2
      && range.every(Number.isInteger) && range[0] >= 0 && range[1] > range[0]
      && range[1] <= text.length && text.slice(...range) === ref.quote;
  });
}

function containsSensitiveValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  return /(?:sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{20,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/.test(text);
}

function validateReview(review, options = {}) {
  const mode = options.mode === undefined ? "formal" : options.mode;
  const items = [];
  const blockingCodes = [];
  const warningCodes = [];
  const formalBlockingCodes = [];
  const block = (id, label, code, message, suggestion, riskId) => {
    if (!formalBlockingCodes.includes(code)) formalBlockingCodes.push(code);
    const warning = mode === "draft" && DRAFT_WARNING_CODES.has(code);
    const codes = warning ? warningCodes : blockingCodes;
    if (!codes.includes(code)) codes.push(code);
    checkItem(items, id, label, warning ? "warning" : "failed", code, message, suggestion, riskId);
  };
  const pass = (id, label, message) => checkItem(items, id, label, "passed", null, message);
  const result = () => ({
    mode, policyVersion: EXPORT_POLICY_VERSION, canExport: blockingCodes.length === 0,
    formalReady: formalBlockingCodes.length === 0, items, blockingCodes, warningCodes, formalBlockingCodes
  });
  if (!["draft", "formal"].includes(mode)) {
    block("output.mode", "导出模式", "INVALID_EXPORT_MODE", "导出模式无效", "请选择草稿或正式报告");
  }

  if (!review || typeof review !== "object") {
    block("input.review", "审查结果", "REVIEW_MISSING", "未提供审查结果", "请重新加载当前审查版本");
    return result();
  }

  const project = review.project;
  const document = review.document;
  if (["queued", "running", "working"].includes(review.task?.status)) {
    block("task.running", "审查任务状态", "EXPORT_TASK_RUNNING", "审查正在执行，结果尚未稳定", "等待任务完成后再导出");
  } else if (["partial", "failed"].includes(review.task?.status)) {
    block("task.incomplete", "审查任务状态", "REVIEW_INCOMPLETE", "本次审查未全部完成", "补齐任务失败或未执行的检查后再生成正式报告");
  } else if (review.task?.status === "cancelled") {
    block("task.cancelled", "审查任务状态", "REVIEW_CANCELLED", "本次审查已被用户停止，结果只保留已生成的候选风险", "重新执行完整审查后再生成正式报告");
  }
  if (!project || !project.project_id) {
    block("input.project", "项目身份", "PROJECT_MISSING", "当前审查缺少项目标识", "请从当前项目重新发起导出");
  } else {
    pass("input.project", "项目身份", "项目标识已确认");
  }
  if (!document || typeof document !== "object") {
    block("input.document", "合同文档", "DOCUMENT_MISSING", "当前审查缺少合同解析结果", "请重新导入合同并等待解析完成");
  } else {
    pass("input.document", "合同文档", "合同解析结果已绑定");
  }

  const fileVersionId = project?.file_version_id;
  if (!fileVersionId) {
    block("input.file-version", "合同文件版本", "FILE_VERSION_MISSING", "合同文件版本未明确", "请重新导入合同文件");
  } else {
    pass("input.file-version", "合同文件版本", "合同文件版本已明确");
  }

  if (!project?.contract_type) {
    block("input.contract-type", "合同类型", "CONTRACT_TYPE_MISSING", "合同类型未确认", "请在项目配置中确认合同类型");
  } else {
    pass("input.contract-type", "合同类型", "合同类型已确认");
  }

  const documentText = String(document?.text || "");
  const scannedPdf = document?.documentType === "scanned_pdf" || document?.document_type === "scanned_pdf";
  const pageOcrUnavailable = Array.isArray(document?.pages) && document.pages.some(
    (page) => page?.ocr?.status === "unavailable"
  );
  if (scannedPdf && (!documentText.trim() || document?.ocr?.status === "unavailable" || pageOcrUnavailable)) {
    block(
      "input.document-text",
      "解析/OCR 状态",
      "DOCUMENT_TEXT_UNAVAILABLE",
      "扫描 PDF 当前没有可验证的文本层或 OCR 结果",
      "接入 OCR 并保存页码与坐标映射后再生成正式报告"
    );
  } else if (!documentText.trim() && document) {
    block(
      "input.document-text",
      "解析文本",
      "DOCUMENT_TEXT_UNAVAILABLE",
      "合同解析文本为空，无法验证风险定位",
      "重新解析合同或人工确认解析失败原因"
    );
  } else if (document) {
    pass("input.document-text", "解析文本", "合同文本可用于校验");
  }

  const snapshot = review.config?.snapshot;
  if (!snapshot || snapshot.status !== "published") {
    block(
      "evidence.snapshot",
      "法律快照",
      "SNAPSHOT_NOT_FOUND",
      "法律快照不存在或尚未发布",
      "选择已发布且与本次审查绑定的法律快照"
    );
  } else {
    pass("evidence.snapshot", "法律快照", `已绑定已发布快照 ${snapshot.id || "未命名"}`);
  }

  const formats = Array.isArray(options.formats) ? options.formats : [];
  if (!formats.length) {
    block("output.formats", "导出格式", "NO_EXPORT_FORMAT", "没有选择导出格式", "至少选择 DOCX、PDF、XLSX 或 JSON 之一");
  }
  const unsupportedFormats = formats
    .map((format) => String(format).toUpperCase())
    .filter((format) => !ALLOWED_FORMATS.has(format));
  if (unsupportedFormats.length) {
    block(
      "output.formats",
      "导出格式",
      "UNSUPPORTED_EXPORT_FORMAT",
      `包含不支持的导出格式：${unsupportedFormats.join(", ")}`,
      "仅选择 DOCX、PDF、XLSX 或 JSON"
    );
  } else if (formats.length) {
    pass("output.formats", "导出格式", "导出格式可用");
  }

  if (containsSensitiveValue(review)) {
    block(
      "security.sensitive-data",
      "敏感信息检查",
      "SENSITIVE_DATA_DETECTED",
      "审查结果中检测到疑似密钥或认证信息",
      "移除明文密钥后再导出"
    );
  } else {
    pass("security.sensitive-data", "敏感信息检查", "未发现疑似明文凭据");
  }

  const checkResults = Array.isArray(review.check_results) ? review.check_results : null;
  if (checkResults) {
    const expectedCoverage = coverageFrom(checkResults);
    const coverageValid = review.coverage && Object.entries(expectedCoverage).every(
      ([key, value]) => Number.isInteger(review.coverage[key]) && review.coverage[key] === value
    );
    if (!coverageValid) {
      block(
        "checks.coverage",
        "结构化检查覆盖率",
        "COVERAGE_INVALID",
        "覆盖率元数据缺失或与结构化检查结果不一致",
        "重新执行结构化检查并保存完整覆盖率"
      );
    } else {
      pass("checks.coverage", "结构化检查覆盖率", `已记录 ${expectedCoverage.total} 项检查的执行状态`);
    }

    const skippedCritical = checkResults.filter(
      (check) => (check?.severity === "critical" || check?.severity === "high") && check?.status === "skipped"
    );
    if (skippedCritical.length) {
      block(
        "checks.critical-skipped",
        "关键检查执行状态",
        "CRITICAL_CHECK_SKIPPED",
        `有 ${skippedCritical.length} 项关键检查未执行`,
        "补齐输入或执行环境后重新运行关键检查"
      );
    } else {
      pass("checks.critical-skipped", "关键检查执行状态", "没有关键检查被跳过");
    }
  }

  if (review.checklist_version !== undefined || review.checklist_results !== undefined || review.checklist_coverage !== undefined) {
    const checks = Array.isArray(review.checklist_results) ? review.checklist_results : [];
    const entries = new Map(catalog.items.map((item) => [item.check_id, item]));
    const valid = review.checklist_version === catalog.version && checks.length === entries.size
      && new Set(checks.map((c) => c?.check_id)).size === entries.size
      && checks.every((c) => c && entries.has(c.check_id) && c.severity === entries.get(c.check_id).severity
        && ["pass", "conflict", "missing", "unverifiable", "not_applicable", "skipped"].includes(c.status));
    if (!valid) block("checklist.structure", "通用审查清单", "CHECKLIST_INVALID", "清单版本、编号、等级或状态不完整", "重新执行当前版本的通用清单检查");
    else pass("checklist.structure", "通用审查清单", `已保存 ${checks.length} 项检查状态`);
    const expected = coverageFrom(checks);
    if (!review.checklist_coverage || !Object.entries(expected).every(([key, value]) => review.checklist_coverage[key] === value)) {
      block("checklist.coverage", "通用清单覆盖统计", "CHECKLIST_COVERAGE_INVALID", "清单覆盖统计缺失或与逐项结果不一致", "重新生成完整清单统计");
    } else pass("checklist.coverage", "通用清单覆盖统计", "通用检查与专项检查分别统计");
    const pending = checks.filter((c) => ["high", "critical"].includes(entries.get(c?.check_id)?.severity)
      && ["unverifiable", "skipped"].includes(c.status) && !validHumanReview(c, review));
    if (pending.length) block("checklist.pending", "关键通用检查复核", "CHECKLIST_REVIEW_REQUIRED", `${pending.length} 项关键检查待核验：${pending.map((c) => c.check_id).join("、")}`, "在通用清单中记录复核结论、复核人、依据与说明");
    else if (valid) pass("checklist.pending", "关键通用检查复核", "没有未处理的关键待核验项");
  }

  const risks = Array.isArray(review.risks) ? review.risks : [];
  if (!Array.isArray(review.risks)) {
    block("output.risks", "风险清单", "RISKS_INVALID", "风险清单结构无效", "重新生成结构化风险结果");
  } else {
    pass("output.risks", "风险清单", `已读取 ${risks.length} 条风险`);
  }

  risks.forEach((risk, index) => {
    const riskId = risk?.risk_id || `risk_${index + 1}`;
    const prefix = `risk.${riskId}`;
    if (!risk || !risk.risk_id || !risk.risk_level || !risk.title || !risk.conclusion_status || !risk.evidence_status || !risk.human_status) {
      block(`${prefix}.required`, "风险必填字段", "REQUIRED_FIELD_MISSING", "风险缺少标识、等级、标题、结论、证据或人工处理状态", "补齐风险必填字段", riskId);
      return;
    }

    if (!ALLOWED_LEVELS.has(risk.risk_level)) {
      block(`${prefix}.level`, "风险等级", "INVALID_RISK_LEVEL", `风险等级 ${risk.risk_level} 不在允许范围内`, "修正风险等级", riskId);
    }
    if (risk.risk_category && !ALLOWED_CATEGORIES.has(risk.risk_category)) {
      block(`${prefix}.category`, "风险类别", "INVALID_RISK_CATEGORY", "风险类别不在固定枚举内", "修正风险类别", riskId);
    }
    if (risk.conclusion_status && !ALLOWED_CONCLUSIONS.has(risk.conclusion_status)) {
      block(`${prefix}.conclusion`, "结论状态", "INVALID_CONCLUSION_STATUS", "结论状态不在允许范围内", "修正结论状态", riskId);
    }
    if (risk.evidence_status && !ALLOWED_EVIDENCE.has(risk.evidence_status)) {
      block(`${prefix}.evidence`, "证据状态", "INVALID_EVIDENCE_STATUS", "证据状态不在允许范围内", "修正证据状态", riskId);
    }
    if (risk.human_status && !ALLOWED_HUMAN.has(risk.human_status)) {
      block(`${prefix}.human`, "人工处理状态", "INVALID_HUMAN_STATUS", "人工处理状态不在允许范围内", "修正人工处理状态", riskId);
    }

    const location = risk.contract_location;
    const highRisk = risk.risk_level === "critical" || risk.risk_level === "high";
    const pageCount = Number(document?.pageCount || document?.page_count || 0);
    const locationVersion = location?.file_version_id;
    if (locationVersion && locationVersion !== fileVersionId) {
      block(`${prefix}.file-version`, "风险文件版本", "LOCATION_VERSION_MISMATCH", "风险定位属于其他合同文件版本", "重新绑定当前合同文件版本后再导出", riskId);
    }
    // 已明确驳回的候选不再作为待确认风险阻断正式报告，但仍需检查身份及结构。
    if (risk.conclusion_status === "rejected" && ["deleted", "false_positive"].includes(risk.human_status)) return;
    const pageValid = Number.isInteger(location?.page) && location.page > 0 && (!pageCount || location.page <= pageCount);
    const anchorValid = (pageValid || validBlockAnchor(location, document)) && !["unresolved", "fallback"].includes(location?.location_status);
    if (!location || locationVersion !== fileVersionId || !anchorValid || !locationHasAnchor(location)) {
      if (highRisk && (!location || !anchorValid)) {
        block(
          `${prefix}.location-unresolved`,
          "高风险合同定位",
          "HIGH_RISK_LOCATION_UNRESOLVED",
          "高风险缺少可验证的物理页码或逻辑块原文锚点",
          "人工核对合同原件并补齐可验证定位",
          riskId
        );
      }
      block(
        `${prefix}.location`,
        "合同定位",
        "LOCATION_INVALID",
        "风险无法回溯到当前合同文件版本的有效页码和原文锚点",
        "补齐文件版本、页码、条款或原文片段",
        riskId
      );
    } else {
      const locationConfidence = Number(risk.location_confidence ?? location.location_confidence);
      if (!Number.isFinite(locationConfidence) || locationConfidence < 0.7) {
        block(
          `${prefix}.location-confidence`,
          "定位置信度",
          "LOCATION_UNVERIFIED",
          "风险定位置信度不足，不能作为已验证结果导出",
          "人工核对页码、条款号和原文片段",
          riskId
        );
      } else {
        checkItem(items, `${prefix}.location`, "合同定位", "passed", null, "风险已绑定合同位置", "", riskId);
      }
    }

    if (highRisk && (!risk.human_status || risk.human_status === "pending_review")) {
      block(
        `${prefix}.human-review`,
        "高风险人工复核",
        "PENDING_HUMAN_REVIEW",
        "高风险仍处于待人工复核状态",
        "接受、修改、误报或延期处理该风险后再生成正式报告",
        riskId
      );
    }
    if (highRisk && risk.evidence_status !== "verified") {
      block(
        `${prefix}.evidence-complete`,
        "高风险证据完整性",
        "EVIDENCE_INCOMPLETE",
        "高风险证据未达到 verified 状态",
        "补齐可追溯依据并重新校验",
        riskId
      );
    }
    if (risk.conclusion_status === "confirmed" && risk.evidence_status === "invalid") {
      block(
        `${prefix}.invalid-evidence`,
        "确认结论依据",
        "INVALID_EVIDENCE",
        "确认结论绑定了无效证据",
        "撤回确认结论或替换有效依据",
        riskId
      );
    }
    if (!highRisk && risk.human_status === "pending_review" && risk.conclusion_status === "confirmed") {
      block(
        `${prefix}.human-status`,
        "人工处理状态",
        "PENDING_HUMAN_REVIEW",
        "该风险仍需要人工处理",
        "完成法务确认后再生成正式报告",
        riskId
      );
    }

    const legalBasis = Array.isArray(risk.legal_basis) ? risk.legal_basis : [];
    legalBasis.forEach((basis, basisIndex) => {
      if (!basis?.source_id || !basis?.title || basis.status === "draft" || basis.status === "invalid") {
        block(
          `${prefix}.legal-basis-${basisIndex}`,
          "法律依据",
          "LEGAL_SOURCE_INVALID",
          "法律依据缺少来源标识、标题或有效状态",
          "绑定已发布且可追溯的法律依据",
          riskId
        );
      }
      if (basis?.snapshot_id && snapshot?.id && basis.snapshot_id !== snapshot.id) {
        block(
          `${prefix}.snapshot-binding-${basisIndex}`,
          "法律依据版本",
          "SNAPSHOT_MISMATCH",
          "法律依据未绑定当前审查法律快照",
          "重新选择与当前审查一致的法律快照",
          riskId
        );
      }
    });
  });

  return result();
}

module.exports = { validateReview, ALLOWED_FORMATS, EXPORT_POLICY_VERSION };
