const crypto = require("node:crypto");

const ALLOWED_LEVELS = new Set(["critical", "high", "medium", "low", "info"]);
const ALLOWED_CATEGORIES = new Set(["legal", "commercial", "company_policy", "text_quality", "evidence"]);
const ALLOWED_CONCLUSIONS = new Set(["candidate", "confirmed", "needs_verification", "rejected"]);
const ALLOWED_EVIDENCE = new Set(["verified", "partially_verified", "unverified", "invalid", "not_applicable"]);

function hashValue(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 12);
}

function documentPages(document = {}) {
  if (Array.isArray(document.pages) && document.pages.length) return document.pages;
  return [{ page: 1, text: String(document.text || "") }];
}

function findQuote(document, query) {
  const pages = documentPages(document);
  const needle = String(query || "").trim();
  if (needle) {
    const found = pages.find((page) => String(page.text || "").includes(needle));
    if (found) return { page: Number(found.page) || 1, quote: needle };
  }
  const first = pages.find((page) => String(page.text || "").trim());
  return first ? { page: Number(first.page) || 1, quote: String(first.text).trim().slice(0, 180) } : { page: 1, quote: "" };
}

function inferClause(text, index = 0) {
  const before = String(text || "").slice(0, Math.max(0, index));
  const matches = before.match(/(?:第\s*[一二三四五六七八九十百\d]+\s*条|\b\d+(?:\.\d+)+)/g);
  return matches?.at(-1)?.replace(/\s+/g, "") || "";
}

function baseFinding(input = {}) {
  const title = String(input.title || "待核验风险");
  const location = input.contract_location || {};
  const level = ALLOWED_LEVELS.has(input.risk_level) ? input.risk_level : "medium";
  const category = ALLOWED_CATEGORIES.has(input.risk_category) ? input.risk_category : "evidence";
  const conclusion = ALLOWED_CONCLUSIONS.has(input.conclusion_status) ? input.conclusion_status : "needs_verification";
  const evidence = ALLOWED_EVIDENCE.has(input.evidence_status) ? input.evidence_status : "unverified";
  return {
    risk_id: String(input.risk_id || `risk_${hashValue(`${title}-${location.page || 1}-${location.clause_no || ""}`)}`),
    source_type: String(input.source_type || "review_engine"),
    evidence_origin: String(input.evidence_origin || input.source_type || "review_engine"),
    rule_id: input.rule_id || undefined,
    risk_level: level,
    risk_category: category,
    risk_topic: String(input.risk_topic || "general"),
    title,
    conclusion_status: conclusion,
    evidence_status: evidence,
    human_status: input.human_status || "pending_review",
    location_confidence: Number.isFinite(Number(input.location_confidence)) ? Number(input.location_confidence) : 0.82,
    contract_location: {
      file_version_id: String(location.file_version_id || input.file_version_id || ""),
      page: Number(location.page || 1),
      clause_no: String(location.clause_no || ""),
      quote: String(location.quote || "")
    },
    analysis: String(input.analysis || "当前结果需要结合合同原文和知识依据进行人工核验。"),
    suggestion: String(input.suggestion || "建议补充依据并完成人工复核后再确认结论。"),
    legal_basis: Array.isArray(input.legal_basis) ? input.legal_basis : [],
    company_basis: Array.isArray(input.company_basis) ? input.company_basis : []
  };
}

function locationFor(document, query, fileVersionId, clauseNo) {
  const found = findQuote(document, query);
  const pageText = documentPages(document).find((page) => Number(page.page) === found.page)?.text || "";
  const index = query ? pageText.indexOf(query) : 0;
  return {
    file_version_id: fileVersionId || document.fileVersionId || "",
    page: found.page,
    clause_no: clauseNo || inferClause(pageText, index),
    quote: found.quote
  };
}

