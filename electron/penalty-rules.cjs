"use strict";

const { compact } = require("./contract-evidence.cjs");

function referencesFor(fact = {}) {
  const refs = Array.isArray(fact.references) ? fact.references : [];
  const inline = [...String(fact.raw_text || "").matchAll(/(?:第\s*)?(\d+(?:\.\d+)*)\s*条/g)].map((match) => match[1]);
  return [...new Set([...refs, ...inline].map((value) => String(value || "").replace(/\s+/g, "")).filter(Boolean))];
}

function parseDailyRates(text = "") {
  const statements = String(text || "").split(/[。；;\n]/).map(compact).filter(Boolean);
  return statements.filter((statement) => /每逾期一日|每日|每天|日违约金/.test(statement) && /违约金/.test(statement))
    .flatMap((statement) => {
      const chinese = statement.match(/万分之([一二三四五六七八九十])/);
      const percent = statement.match(/(\d+(?:\.\d+)?)%/);
      const rate = chinese ? ("一二三四五六七八九十".indexOf(chinese[1]) + 1) / 10000 : percent ? Number(percent[1]) / 100 : null;
      const subject = statement.match(/(甲方|乙方)/)?.[1] || "";
      if (rate === null) return [];
      return [{ rate, subject, text: statement, base: statement.includes("未付款") ? "未付款项" : statement.includes("合同总价") ? "合同总价" : "待核验" }];
    });
}

function analyzePenaltyRules({ text = "", facts = [], dailyPenaltyThreshold = 0.0003 } = {}) {
  const penaltyFacts = facts.filter((fact) => fact.fact_type === "penalty");
  const penaltyByClause = new Map(penaltyFacts.filter((fact) => fact.clause_no).map((fact) => [String(fact.clause_no), fact]));
  const stackingFacts = penaltyFacts.filter((fact) => {
    const references = referencesFor(fact);
    return /(?:除按|另按|同时主张|另行支付)/.test(String(fact.raw_text || ""))
      && references.some((reference) => penaltyByClause.has(reference));
  });
  const delayPenaltyFacts = penaltyFacts.filter((fact) => /逾期|延期|延迟/.test(String(fact.raw_text || "")) && /违约金|赔偿/.test(String(fact.raw_text || "")));
  const hasCap = delayPenaltyFacts.some((fact) => /累计|上限|不超过/.test(String(fact.raw_text || "")));
  const dailyRates = parseDailyRates(text);
  const threshold = Number.isFinite(Number(dailyPenaltyThreshold)) && Number(dailyPenaltyThreshold) >= 0 ? Number(dailyPenaltyThreshold) : 0.0003;
  const excessive = dailyRates.filter((item) => item.rate > threshold);
  const relatedClauseNos = [...new Set(stackingFacts.flatMap((fact) => [fact.clause_no, ...referencesFor(fact)]).filter(Boolean))];
  return {
    penaltyFacts,
    stackingFacts,
    delayPenaltyFacts,
    hasCap,
    stackingDetected: stackingFacts.length > 0,
    delayPenaltyDetected: delayPenaltyFacts.length > 0,
    dailyRates,
    excessive,
    threshold,
    relatedClauseNos,
    payerA: dailyRates.find((item) => item.subject === "甲方"),
    payerB: dailyRates.find((item) => item.subject === "乙方")
  };
}

module.exports = { analyzePenaltyRules, parseDailyRates, referencesFor };
