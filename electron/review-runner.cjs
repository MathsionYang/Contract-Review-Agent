const { buildKnowledgeItem, searchKnowledgeSources } = require("./knowledge.cjs");
const { evaluateDeterministicRules, mergeReviewFindings, normalizeModelRisks } = require("./review-engine.cjs");
const { invokeModel } = require("./model-gateway.cjs");
const { validateReview } = require("./validator.cjs");

function now() {
  return new Date().toISOString();
}

function selectedItems(state, kind, configuredNames) {
  const names = new Set(Array.isArray(configuredNames) ? configuredNames : []);
  return (state?.knowledge?.[kind] || []).filter((item) => item.selected !== false && (!names.size || names.has(item.file)));
}

function firstNumber(value) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) / 100 : null;
}

function rulesFromKnowledge(items = []) {
  const rules = [];
  for (const item of items) {
    if (Array.isArray(item.rules) && item.rules.length) {
      rules.push(...item.rules.map((rule) => ({ ...rule, id: rule.id || `${item.file}:${rule.rule_id || rules.length + 1}`, source_file: item.file })));
      continue;
    }
    for (const clause of item.clauses || []) {
      const clauseText = `${clause.title || ""} ${clause.text || ""}`;
      const threshold = firstNumber(clauseText);
      if (threshold !== null && /预付款|首付款|付款比例/.test(clauseText) && /不得超过|不超过|上限/.test(clauseText)) {
        rules.push({
          id: `${item.file}:${clause.clause_no}`,
          type: "amount_ratio",
          threshold,
          label: clause.title || "付款比例规则",
          clause_no: clause.clause_no,
          risk_level: "high",
          risk_category: "company_policy",
          source_file: item.file
        });
      } else if (clause.text || clause.title) {
        rules.push({
          id: `${item.file}:${clause.clause_no}`,
          type: "keyword",
          keyword: clause.title || clause.text.slice(0, 30),
          label: clause.title || "知识条款匹配",
          clause_no: clause.clause_no,
          risk_level: "medium",
          risk_category: item.source_type === "deterministic_rule" ? "company_policy" : "legal",
          source_file: item.file
        });
      }
    }
    if (!item.clauses?.length) {
      const file = String(item.file || "");
      if (/procurement|采购/i.test(file)) {
        rules.push({ id: `${file}:prepayment-ratio`, type: "amount_ratio", threshold: 0.3, label: "预付款比例上限", risk_level: "high", risk_category: "company_policy", source_file: file });
      } else if (/common|通用/i.test(file)) {
        rules.push({ id: `${file}:signature`, type: "required_clause", keyword: "授权代表签字", label: "授权代表签字条款", risk_level: "high", risk_category: "legal", source_file: file });
      }
    }
  }
  return rules;
}

function attachEvidence(findings, sources) {
  return findings.map((finding) => {
    const query = `${finding.title || ""} ${finding.contract_location?.quote || ""} ${finding.risk_topic || ""}`;
    const hits = searchKnowledgeSources(sources, query, { limit: 6 });
    const legal = hits.filter((hit) => hit.source_type === "legal_snapshot").map((hit) => ({
      source_id: hit.source_id,
      source_level: "l1",
      file_name: hit.file_name,
      clause_no: hit.clause_no,
      clause_title: hit.clause_title,
      title: `${hit.file_name} ${hit.clause_no}`,
      status: "published",
      snapshot_id: hit.snapshot_id,
      excerpt: hit.excerpt
    }));
    const company = hits.filter((hit) => hit.source_type !== "legal_snapshot").map((hit) => ({
      source_id: hit.source_id,
      source_level: hit.source_type === "deterministic_rule" ? "rule" : "l3",
      file_name: hit.file_name,
      clause_no: hit.clause_no,
      clause_title: hit.clause_title,
      title: `${hit.file_name} ${hit.clause_no}`,
      status: "published",
      excerpt: hit.excerpt
    }));
    return {
      ...finding,
      legal_basis: [...(finding.legal_basis || []), ...legal],
      company_basis: [...(finding.company_basis || []), ...company]
    };
  });
}

function executionModel(state, review, role) {
  const snapshotModel = review.config?.execution?.models?.[role];
  if (snapshotModel) {
    const configured = (state?.capabilities?.models || []).find((item) => item.name === snapshotModel.name);
    if (configured && configured.status === "active" && (configured.testStatus === "passed" || configured.testStatus === undefined)) return configured;
    return snapshotModel.testStatus === "passed" ? snapshotModel : null;
  }
  return (state?.capabilities?.models || []).find((item) => (
    item.role === role
    && item.status === "active"
    && (item.testStatus === "passed" || item.testStatus === undefined)
  )) || null;
}

