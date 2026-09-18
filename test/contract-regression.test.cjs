"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { getContractProfile, evaluateApplicability } = require("../electron/contract-profiles.cjs");
const { createContractDocument, loadBaselineCase } = require("./fixtures/contract-regression-fixtures.cjs");
const { runContractRegression, runAllContractRegressions } = require("./fixtures/contract-regression-runner.cjs");

const PROFILES = ["procurement", "software", "service", "lease", "unknown"];

test("所有合同 profile 通过统一接口返回独立规则包和主题别名", () => {
  for (const profile of PROFILES) {
    const selected = getContractProfile(profile);
    assert.equal(selected.profile, profile);
    assert.equal(selected.contract_type, profile);
    assert.match(selected.rule_pack_version, /\.v\d+$/);
    assert.ok(selected.applicabilityRules.length > 0);
    assert.ok(Object.keys(selected.topicAliases).length > 0);
  }
  assert.equal(getContractProfile("not-a-profile").profile, "unknown");
});

test("不同合同类型使用各自夹具，但共享文档和证据接口", () => {
  for (const profile of PROFILES) {
    const { document, expectations } = createContractDocument(profile);
    assert.equal(document.profile, profile);
    assert.ok(document.text.length > 0);
    assert.ok(document.blocks.length >= 4);
    assert.equal(document.blocks.map((block) => document.text.slice(...block.char_range)).join("\n"), document.text);
    assert.equal(document.blocks[0].block_id, expectations.validEvidenceRef.block_id);
    assert.equal(expectations.validEvidenceRef.quote, document.blocks[0].text);
    assert.ok(expectations.penaltyFacts.every((fact) => fact.source_refs.length > 0));
    const applicability = evaluateApplicability(profile, { document, facts: expectations.penaltyFacts });
    assert.equal(applicability.status, "applicable", profile);
  }
});

test("空文档和未知合同类型不会伪造专项适用性", () => {
  assert.equal(evaluateApplicability("software", { document: {}, facts: [] }).status, "unverifiable");
  assert.equal(evaluateApplicability("software", { document: { text: "普通货物交付" }, facts: [] }).status, "not_applicable");
  assert.equal(evaluateApplicability("unknown", { document: { text: "任意合同文本" }, facts: [] }).status, "applicable");
});

test("基准清单可按 case_id 加载，不依赖外部合同路径", () => {
  for (const caseId of ["procurement_core_terms", "software_delivery_and_data", "service_sla_and_personnel", "lease_possession_and_return", "unknown_generic_obligations"]) {
    const loaded = loadBaselineCase(caseId);
    assert.equal(loaded.baseline.case_id, caseId);
    assert.equal(loaded.baseline.profile, loaded.document.profile);
    assert.ok(loaded.baseline.issue_id);
    assert.ok(loaded.baseline.expected_topics.length >= 3);
    assert.ok(loaded.baseline.expected_clause_patterns.length >= 2);
  }
});

test("端到端回归按 profile 输出统一质量指标", () => {
  const result = runContractRegression("procurement", { caseId: "procurement_core_terms" });
  for (const key of ["baselineRecall", "highImpactRecall", "severityFloorViolationRate", "evidenceBindingRate", "shortQuoteMisbindRate", "locationResolutionRate", "duplicateMergeRate", "notApplicableFalsePositiveRate"]) {
    assert.equal(typeof result[key], "number", key);
  }
  const all = runAllContractRegressions();
  assert.deepEqual(Object.keys(all.byProfile).sort(), ["lease", "procurement", "service", "software"]);
  assert.ok(Array.isArray(all.gateFailures));
});

