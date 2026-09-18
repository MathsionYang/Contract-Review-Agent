const test = require("node:test");
const assert = require("node:assert/strict");

const {
  compact,
  resolveRefs,
  resolveClauseRefs,
  extractClauseReferences
} = require("../electron/contract-evidence.cjs");
const {
  mergeReviewFindings,
  normalizeFindingSeverity,
  normalizeModelRisks
} = require("../electron/review-engine.cjs");
const { runContractChecks } = require("../electron/contract-checks.cjs");

const document = {
  fileVersionId: "v1",
  text: "7.5 交付条款依据第 9.1 条执行。\n8.1 逾期按合同总价的万分之五支付。",
  pages: [{ page: 1, text: "7.5 交付条款依据第 9.1 条执行。\n8.1 逾期按合同总价的万分之五支付。" }],
  blocks: [{
    block_id: "b1", page: 1, logical_page: 1,
    text: "7.5 交付条款依据第 9.1 条执行。\n8.1 逾期按合同总价的万分之五支付。"
  }]
};

test("条款号查询可以绑定真实条款原文，而不是只在有引文时定位", () => {
  const refs = resolveClauseRefs(document, "7.5");
  assert.equal(refs.length, 1);
  assert.equal(refs[0].clause_no, "7.5");
  assert.match(refs[0].quote, /7\.5.*交付条款/);
  assert.equal(document.blocks[0].text.slice(...refs[0].char_range), refs[0].quote);
  assert.deepEqual(resolveRefs(document, "", "7.5"), refs);
});

test("模型只返回条款号时仍需原文引文，提供偏移时校验到同一原文范围", () => {
  const [clauseOnly] = normalizeModelRisks({ risks: [{ title: "交付风险", contract_location: { clause_no: "7.5" } }] }, { document, fileVersionId: "v1" });
  assert.equal(clauseOnly.contract_location.location_status, "unresolved");
  assert.equal(clauseOnly.contract_location.quote, "");
  const ref = resolveClauseRefs(document, "8.1")[0];
  const [withRange] = normalizeModelRisks({ risks: [{ title: "费率风险", contract_location: {
    clause_no: "8.1", block_id: "b1", char_range: ref.char_range
  } }] }, { document, fileVersionId: "v1" });
  assert.equal(withRange.contract_location.location_status, "resolved");
  assert.deepEqual(withRange.contract_location.char_range, ref.char_range);
});

test("跨条款引用解析保留来源条款和目标条款", () => {
  const edges = extractClauseReferences(document.text);
  assert.ok(edges.some((edge) => edge.from_clause_no === "7.5" && edge.target_clause_no === "9.1"));
});

test("显式风险组把同一跨条款风险合并并保留全部条款证据", () => {
  const merged = mergeReviewFindings([
    {
      risk_id: "r-1", aggregation_key: "penalty-delay-remedy",
      risk_topic: "breach_liability", title: "逾期违约金叠加",
      risk_level: "high", conclusion_status: "candidate", evidence_status: "verified",
      contract_location: {
        file_version_id: "v1", page: 1, clause_no: "8.3", quote: "另按合同总价的10%",
        location_status: "resolved", source_refs: [{ block_id: "b1", page: 1, clause_no: "8.3", quote: "另按合同总价的10%" }]
      }
    },
    {
      risk_id: "r-2", aggregation_key: "penalty-delay-remedy",
      risk_topic: "breach_liability", title: "逾期违约金缺少累计上限",
      risk_level: "high", conclusion_status: "candidate", evidence_status: "verified",
      contract_location: {
        file_version_id: "v1", page: 1, clause_no: "8.1", quote: "每逾期一日",
        location_status: "resolved", source_refs: [{ block_id: "b1", page: 1, clause_no: "8.1", quote: "每逾期一日" }]
      }
    }
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].risk_id, "r-1");
  assert.deepEqual(merged[0].related_risk_ids, ["r-2"]);
  assert.deepEqual(merged[0].related_clause_nos.sort(), ["8.1", "8.3"]);
  assert.equal(merged[0].contract_location.source_refs.length, 2);
});

test("违约金费率与对称性使用同一规则组聚合，叠加计罚保持独立", () => {
  const ref = (clauseNo, quote) => ({ block_id: "b1", page: 1, clause_no: clauseNo, quote });
  const merged = mergeReviewFindings([
    {
      risk_id: "rate-1", rule_id: "penalty.daily_rate_excessive", risk_topic: "breach_liability", title: "日费率过高",
      risk_level: "high", contract_location: { file_version_id: "v1", clause_no: "8.1", quote: "万分之五", location_status: "resolved", source_refs: [ref("8.1", "万分之五")] }
    },
    {
      risk_id: "rate-2", rule_id: "penalty.rate_asymmetry", risk_topic: "breach_liability", title: "双方费率不对称",
      risk_level: "high", contract_location: { file_version_id: "v1", clause_no: "8.2", quote: "万分之一", location_status: "resolved", source_refs: [ref("8.2", "万分之一")] }
    },
    {
      risk_id: "stack-1", rule_id: "penalty.stacking", risk_topic: "breach_liability", title: "逾期违约金叠加",
      risk_level: "critical", contract_location: { file_version_id: "v1", clause_no: "8.3", quote: "另按", location_status: "resolved", source_refs: [ref("8.3", "另按")] }
    }
  ]);
  assert.equal(merged.length, 2);
  const rate = merged.find((risk) => risk.rule_id === "penalty.daily_rate_excessive");
  assert.deepEqual(rate.related_clause_nos.sort(), ["8.1", "8.2"]);
  assert.ok(rate.related_risk_ids.includes("rate-2"));
  assert.ok(rate.related_rule_ids.includes("penalty.rate_asymmetry"));
});

test("没有显式风险组时不同条款的同名风险不能误合并", () => {
  const merged = mergeReviewFindings([
    { risk_id: "a", risk_topic: "payment", title: "付款风险", contract_location: { file_version_id: "v1", clause_no: "2.1", quote: "付款" } },
    { risk_id: "b", risk_topic: "payment", title: "付款风险", contract_location: { file_version_id: "v1", clause_no: "3.1", quote: "付款" } }
  ]);
  assert.equal(merged.length, 2);
});

test("证据不足或未确认的风险不得保留 high/critical 等级", () => {
  const finding = normalizeFindingSeverity({
    risk_level: "critical", conclusion_status: "needs_verification", evidence_status: "unverified",
    contract_location: { location_status: "unresolved", source_refs: [] }
  });
  assert.equal(finding.risk_level, "medium");
  assert.equal(finding.level_cap_reason, "缺少原文定位或确认性证据，等级上限为 medium");
});

test("跨条款引用目标不存在时输出带两端关系的确定性检查", () => {
  const result = runContractChecks({ document, facts: { facts: [] } });
  const check = result.checkResults.find((item) => item.check_id === "reference.unresolved_target");
  assert.ok(check);
  assert.equal(check.status, "conflict");
  assert.ok(check.source_refs.some((ref) => compact(ref.quote).includes("第9.1条")));
  const finding = result.findings.find((item) => item.rule_id === "reference.unresolved_target");
  assert.equal(finding.risk_topic, "cross_clause_reference");
  assert.equal(finding.contract_location.source_refs.length, 1);
});
