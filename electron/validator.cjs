const ALLOWED_LEVELS = new Set(["critical", "high", "medium", "low", "info"]);
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

function containsSensitiveValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  return /(?:sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{20,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/.test(text);
}

function validateReview(review, options = {}) {
  const items = [];
  const blockingCodes = [];
  const block = (id, label, code, message, suggestion, riskId) => {
    if (!blockingCodes.includes(code)) blockingCodes.push(code);
    checkItem(items, id, label, "failed", code, message, suggestion, riskId);
  };
  const pass = (id, label, message) => checkItem(items, id, label, "passed", null, message);

  if (!review || typeof review !== "object") {
    block("input.review", "审查结果", "REVIEW_MISSING", "未提供审查结果", "请重新加载当前审查版本");
    return { canExport: false, items, blockingCodes };
  }

  const project = review.project;
  const document = review.document;
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
      "接入 OCR 并保存页码与坐标映射后再导出"
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
  } else {
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
    const pageCount = Number(document?.pageCount || document?.page_count || 0);
    const locationVersion = location?.file_version_id;
    const pageValid = Number.isInteger(location?.page) && location.page > 0 && (!pageCount || location.page <= pageCount);
    if (!location || locationVersion !== fileVersionId || !pageValid || !locationHasAnchor(location)) {
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

    const highRisk = risk.risk_level === "critical" || risk.risk_level === "high";
    if (highRisk && (!risk.human_status || risk.human_status === "pending_review")) {
      block(
        `${prefix}.human-review`,
        "高风险人工复核",
        "PENDING_HUMAN_REVIEW",
        "高风险仍处于待人工复核状态",
        "接受、修改、误报或延期处理该风险后再导出",
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
    if (risk.human_status === "pending_review" && (highRisk || risk.conclusion_status === "confirmed")) {
      block(
        `${prefix}.human-status`,
        "人工处理状态",
        "PENDING_HUMAN_REVIEW",
        "该风险仍需要人工处理",
        "完成法务确认后再导出",
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

  return { canExport: blockingCodes.length === 0, items, blockingCodes };
}

module.exports = { validateReview, ALLOWED_FORMATS };