function executionSnapshot(state, review) {
  return review.config?.execution || {
    models: Object.fromEntries(["analysis", "extraction", "embedding", "rerank", "vision"].map((role) => [role, executionModel(state, review, role)])),
    skills: (state?.capabilities?.skills || []).filter((skill) => skill.status === "enabled").map((skill) => ({ name: skill.name, version: skill.version, scope: skill.scope })),
    selectionMode: "active",
    updatedAt: now()
  };
}

function modelMessages(review, evidence) {
  const documentText = String(review.document?.text || "").slice(0, 60000);
  return [
    { role: "system", content: "你是合同审查助手。只返回 JSON 对象（Return only a JSON object），格式为 {\"risks\":[...]}。任何没有明确原文依据的结论必须使用 needs_verification 和 unverified。" },
    { role: "user", content: JSON.stringify({ task: "合同风险审查", contractType: review.project?.contract_type, document: documentText, evidence }, null, 2) }
  ];
}

async function runReview(options = {}) {
  const original = options.review || {};
  const review = JSON.parse(JSON.stringify(original));
  const state = options.state || {};
  const services = options.services || {};
  const errors = [];
  const progress = (step, value, details = {}) => {
    review.task = { ...(review.task || {}), current_step: step, progress: value };
    if (typeof options.onProgress === "function") options.onProgress({ step, progress: value, ...details });
  };

  review.config = { ...(review.config || {}), execution: executionSnapshot(state, review) };
  review.task = {
    ...(review.task || {}),
    status: "running",
    current_step: "rules",
    progress: 10,
    errors: []
  };

  if (!review.project?.file_version_id || !review.document?.text?.trim()) {
    review.task = { ...review.task, status: "failed", current_step: "parse", progress: 100, errors: [{ code: "DOCUMENT_TEXT_UNAVAILABLE", message: "合同解析文本为空" }] };
    return { review, errors: review.task.errors, validation: null };
  }

  progress("rules", 28);
  const ruleItems = selectedItems(state, "rules", review.config.rules);
  const policyItems = selectedItems(state, "policies", review.config.policies);
  const snapshotItem = (state.knowledge?.legalSnapshots || []).find((item) => item.id === review.config.snapshot?.id && item.status === "published");
  const sources = [
    ...policyItems.map((item) => buildKnowledgeItem({ ...item, kind: "policies" })),
    ...(snapshotItem ? [buildKnowledgeItem({ ...snapshotItem, kind: "legalSnapshots", selected: true })] : [])
  ];
  const rules = rulesFromKnowledge(ruleItems);
  const document = { ...review.document, fileVersionId: review.project.file_version_id };
  const ruleFindings = evaluateDeterministicRules(document, rules, { contractType: review.project.contract_type });

  let findings = attachEvidence(ruleFindings, sources);
  const hasRuleEvidence = findings.some((finding) => finding.legal_basis.length || finding.company_basis.length);
  if (hasRuleEvidence) {
    findings = findings.map((finding) => finding.company_basis.length || finding.legal_basis.length ? { ...finding, evidence_status: "verified" } : finding);
  }
  review.risks = mergeReviewFindings(findings);
  progress("retrieve", 52, { riskCount: review.risks.length });

  progress("model", 70, { riskCount: review.risks.length });
  const model = executionModel(state, review, "analysis");
  if (model) {
    const call = services.invokeModel || invokeModel;
    const response = await call({
      model,
      messages: modelMessages(review, sources.map((source) => ({ file_name: source.file_name, clauses: source.clauses }))),
      responseSchema: { type: "object", properties: { risks: { type: "array" } } }
    });
    if (response?.ok) {
      const modelFindings = attachEvidence(normalizeModelRisks(response.data, { fileVersionId: review.project.file_version_id, document }), sources);
      findings = mergeReviewFindings([...findings, ...modelFindings]);
      review.risks = findings;
      progress("model", 78, { riskCount: review.risks.length });
    } else {
      errors.push({ code: response?.errorCode || "MODEL_REQUEST_FAILED", message: response?.message || "模型调用失败" });
    }
  }

  review.risks = mergeReviewFindings(findings);
  progress("validate", 88, { riskCount: review.risks.length });
  review.review_version_id = `RV-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-AUTO-${Date.now().toString(36)}`;
  review.task = {
    ...(review.task || {}),
    status: errors.length ? "partial" : "completed",
    current_step: "persist",
    progress: 100,
    errors
  };
  progress("persist", 100, { riskCount: review.risks.length });
  const validation = review.config?.snapshot?.status === "published" ? validateReview(review, { formats: ["JSON"] }) : null;
  return { review, errors, validation };
}

module.exports = { runReview, rulesFromKnowledge, selectedItems };
