const crypto = require("node:crypto");
const { compact, resolveRefs } = require("./contract-evidence.cjs");
const { canonicalIssueId, canonicalAggregationKey } = require("./risk-grouping.cjs");

const ALLOWED_LEVELS = new Set(["critical", "high", "medium", "low", "info"]);
const ALLOWED_CATEGORIES = new Set(["legal", "commercial", "company_policy", "text_quality", "evidence"]);
const ALLOWED_CONCLUSIONS = new Set(["candidate", "confirmed", "needs_verification", "rejected"]);
const ALLOWED_EVIDENCE = new Set(["verified", "partially_verified", "unverified", "invalid", "not_applicable"]);
const ALLOWED_DECISION_CONFIDENCE = new Set(["high", "medium", "low"]);
const LEVEL_ORDER = ["critical", "high", "medium", "low", "info"];
const CONCLUSION_ORDER = { rejected: 0, needs_verification: 1, candidate: 2, confirmed: 3 };
const EVIDENCE_ORDER = { invalid: 0, unverified: 1, partially_verified: 2, not_applicable: 2, verified: 3 };
const RULE_AGGREGATION_GROUPS = new Map([
  ["penalty.daily_rate_excessive", "penalty.rate-equity"],
  ["penalty.rate_asymmetry", "penalty.rate-equity"],
  ["penalty.stacking", "penalty.stacking-cap"],
  ["penalty.unlimited_delay_cap", "penalty.stacking-cap"]
]);

function hashValue(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 12);
}

function documentPages(document = {}) {
  if (Array.isArray(document.pages) && document.pages.length) return document.pages;
  return [{ page: 1, text: String(document.text || "") }];
}

function normalizeText(value) {
  return compact(String(value || "")).toLowerCase().replace(/[风险问题事项条款约定存在需要建议缺少未发现]/g, "");
}