function makeRuleFinding(rule, document, input, overrides = {}) {
  return baseFinding({
    source_type: "deterministic_rule",
    evidence_origin: "deterministic_rule",
    rule_id: rule.id || rule.rule_id || rule.file,
    risk_level: rule.risk_level || rule.riskLevel || "medium",
    risk_category: rule.risk_category || rule.riskCategory || "company_policy",
    risk_topic: rule.risk_topic || rule.topic || rule.type || "rule",
    title: rule.title || rule.label || `规则 ${rule.id || rule.file || "未命名"}`,
    contract_location: locationFor(document, overrides.quote || input.quote || "", input.fileVersionId || document.fileVersionId, overrides.clause_no || rule.clause_no),
    ...overrides,
    analysis: overrides.analysis || `确定性规则 ${rule.id || rule.file || "未命名"} 已完成本地判断。`,
    suggestion: overrides.suggestion || "请根据规则证据确认是否需要调整合同条款。"
  });
}

function evaluateDeterministicRules(document = {}, rules = [], options = {}) {
  const text = String(document.text || documentPages(document).map((page) => page.text || "").join("\n"));
  const findings = [];
  for (const rule of rules || []) {
    const type = rule.type || rule.rule_type || "keyword";
    if (type === "amount_ratio") {
      const pattern = rule.pattern instanceof RegExp ? rule.pattern : /(?:预付款|首付款|付款比例)[^。；;，,]{0,24}?(\d+(?:\.\d+)?)\s*%/i;
      const match = text.match(pattern);
      if (!match) {
        findings.push(makeRuleFinding(rule, document, { fileVersionId: document.fileVersionId }, {
          conclusion_status: "needs_verification",
          evidence_status: "unverified",
          analysis: "未能从当前合同文本抽取该规则需要的付款比例，不能直接判断。"
        }));
        continue;
      }
      const ratio = Number(match[1]) / 100;
      const threshold = Number(rule.threshold);
      const violated = Number.isFinite(threshold) && ratio > threshold;
      findings.push(makeRuleFinding(rule, document, { fileVersionId: document.fileVersionId }, {
        quote: match[0],
        conclusion_status: violated ? "candidate" : "rejected",
        evidence_status: "verified",
        analysis: violated ? `抽取到付款比例 ${(ratio * 100).toFixed(2)}%，超过规则阈值 ${(threshold * 100).toFixed(2)}%。` : `抽取到付款比例 ${(ratio * 100).toFixed(2)}%，未超过规则阈值。`,
        suggestion: violated ? "建议补充例外审批依据或调整付款比例。" : "当前规则未发现比例超限。"
      }));
      continue;
    }
    if (type === "required_clause") {
      const keyword = String(rule.keyword || "").trim();
      const exists = Boolean(keyword && text.includes(keyword));
      findings.push(makeRuleFinding(rule, document, { fileVersionId: document.fileVersionId }, {
        quote: exists ? keyword : "",
        conclusion_status: exists ? "rejected" : "candidate",
        evidence_status: exists ? "verified" : "unverified",
        risk_level: rule.risk_level || (exists ? "low" : "high"),
        analysis: exists ? `合同正文包含必需条款“${keyword}”。` : `合同正文未找到必需条款“${keyword}”。`,
        suggestion: exists ? "当前未发现该必需条款缺失。" : `建议补充“${keyword}”并完成人工核验。`
      }));
      continue;
    }
    if (type === "date_order") {
      const from = String(rule.from || "").trim();
      const to = String(rule.to || "").trim();
      const fromIndex = text.indexOf(from);
      const toIndex = text.indexOf(to);
      const comparable = fromIndex >= 0 && toIndex >= 0;
      findings.push(makeRuleFinding(rule, document, { fileVersionId: document.fileVersionId }, {
        quote: comparable ? `${from} ${to}` : "",
        conclusion_status: comparable ? (fromIndex <= toIndex ? "rejected" : "candidate") : "needs_verification",
        evidence_status: comparable ? "verified" : "unverified",
        analysis: comparable ? `已定位“${from}”和“${to}”的文本位置，需结合具体日期值判断顺序。` : `缺少“${from}”或“${to}”输入，无法执行日期顺序判断。`
      }));
      continue;
    }
    const keyword = String(rule.keyword || rule.term || "").trim();
    const exists = Boolean(keyword && text.includes(keyword));
    findings.push(makeRuleFinding(rule, document, { fileVersionId: document.fileVersionId }, {
      quote: exists ? keyword : "",
      conclusion_status: exists ? "candidate" : "needs_verification",
      evidence_status: exists ? "verified" : "unverified"
    }));
  }
  return findings;
}

