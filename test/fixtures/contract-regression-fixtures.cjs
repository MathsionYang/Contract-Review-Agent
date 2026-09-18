"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { getContractProfile } = require("../../electron/contract-profiles.cjs");

const PROFILE_SECTIONS = {
  procurement: ["采购货物价格、税费和付款安排。", "供应商应按约定交付设备并配合验收。", "质量保证、维修和违约责任。", "争议解决和合同变更。"],
  software: ["软件许可、源码和知识产权归属。", "系统按里程碑交付、部署并完成验收。", "数据保护、信息安全和服务责任。", "争议解决和合同变更。"],
  service: ["服务费用和付款安排。", "服务商按里程碑履约并提交服务成果。", "服务水平、人员替换和违约责任。", "争议解决和合同变更。"],
  lease: ["租金、押金和付款安排。", "出租方交付标的并移交占有。", "维修维护、损害责任和保险。", "租期届满返还及合同解除。"],
  unknown: ["双方约定价款和付款安排。", "一方应按约定履行并交付成果。", "违约责任和损害赔偿。", "争议解决和合同变更。"]
};

const PROFILE_CODES = { procurement: "P", software: "S", service: "V", lease: "L", unknown: "U" };

function createContractDocument(profile) {
  const selected = getContractProfile(profile);
  const key = selected.profile;
  const code = PROFILE_CODES[key];
  const sections = PROFILE_SECTIONS[key];
  const clauseNos = sections.map((_section, index) => `${index + 1}.${index + 1}`);
  const lines = sections.map((section, index) => `${clauseNos[index]} ${section}`);
  const text = lines.join("\n");
  let cursor = 0;
  const blocks = lines.map((line, index) => {
    const start = cursor;
    cursor += line.length + (index < lines.length - 1 ? 1 : 0);
    return {
      block_id: `fixture_${code.toLowerCase()}_block_${index + 1}`,
      source_type: "fixture",
      page: index + 1,
      logical_page: index + 1,
      page_status: "resolved",
      block_type: "paragraph",
      clause_no: clauseNos[index],
      text: line,
      char_range: [start, start + line.length]
    };
  });
  const validBlock = blocks[0];
  const penaltyBlock = blocks[2];
  const shortQuote = penaltyBlock.text.slice(-4);
  const validReferenceId = `ref_${code.toLowerCase()}_delivery`;
  const missingReferenceId = `ref_${code.toLowerCase()}_missing`;
  const penaltyFacts = [
    {
      fact_id: `fact_${code.toLowerCase()}_penalty_1`,
      fact_type: "penalty",
      clause_no: penaltyBlock.clause_no,
      clause_instance_id: `clause_${code.toLowerCase()}_${penaltyBlock.clause_no}`,
      subject: "counterparty",
      breach_event: key === "lease" ? "property_damage" : key === "software" ? "service_level_breach" : "late_performance",
      remedy_scope: "same_obligation",
      rate: 0.001,
      rate_base: "contract_price",
      cap: 0.1,
      remedy_type: "liquidated_damages",
      source_refs: [{ block_id: penaltyBlock.block_id, clause_no: penaltyBlock.clause_no, quote: penaltyBlock.text }]
    },
    {
      fact_id: `fact_${code.toLowerCase()}_penalty_2`,
      fact_type: "penalty",
      clause_no: penaltyBlock.clause_no,
      clause_instance_id: `clause_${code.toLowerCase()}_${penaltyBlock.clause_no}_secondary`,
      subject: "counterparty",
      breach_event: key === "lease" ? "property_damage" : key === "software" ? "service_level_breach" : "late_performance",
      remedy_scope: "same_obligation",
      rate: 0.0005,
      rate_base: "contract_price",
      cap: 0.2,
      remedy_type: "occupancy_fee",
      source_refs: [{ block_id: penaltyBlock.block_id, clause_no: penaltyBlock.clause_no, quote: penaltyBlock.text }]
    }
  ];
  const document = {
    document_id: `fixture_document_${code.toLowerCase()}`,
    fileVersionId: `fixture_version_${code.toLowerCase()}`,
    fileName: `contract-${key}-fixture.md`,
    documentType: "markdown",
    text,
    pages: sections.map((section, index) => ({ page: index + 1, text: lines[index] })),
    blocks,
    profile: key,
    contract_type: selected.contract_type
  };
  return {
    document,
    expectations: {
      profile: key,
      validQuotedClauseNo: validBlock.clause_no,
      decimalLikeToken: "2026.09",
      validReferenceId,
      missingReferenceId,
      shortQuoteFactId: penaltyFacts[0].fact_id,
      shortQuoteClauseNo: penaltyBlock.clause_no,
      validEvidenceRef: { block_id: validBlock.block_id, clause_no: validBlock.clause_no, quote: validBlock.text },
      penaltyFacts,
      sampleTopics: Object.keys(selected.topicAliases),
      clausePatterns: ["numbered_clause", "payment_terms", "liability_scope"]
    }
  };
}

function loadBaselineCase(caseId) {
  const manifestPath = path.join(__dirname, "contract-baseline-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entry = manifest.cases.find((item) => item.case_id === caseId);
  if (!entry) throw new Error(`Unknown contract baseline case: ${caseId}`);
  const fixture = createContractDocument(entry.profile);
  return { ...fixture, baseline: entry };
}

module.exports = { createContractDocument, loadBaselineCase };