function clauseNumbersFor(finding = {}) {
  const location = finding.contract_location || {};
  const refs = [
    ...(Array.isArray(location.source_refs) ? location.source_refs : []),
    ...(Array.isArray(finding.evidence_refs) ? finding.evidence_refs : []),
    ...(Array.isArray(finding.contract_locations) ? finding.contract_locations : [])
  ];
  return [...new Set([location.clause_no, ...refs.map((ref) => ref?.clause_no), ...(finding.related_clause_nos || [])]
    .map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeFindingSeverity(input = {}) {
  const finding = { ...input, contract_location: { ...(input.contract_location || {}) } };
  const location = finding.contract_location;
  const refs = [
    ...(Array.isArray(location.source_refs) ? location.source_refs : []),
    ...(Array.isArray(finding.evidence_refs) ? finding.evidence_refs : [])
  ];
  const anchored = location.location_status === "resolved"
    && refs.some((ref) => ref && ref.block_id && ref.block_id !== "unresolved" && String(ref.quote || "").trim());
  const evidenceStrong = finding.evidence_status === "verified" && refs.length > 0;
  const confirmed = finding.conclusion_status === "confirmed";
  const clauses = clauseNumbersFor(finding);
  const crossClause = finding.cross_clause === true || clauses.length > 1;
  const declared = ALLOWED_LEVELS.has(finding.risk_level) ? finding.risk_level : "medium";
  const deterministic = input.preserveDeterministicLevel === true
    || ["deterministic_check", "deterministic_rule"].includes(String(finding.source_type || ""))
    || ["deterministic_check", "deterministic_rule"].includes(String(finding.evidence_origin || ""));
  const deterministicConflict = deterministic
    && anchored
    && evidenceStrong
    && (finding.check_status === "conflict" || finding.conclusion_status === "candidate");
  const preserveDeterministicLevel = input.preserveDeterministicLevel === true || deterministicConflict;
  let capped = declared;
  let reason = "";
  if (!preserveDeterministicLevel && (!anchored || !evidenceStrong || !confirmed)) {
    if (LEVEL_ORDER.indexOf(capped) < LEVEL_ORDER.indexOf("medium")) {
      capped = "medium";
      reason = "缺少原文定位或确认性证据，等级上限为 medium";
    }
  }
  if (crossClause && clauses.length < 2 && LEVEL_ORDER.indexOf(capped) < LEVEL_ORDER.indexOf("medium")) {
    capped = "medium";
    reason = "跨条款风险缺少两条独立条款证据，等级上限为 medium";
  }
  finding.risk_level = capped;
  if (capped !== declared) {
    finding.level_capped_from = finding.level_capped_from || declared;
    finding.level_cap_reason = finding.level_cap_reason || reason;
  }
  finding.location_confidence = anchored ? (evidenceStrong ? 0.94 : 0.6) : 0;
  finding.decision_confidence = ALLOWED_DECISION_CONFIDENCE.has(finding.decision_confidence)
    ? finding.decision_confidence
    : (!anchored || finding.evidence_status === "invalid" ? "low"
      : (evidenceStrong && (deterministicConflict || confirmed) ? "high" : "medium"));
  return finding;
}

function baseFinding(input = {}) {
  const title = String(input.title || "待核验风险");
  const location = input.contract_location || {};
  const level = ALLOWED_LEVELS.has(input.risk_level) ? input.risk_level : "medium";
  const category = ALLOWED_CATEGORIES.has(input.risk_category) ? input.risk_category : "evidence";
  const conclusion = ALLOWED_CONCLUSIONS.has(input.conclusion_status) ? input.conclusion_status : "needs_verification";
  const evidence = ALLOWED_EVIDENCE.has(input.evidence_status) ? input.evidence_status : "unverified";
  const page = Number.isInteger(location.page) && location.page > 0 ? location.page : null;
  const locationConfidence = Number.isFinite(Number(input.location_confidence))
    ? Number(input.location_confidence)
    : Number.isFinite(Number(location.location_confidence))
      ? Number(location.location_confidence)
      : (location.location_status === "unresolved" ? 0 : 0.82);
  return normalizeFindingSeverity({
    risk_id: String(input.risk_id || `risk_${hashValue(`${title}-${page ?? "unresolved"}-${location.clause_no || ""}`)}`),
    source_type: String(input.source_type || "review_engine"),
    evidence_origin: String(input.evidence_origin || input.source_type || "review_engine"),
    rule_id: input.rule_id || undefined,
    related_checks: Array.isArray(input.related_checks) ? input.related_checks : [],
    checklist_ids: Array.isArray(input.checklist_ids) ? input.checklist_ids : [],
    catalog_version: input.catalog_version || undefined,
    risk_level: level,
    decision_confidence: ALLOWED_DECISION_CONFIDENCE.has(input.decision_confidence) ? input.decision_confidence : undefined,
    risk_category: category,
    risk_topic: String(input.risk_topic || "general"),
    title,
    conclusion_status: conclusion,
    evidence_status: evidence,
    check_status: input.check_status || undefined,
    human_status: input.human_status || "pending_review",
    location_confidence: locationConfidence,
    contract_location: {
      ...location,
      file_version_id: String(location.file_version_id || input.file_version_id || ""),
      page,
      clause_no: String(location.clause_no || ""),
      quote: String(location.quote || ""),
      location_status: String(location.location_status || (page ? "resolved" : "unresolved"))
    },
    analysis: String(input.analysis || "当前结果需要结合合同原文和知识依据进行人工核验。"),
    suggestion: String(input.suggestion || "建议补充依据并完成人工复核后再确认结论。"),
    legal_basis: Array.isArray(input.legal_basis) ? input.legal_basis : [],
    company_basis: Array.isArray(input.company_basis) ? input.company_basis : [],
    aggregation_key: input.aggregation_key || input.risk_group || undefined,
    canonical_issue_id: input.canonical_issue_id || canonicalIssueId(input) || undefined,
    related_risk_ids: Array.isArray(input.related_risk_ids) ? input.related_risk_ids : [],
    related_rule_ids: Array.isArray(input.related_rule_ids) ? input.related_rule_ids : [],
    related_clause_nos: Array.isArray(input.related_clause_nos) ? input.related_clause_nos : [],
    evidence_refs: Array.isArray(input.evidence_refs) ? input.evidence_refs : [],
    cross_clause: input.cross_clause === true
  });
}

function locationFor(document, query, fileVersionId, clauseNo, charRange, blockId) {
  let refs = resolveRefs(document, query, clauseNo);
  // A model clause number is only a hint. If it conflicts with a unique
  // quoted range, retry the quote without that hint; repeated quotes remain
  // unresolved instead of selecting the first occurrence.
  if (!refs.length && query && clauseNo) refs = resolveRefs(document, query, "");
  if (Array.isArray(charRange) && charRange.length === 2) {
    refs = refs.filter((ref) => (!blockId || ref.block_id === blockId)
      && Array.isArray(ref.char_range)
      && ref.char_range[0] === Number(charRange[0])
      && ref.char_range[1] === Number(charRange[1]));
  }
  const matchingClause = clauseNo ? refs.filter((ref) => ref.clause_no === clauseNo) : [];
  const candidates = matchingClause.length ? matchingClause : refs;
  const found = candidates.length === 1 ? candidates[0] : null;
  return {
    file_version_id: fileVersionId || document.fileVersionId || "",
    ...(found || {}),
      page: found?.page ?? null,
      clause_no: found?.clause_no || "",
      quote: found?.quote || "",
      char_range: found?.char_range || null,
    source_refs: found ? [found] : [],
    location_status: found ? "resolved" : "unresolved",
    location_confidence: found ? 0.92 : 0
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
  const content = typeof payload === "string" ? payload : payload?.content ?? payload?.output ?? payload?.data ?? payload;
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
    const charRange = requestedLocation.char_range || requestedLocation.charRange || item.char_range;
    const blockId = requestedLocation.block_id || requestedLocation.blockId || item.block_id;
    const clauseNo = requestedLocation.clause_no || requestedLocation.clauseNo || "";
    const location = locationFor(
      context.document || {},
      quote,
      context.fileVersionId,
      quote || (Array.isArray(charRange) && charRange.length === 2 && blockId) ? clauseNo : "",
      charRange,
      blockId
    );
    return baseFinding({
      ...item,
      risk_id: item.risk_id || `model_${index + 1 + (context.indexOffset || 0)}_${hashValue(item.title || index)}`,
      source_type: "model_analysis",
      evidence_origin: "model_analysis",
      conclusion_status: "needs_verification",
      evidence_status: "unverified",
      location_confidence: location.location_confidence,
      human_status: "pending_review",
      contract_location: location,
      aggregation_key: item.aggregation_key || item.risk_group,
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

function riskAggregationKey(finding = {}) {
  const location = finding.contract_location || {};
  const version = location.file_version_id || finding.file_version_id || "";
  const canonicalKey = canonicalAggregationKey(finding);
  if (canonicalKey) return canonicalKey;
  const explicit = finding.aggregation_key || finding.risk_group;
  if (explicit) return `${version}|group:${String(explicit).toLowerCase()}`;
  if (finding.rule_id) {
    const group = RULE_AGGREGATION_GROUPS.get(String(finding.rule_id));
    if (group) return `${version}|group:${group}`;
    return `${version}|rule:${String(finding.rule_id).toLowerCase()}`;
  }
  const related = [...new Set([...(finding.related_checks || []), ...(finding.checklist_ids || [])].filter(Boolean))].sort();
  if (related.length) return `${version}|checks:${related.join(",")}`;
  const clauses = clauseNumbersFor(finding).sort().join(",");
  return `${version}|topic:${String(finding.risk_topic || "general").toLowerCase()}|title:${normalizeText(finding.title)}|clauses:${clauses}`;
}

function mergeRefs(existing = [], incoming = []) {
  const all = [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])];
  const seen = new Set();
  return all.filter((ref) => {
    const key = `${ref?.block_id || ""}|${ref?.page ?? ""}|${ref?.clause_no || ""}|${ref?.quote || ""}|${(ref?.char_range || []).join("-")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(ref);
  });
}

function mergeLocations(existing, incoming) {
  const left = existing || {};
  const right = incoming || {};
  const refs = mergeRefs(left.source_refs, right.source_refs);
  const leftResolved = left.location_status === "resolved" && refs.some((ref) => ref.block_id !== "unresolved");
  const rightResolved = right.location_status === "resolved" && (right.source_refs || []).some((ref) => ref.block_id !== "unresolved");
  const primary = !leftResolved && rightResolved ? right : left;
  const clauses = [...new Set([left.clause_no, right.clause_no, ...refs.map((ref) => ref.clause_no)].filter(Boolean))];
  return {
    ...primary,
    source_refs: refs,
    location_status: leftResolved || rightResolved ? "resolved" : "unresolved",
    page: primary.page ?? null,
    quote: String(primary.quote || ""),
    related_clause_nos: clauses
  };
}

function mergeReviewFindings(findings = []) {
  const merged = [];
  for (const raw of findings) {
    const next = baseFinding(raw);
    const key = riskAggregationKey(next);
    const existing = merged.find((item) => riskAggregationKey(item) === key);
    if (!existing) {
      merged.push(next);
      continue;
    }
    existing.legal_basis = mergeBasis(existing.legal_basis, next.legal_basis);
    existing.company_basis = mergeBasis(existing.company_basis, next.company_basis);
    existing.checklist_ids = [...new Set([...existing.checklist_ids, ...next.checklist_ids])];
    existing.related_checks = [...new Set([...existing.related_checks, ...next.related_checks])];
    existing.contract_location = mergeLocations(existing.contract_location, next.contract_location);
    existing.evidence_refs = mergeRefs(existing.evidence_refs, next.evidence_refs);
    existing.related_risk_ids = [...new Set([
      ...(existing.related_risk_ids || []),
      ...(next.related_risk_ids || []),
      ...(next.risk_id && next.risk_id !== existing.risk_id ? [next.risk_id] : [])
    ])];
    existing.related_rule_ids = [...new Set([
      ...(existing.related_rule_ids || []),
      ...(next.related_rule_ids || []),
      ...(next.rule_id && next.rule_id !== existing.rule_id ? [next.rule_id] : [])
    ])];
    existing.related_clause_nos = [...new Set([
      ...(existing.related_clause_nos || []),
      ...(next.related_clause_nos || []),
      ...clauseNumbersFor(existing), ...clauseNumbersFor(next)
    ])];
    if ((EVIDENCE_ORDER[next.evidence_status] || 0) > (EVIDENCE_ORDER[existing.evidence_status] || 0)) existing.evidence_status = next.evidence_status;
    if ((CONCLUSION_ORDER[next.conclusion_status] || 0) > (CONCLUSION_ORDER[existing.conclusion_status] || 0)) existing.conclusion_status = next.conclusion_status;
    if ((LEVEL_ORDER.indexOf(next.risk_level) >= 0) && (LEVEL_ORDER.indexOf(existing.risk_level) < 0 || LEVEL_ORDER.indexOf(next.risk_level) < LEVEL_ORDER.indexOf(existing.risk_level))) existing.risk_level = next.risk_level;
    existing.evidence_origin = [...new Set(`${existing.evidence_origin},${next.evidence_origin}`.split(",").filter(Boolean))].join(",");
    existing.cross_clause = existing.cross_clause || next.cross_clause || existing.related_clause_nos.length > 1;
    normalizeFindingSeverity(existing);
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
  canonicalIssueId,
  canonicalAggregationKey,
  buildReviewTaskResult,
  evaluateDeterministicRules,
  mergeReviewFindings,
  normalizeModelRisks,
  normalizeFindingSeverity,
  riskAggregationKey,
  RULE_AGGREGATION_GROUPS
};
