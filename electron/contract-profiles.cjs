"use strict";

// Contract profiles are deliberately data-driven.  Runtime code should select a
// profile through this module instead of branching on a particular contract or
// hard-coded clause number.
const PROFILE_DEFINITIONS = {
  procurement: {
    contract_type: "procurement",
    rule_pack_version: "procurement.v1",
    topicAliases: {
      amount: ["price", "total", "tax", "payment", "付款", "价款", "税"],
      delivery: ["delivery", "shipment", "交付", "交货"],
      acceptance: ["acceptance", "inspection", "验收", "检验"],
      liability: ["liability", "penalty", "breach", "责任", "违约"],
      warranty: ["warranty", "quality", "质保", "质量"],
      dispute: ["dispute", "jurisdiction", "争议", "管辖"]
    },
    applicabilityRules: [
      { id: "procurement.goods", topics: ["amount", "delivery", "acceptance", "warranty"], patterns: [/采购|货物|设备|商品|交货|delivery|goods/i] },
      { id: "procurement.generic", topics: ["liability", "dispute"], patterns: [/违约|责任|争议|liability|dispute/i] }
    ]
  },
  software: {
    contract_type: "software",
    rule_pack_version: "software.v1",
    topicAliases: {
      amount: ["price", "license fee", "付款", "许可费"],
      delivery: ["milestone", "deployment", "交付", "上线", "里程碑"],
      acceptance: ["acceptance", "验收", "测试"],
      liability: ["liability", "security", "责任", "安全"],
      intellectual_property: ["ip", "license", "open source", "知识产权", "许可", "开源"],
      data: ["data", "privacy", "数据", "个人信息"]
    },
    applicabilityRules: [
      { id: "software.delivery", topics: ["delivery", "acceptance"], patterns: [/软件|系统|平台|saas|api|deployment|software/i] },
      { id: "software.ip_data", topics: ["intellectual_property", "data"], patterns: [/软件|源码|许可|开源|数据|privacy|ip/i] },
      { id: "software.generic", topics: ["liability"], patterns: [/违约|责任|liability|security/i] }
    ]
  },
  service: {
    contract_type: "service",
    rule_pack_version: "service.v1",
    topicAliases: {
      amount: ["price", "fee", "付款", "服务费"],
      delivery: ["milestone", "delivery", "履约", "里程碑"],
      acceptance: ["acceptance", "验收", "服务成果"],
      liability: ["liability", "breach", "责任", "违约"],
      service_level: ["sla", "response", "service level", "服务水平", "响应"],
      personnel: ["personnel", "replacement", "人员", "替换"]
    },
    applicabilityRules: [
      { id: "service.performance", topics: ["delivery", "acceptance", "service_level"], patterns: [/服务|咨询|运维|实施|service|sla|响应/i] },
      { id: "service.personnel", topics: ["personnel"], patterns: [/服务|人员|驻场|替换|service|personnel/i] },
      { id: "service.generic", topics: ["amount", "liability"], patterns: [/付款|费用|违约|责任|fee|liability/i] }
    ]
  },
  lease: {
    contract_type: "lease",
    rule_pack_version: "lease.v1",
    topicAliases: {
      amount: ["rent", "deposit", "租金", "押金"],
      delivery: ["handover", "possession", "交付", "占有"],
      maintenance: ["repair", "maintenance", "维修", "维护"],
      liability: ["liability", "damage", "责任", "损害"],
      termination: ["termination", "return", "解除", "返还"]
    },
    applicabilityRules: [
      { id: "lease.possession", topics: ["delivery", "maintenance"], patterns: [/租赁|出租|承租|房屋|场地|lease|rent/i] },
      { id: "lease.payment_return", topics: ["amount", "termination"], patterns: [/租金|押金|返还|解除|rent|deposit|return/i] },
      { id: "lease.generic", topics: ["liability"], patterns: [/违约|责任|损害|liability|damage/i] }
    ]
  },
  unknown: {
    contract_type: "unknown",
    rule_pack_version: "generic.v1",
    topicAliases: {
      amount: ["price", "payment", "金额", "付款"],
      delivery: ["delivery", "履行", "交付"],
      liability: ["liability", "breach", "责任", "违约"],
      dispute: ["dispute", "争议", "管辖"]
    },
    applicabilityRules: [
      { id: "generic.amount", topics: ["amount"], patterns: [/金额|价款|付款|价格|amount|payment|price/i] },
      { id: "generic.performance", topics: ["delivery"], patterns: [/履行|交付|提供|delivery|performance/i] },
      { id: "generic.liability", topics: ["liability"], patterns: [/责任|违约|赔偿|liability|breach/i] },
      { id: "generic.dispute", topics: ["dispute"], patterns: [/争议|仲裁|诉讼|管辖|dispute|jurisdiction/i] }
    ]
  }
};

function normalizeProfile(profile) {
  const value = typeof profile === "string" ? profile.trim().toLowerCase() : profile?.profile || profile?.contract_type;
  return PROFILE_DEFINITIONS[value] ? value : "unknown";
}

function getContractProfile(profile) {
  const key = normalizeProfile(profile);
  const definition = PROFILE_DEFINITIONS[key];
  return {
    profile: key,
    contract_type: definition.contract_type,
    rule_pack_version: definition.rule_pack_version,
    applicabilityRules: definition.applicabilityRules.map((rule) => ({ ...rule, patterns: [...rule.patterns] })),
    topicAliases: Object.fromEntries(Object.entries(definition.topicAliases).map(([topic, aliases]) => [topic, [...aliases]]))
  };
}

function collectSearchText(document = {}, facts = []) {
  const blocks = Array.isArray(document.blocks) ? document.blocks.map((block) => block?.text || "") : [];
  const factText = (Array.isArray(facts) ? facts : []).map((fact) => typeof fact === "string" ? fact : Object.values(fact || {}).join(" "));
  return [...blocks, document.text || "", ...factText].join(" ").trim();
}

function evaluateApplicability(profile, { document = {}, facts = [] } = {}) {
  const selected = getContractProfile(profile);
  const text = collectSearchText(document, facts);
  if (!text) return { status: "unverifiable", reason: "合同文本和事实均为空，无法判断适用性。", matchedRules: [] };
  const matchedRules = selected.applicabilityRules
    .filter((rule) => rule.patterns.some((pattern) => pattern.test(text)))
    .map((rule) => rule.id);
  if (matchedRules.length) {
    return { status: "applicable", reason: `命中合同类型 ${selected.profile} 的适用特征。`, matchedRules };
  }
  if (selected.profile === "unknown") {
    return { status: "applicable", reason: "未知合同类型仅执行通用规则。", matchedRules: [] };
  }
  return { status: "not_applicable", reason: `未发现 ${selected.profile} 合同的适用特征。`, matchedRules: [] };
}

module.exports = { getContractProfile, evaluateApplicability, PROFILE_DEFINITIONS };