function parseModelContent(payload) {
  const content = typeof payload === "string" ? payload : payload?.content ?? payload?.output ?? payload?.data;
  if (Array.isArray(content)) return content;
  if (content && typeof content === "object") return Array.isArray(content.risks) ? content.risks : [content];
  if (typeof content !== "string") return null;
  const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed.risks) ? parsed.risks : [parsed]);
  } catch (_error) {
    return null;
  }
}

function normalizeModelRisks(payload, context = {}) {
  const parsed = parseModelContent(payload);
  if (!parsed) {
    return [baseFinding({
      risk_id: "model_unverified",
      source_type: "model_analysis",
      evidence_origin: "model_analysis",
      title: "模型输出无法解析，需人工核验",
      conclusion_status: "needs_verification",
      evidence_status: "unverified",
      risk_category: "evidence",
      contract_location: locationFor(context.document || {}, "", context.fileVersionId),
      analysis: "模型返回内容不符合结构化风险格式，系统未将其作为确认结论。",
      suggestion: "请检查模型配置或改用人工审查。"
    })];
  }
  return parsed.filter((item) => item && typeof item === "object").map((item, index) => {
    const requestedLocation = item.contract_location || item.contractLocation || {};
    const quote = requestedLocation.quote || item.quote || "";
    const location = locationFor(context.document || {}, quote, context.fileVersionId, requestedLocation.clause_no || requestedLocation.clauseNo);
    return baseFinding({
      ...item,
      risk_id: item.risk_id || `model_${index + 1}_${hashValue(item.title || index)}`,
      source_type: "model_analysis",
      evidence_origin: "model_analysis",
      conclusion_status: item.conclusion_status === "confirmed" && item.evidence_status === "verified" ? "candidate" : item.conclusion_status,
      evidence_status: item.evidence_status || "unverified",
      human_status: "pending_review",
      contract_location: location,
      file_version_id: context.fileVersionId
    });
  });
}

function mergeBasis(existing = [], incoming = []) {
  const all = [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])];
  const seen = new Set();
  return all.filter((basis) => {
    const key = `${basis.source_id || basis.file_name || ""}|${basis.clause_no || ""}|${basis.excerpt || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameFinding(left, right) {
  const leftLocation = left.contract_location || {};
  const rightLocation = right.contract_location || {};
  const leftKey = `${leftLocation.page || ""}|${leftLocation.clause_no || ""}|${left.title || ""}`.toLowerCase();
  const rightKey = `${rightLocation.page || ""}|${rightLocation.clause_no || ""}|${right.title || ""}`.toLowerCase();
  return leftKey === rightKey || (left.title && right.title && left.title === right.title);
}

function mergeReviewFindings(findings = []) {
  const merged = [];
  for (const raw of findings) {
    const next = baseFinding(raw);
    const existing = merged.find((item) => sameFinding(item, next));
    if (!existing) {
      merged.push(next);
      continue;
    }
    existing.legal_basis = mergeBasis(existing.legal_basis, next.legal_basis);
    existing.company_basis = mergeBasis(existing.company_basis, next.company_basis);
    if (next.evidence_status === "verified") existing.evidence_status = "verified";
    if (existing.conclusion_status === "needs_verification" && next.conclusion_status) existing.conclusion_status = next.conclusion_status;
    existing.evidence_origin = `${existing.evidence_origin},${next.evidence_origin}`;
  }
  return merged;
}

function buildReviewTaskResult(input = {}) {
  return {
    ...(input.review || {}),
    risks: Array.isArray(input.risks) ? input.risks : [],
    task: {
      ...(input.review?.task || {}),
      ...(input.task || {})
    }
  };
}

module.exports = {
  ALLOWED_CATEGORIES,
  ALLOWED_CONCLUSIONS,
  ALLOWED_EVIDENCE,
  ALLOWED_LEVELS,
  buildReviewTaskResult,
  evaluateDeterministicRules,
  mergeReviewFindings,
  normalizeModelRisks
};