test("带引号的数字条款号可被索引，缺失引用不会误报为已解决", () => {
  const { buildClauseRegistry, extractReferenceEdges } = require("../electron/clause-registry.cjs");
  const text = "1.1 \"定义\" 本合同标的。\n2.1 交付应依据第 1.1 条和第 9.9 条执行。";
  const document = { text, blocks: [{ block_id: "quoted_1", page: 1, logical_page: 1, text }] };
  const registry = buildClauseRegistry(document);
  assert.ok(registry.entries.some((entry) => entry.clause_no === "1.1"));
  assert.ok(!registry.entries.some((entry) => entry.clause_no === "2026.09"));
  const edges = extractReferenceEdges(document);
  assert.equal(edges.find((edge) => edge.target_clause_no === "1.1").target_exists, true);
  assert.equal(edges.find((edge) => edge.target_clause_no === "9.9").target_exists, false);
});

test("重复短引文只绑定声明条款，不跨条款串联", () => {
  const { sourceRefs } = require("../electron/contract-facts.cjs");
  const blocks = [
    { block_id: "short_1", page: 1, clause_no: "1.1", text: "1.1 服务应及时验收。" },
    { block_id: "short_2", page: 2, clause_no: "2.1", text: "2.1 如未及时验收，应书面说明。" },
    { block_id: "short_3", page: 3, clause_no: "3.1", text: "3.1 及时验收后进入保修期。" }
  ];
  const scoped = sourceRefs(blocks, "及时验收", { clauseNo: "1.1" });
  assert.equal(scoped.status, "verified");
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].clause_no, "1.1");

  const ambiguous = sourceRefs(blocks, "及时验收");
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.length, 0);
  assert.equal(ambiguous.candidates.length, 3);
});

test("P0 确定性冲突保留 critical/high，不因待复核状态降级", () => {
  const { normalizeFindingSeverity } = require("../electron/review-engine.cjs");
  const finding = normalizeFindingSeverity({
    source_type: "deterministic_check",
    evidence_origin: "deterministic_rule",
    check_status: "conflict",
    risk_level: "critical",
    conclusion_status: "candidate",
    evidence_status: "verified",
    contract_location: {
      location_status: "resolved",
      source_refs: [{ block_id: "p0_block", page: 1, clause_no: "8.1", quote: "累计责任上限" }]
    }
  });
  assert.equal(finding.risk_level, "critical");
  assert.equal(finding.decision_confidence, "high");
});

test("金额、税务、争议和验收风险按 canonical issue group 聚合", () => {
  const { mergeReviewFindings } = require("../electron/review-engine.cjs");
  const ref = (clauseNo, quote) => ({ block_id: `block_${clauseNo}`, page: 1, clause_no: clauseNo, quote, char_range: [0, quote.length] });
  const finding = (riskId, riskTopic, clauseNo, quote, extra = {}) => ({
    risk_id: riskId,
    risk_topic: riskTopic,
    title: `${riskTopic}-${riskId}`,
    risk_level: "high",
    conclusion_status: "candidate",
    evidence_status: "verified",
    contract_location: { file_version_id: "canonical_v1", clause_no: clauseNo, quote, location_status: "resolved", source_refs: [ref(clauseNo, quote)] },
    ...extra
  });
  const merged = mergeReviewFindings([
    finding("amount-1", "amount_consistency", "2.1", "合同总价"),
    finding("amount-2", "amount_consistency", "2.2", "明细合计", { rule_id: "amount.item_sum" }),
    finding("tax-1", "tax_compliance", "3.1", "税率"),
    finding("dispute-1", "dispute_resolution", "10.1", "争议解决"),
    finding("accept-1", "acceptance_quality", "4.2", "验收标准")
  ]);

  assert.equal(merged.length, 4);
  const amount = merged.find((item) => item.canonical_issue_id === "amount_consistency");
  assert.ok(amount);
  assert.ok(amount.related_risk_ids.includes("amount-2"));
  assert.deepEqual(amount.related_clause_nos.sort(), ["2.1", "2.2"]);
  assert.equal(amount.contract_location.source_refs.length, 2);
  assert.deepEqual(new Set(merged.map((item) => item.canonical_issue_id)), new Set([
    "amount_consistency", "tax_compliance", "dispute_resolution", "acceptance_quality"
  ]));
});
