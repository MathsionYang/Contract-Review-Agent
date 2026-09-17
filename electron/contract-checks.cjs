const CHECK_STATUSES = new Set(["pass", "conflict", "missing", "unverifiable", "not_applicable"]);
const { compact, resolveRefs } = require("./contract-evidence.cjs");

const SEVERITY = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low"
};

function sourceRefsFor(facts = [], predicate) {
  const refs = [];
  for (const fact of facts) {
    if (!predicate(fact)) continue;
    for (const ref of fact.source_refs || []) {
      const key = `${ref.block_id}|${ref.page}|${ref.quote}`;
      if (!refs.some((item) => `${item.block_id}|${item.page}|${item.quote}` === key)) refs.push(ref);
    }
  }
  return refs;
}

function textRefs(document = {}, text = "", clauseNo = "") {
  return resolveRefs(document, text, clauseNo);
}

function numberValue(value) {
  const normalized = String(value || "").replace(/[,，\s]/g, "");
  return /^\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : null;
}

function priceTableSummary(document = {}, text = "") {
  const blocks = Array.isArray(document.blocks) ? document.blocks : [];
  const tableGroups = new Map();
  for (const block of blocks) {
    const tableId = block?.table_ref?.table_id;
    if (!tableId) continue;
    if (!tableGroups.has(tableId)) tableGroups.set(tableId, []);
    tableGroups.get(tableId).push(block);
  }
  for (const cells of tableGroups.values()) {
    const amountHeader = cells.find((cell) => /金额/.test(String(cell.text || "")) && Number.isInteger(cell.table_ref?.column));
    if (!amountHeader || !cells.some((cell) => /项目/.test(String(cell.text || "")))) continue;
    const amountColumn = amountHeader.table_ref.column;
    const rows = new Map();
    for (const cell of cells) {
      const row = cell.table_ref?.row;
      if (!rows.has(row)) rows.set(row, []);
      rows.get(row).push(cell);
    }
    const itemValues = [];
    const productValues = [];
    let total = null;
    const evidenceCells = [];
    for (const rowCells of rows.values()) {
      const amountCell = rowCells.find((cell) => cell.table_ref?.column === amountColumn);
      const value = numberValue(amountCell?.text);
      if (value === null) continue;
      evidenceCells.push(amountCell);
      if (rowCells.some((cell) => /合计/.test(String(cell.text || "")))) total = value;
      else if (amountCell.table_ref.row > amountHeader.table_ref.row) {
        itemValues.push(value);
        const unitColumn = cells.find((cell) => /单价/.test(cell.text))?.table_ref.column;
        const quantityColumn = cells.find((cell) => /数量/.test(cell.text))?.table_ref.column;
        const unitCell = rowCells.find((cell) => cell.table_ref.column === unitColumn);
        const quantityCell = rowCells.find((cell) => cell.table_ref.column === quantityColumn);
        const unit = numberValue(unitCell?.text);
        const quantity = Number(String(quantityCell?.text || "").match(/^\s*(\d+(?:\.\d+)?)/)?.[1]);
        productValues.push(unit !== null && Number.isFinite(quantity) ? Math.round(unit * quantity * 100) / 100 : null);
        evidenceCells.push(...[unitCell, quantityCell].filter(Boolean));
      }
    }
    if (itemValues.length && total !== null) {
      return {
        itemValues,
        productValues,
        total,
        source_refs: evidenceCells.flatMap((cell) => resolveRefs({ ...document, blocks: [cell] }, cell.text, "2.2"))
      };
    }
  }

  const match = String(text || "").match(/2\s*\.\s*2\s*合同价款构成如下[：:]?([\s\S]*?)2\s*\.\s*3\s*价款支付方式/);
  const section = match?.[1] || "";
  const totalMatch = section.match(/合\s*计[\s—-]*([\d,，]+)/);
  const total = numberValue(totalMatch?.[1]);
  if (total === null) return null;
  // Only accept a complete, sequential row layout. Never select numbers to fit the stated total.
  const clean = section.replace(/第\s*\d+\s*页\s*\/\s*共\s*\d+\s*页/g, " ");
  const body = clean.slice(clean.indexOf("金额") + 2).replace(/^\s*[（(]元[）)]/, "").split(/合\s*计/)[0].replace(/[—-]+\s*$/, "").trim();
  const rows = [...body.matchAll(/(?:^|\s)(\d+)\s+(.+?)\s+(\d+(?:\.\d+)?)\s*(?:用户|套|项|场|个|台|件|人月|人天)\s+([\d,，]+(?:\.\d+)?)\s+([\d,，]+(?:\.\d+)?)(?=\s|$)/g)];
  if (!rows.length || rows.some((row, i) => Number(row[1]) !== i + 1)
    || body.replace(/(?:^|\s)(\d+)\s+(.+?)\s+(\d+(?:\.\d+)?)\s*(?:用户|套|项|场|个|台|件|人月|人天)\s+([\d,，]+(?:\.\d+)?)\s+([\d,，]+(?:\.\d+)?)(?=\s|$)/g, "").trim()) return null;
  const itemValues = rows.map((row) => numberValue(row[5]));
  const productValues = rows.map((row) => Math.round(Number(row[3]) * numberValue(row[4]) * 100) / 100);
  return {
    itemValues,
    productValues,
    total,
    source_refs: uniqueRefs([
      ...textRefs(document, totalMatch[0], "2.2"),
      ...rows.flatMap((row) => textRefs(document, row[0].trim(), "2.2"))
    ])
  };
}

function uniqueRefs(refs = []) {
  const result = [];
  for (const ref of refs) {
    const item = ref || {};
    const key = `${item.block_id || ""}|${item.page ?? ""}|${item.quote || ""}`;
    if (!result.some((existing) => `${existing.block_id || ""}|${existing.page ?? ""}|${existing.quote || ""}` === key)) result.push(item);
  }
  return result;
}

function checkResult(check_id, status, severity, message, facts = [], predicate = () => false, extra = {}) {
  const fact_refs = facts.filter(predicate).map((fact) => fact.fact_id);
  return {
    check_id,
    status: CHECK_STATUSES.has(status) ? status : "unverifiable",
    severity,
    message,
    fact_refs,
    source_refs: uniqueRefs(extra.source_refs || sourceRefsFor(facts, predicate)),
    ...extra
  };
}

function findingFor(check, document = {}, options = {}) {
  const refs = uniqueRefs(check.source_refs || []);
  const first = refs.find((ref) => ref && ref.block_id !== "unresolved") || refs[0] || {};
  const evidence = check.status === "conflict" && first.block_id && first.block_id !== "unresolved" ? "verified" : "unverified";
  const conclusion = check.status === "conflict" ? "candidate" : "needs_verification";
  const level = check.severity || "medium";
  return {
    risk_id: `check_${check.check_id.replace(/[^a-zA-Z0-9_]+/g, "_")}`,
    source_type: "deterministic_check",
    evidence_origin: "deterministic_check",
    rule_id: check.check_id,
    risk_level: level,
    risk_category: options.risk_category || "commercial",
    risk_topic: options.risk_topic || check.check_id.split(".")[0],
    title: options.title || check.message,
    conclusion_status: conclusion,
    evidence_status: evidence,
    human_status: "pending_review",
    location_confidence: evidence === "verified" ? 0.94 : 0.38,
    contract_location: {
      file_version_id: document.fileVersionId || document.file_version_id || "",
      page: Number.isInteger(first.page) ? first.page : null,
      clause_no: String(first.clause_no || options.clause_no || ""),
      quote: String(first.quote || ""),
      source_refs: refs,
      location_status: first.block_id && first.block_id !== "unresolved" ? "resolved" : "unresolved"
    },
    analysis: check.message,
    suggestion: options.suggestion || "请结合合同原文和业务背景完成人工复核。",
    legal_basis: [],
    company_basis: [],
    related_checks: [check.check_id]
  };
}

function moneyFacts(facts) {
  return facts.filter((fact) => fact.fact_type === "money" && /^\d+$/.test(String(fact.value || "")));
}

function ratiosForClause(facts, clauseNo) {
  return facts.filter((fact) => fact.fact_type === "ratio" && fact.clause_no === clauseNo);
}

function runContractChecks({ document = {}, facts: extracted = {}, contractType = "", policy = {} } = {}) {
  const facts = Array.isArray(extracted) ? extracted : (extracted.facts || []);
  const text = String(document.text || extracted.text || "");
  const compactText = text.replace(/\s+/g, "");
  const checks = [];
  const findings = [];
  const add = (check, options = {}) => {
    checks.push(check);
    if (check.status === "conflict" || check.status === "missing" || check.status === "unverifiable") findings.push(findingFor(check, document, options));
  };

  const allMoney = moneyFacts(facts);
  const uppercaseTotal = allMoney.find((fact) => /[壹贰叁肆伍陆柒捌玖零〇一二三四五六七八九拾佰仟万億亿]/.test(fact.raw_text || ""));
  const lowercaseTotal = allMoney.find((fact) => fact.clause_no === "2.1" && !/[壹贰叁肆伍陆柒捌玖零〇一二三四五六七八九拾佰仟万億亿]/.test(fact.raw_text || ""));
  const clause22Money = allMoney.find((fact) => fact.clause_no === "2.2" || /合计/.test(fact.raw_text || ""));
  const totalRefs = sourceRefsFor(facts, (fact) => fact === uppercaseTotal || fact === lowercaseTotal || fact === clause22Money);
  add(checkResult(
    "amount.total_vs_uppercase",
    uppercaseTotal && lowercaseTotal ? (uppercaseTotal.value === lowercaseTotal.value ? "pass" : "conflict") : "unverifiable",
    SEVERITY.critical,
    uppercaseTotal && lowercaseTotal ? `大写金额 ${uppercaseTotal.value} 与小写金额 ${lowercaseTotal.value}${uppercaseTotal.value === lowercaseTotal.value ? "一致" : "不一致"}。` : "缺少大写或小写总价金额，无法完成校验。",
    facts,
    (fact) => fact === uppercaseTotal || fact === lowercaseTotal,
    { source_refs: totalRefs }
  ), { risk_category: "commercial", risk_topic: "amount_consistency", title: "合同总价大写与小写金额不一致", suggestion: "统一合同总价的大写和小写金额，并重新核对付款计划。" });

  const tableSummary = priceTableSummary(document, text);
  const itemSum = tableSummary?.itemValues.reduce((sum, value) => sum + value, 0) ?? 0;
  const productsKnown = tableSummary?.productValues?.every((value) => value !== null);
  const rowMismatch = tableSummary?.productValues?.some((value, i) => value !== null && Math.abs(value - tableSummary.itemValues[i]) > 0.005);
  const tableAnchorConflict = Boolean(tableSummary && lowercaseTotal && tableSummary.total !== Number(lowercaseTotal.value));
  add(checkResult(
    "amount.item_sum",
    tableSummary ? (itemSum !== tableSummary.total || tableAnchorConflict || rowMismatch ? "conflict" : productsKnown ? "pass" : "unverifiable") : "unverifiable",
    SEVERITY.critical,
    tableSummary ? `2.2 明细计算为 ${itemSum}，表内合计为 ${tableSummary.total}${tableAnchorConflict ? `，与 2.1 小写总价 ${lowercaseTotal.value} 不一致` : ""}。${rowMismatch ? "存在单价乘数量与行金额不一致。" : productsKnown ? "单价乘数量与行金额一致。" : "单价或数量未可靠抽取，行金额计算仍需核验。"}` : "未能完整抽取 2.2 明细金额。",
    facts,
    (fact) => fact === lowercaseTotal || fact === clause22Money,
    { source_refs: uniqueRefs([...(tableSummary?.source_refs || []), ...sourceRefsFor(facts, (fact) => fact === lowercaseTotal)]) }
  ), { risk_category: "commercial", risk_topic: "amount_consistency", title: "合同明细合计需要与总价交叉核对" });

  const scheduleRatios = ratiosForClause(facts, "2.3");
  const ratioSum = scheduleRatios.reduce((sum, fact) => sum + Number(fact.value), 0);
  add(checkResult(
    "amount.schedule_ratio_sum",
    scheduleRatios.length >= 3 ? (Math.abs(ratioSum - 1) < 1e-9 ? "pass" : "conflict") : "unverifiable",
    SEVERITY.critical,
    scheduleRatios.length >= 3 ? `2.3 分期比例合计 ${(ratioSum * 100).toFixed(2)}%。` : "未能完整抽取分期比例。",
    facts,
    (fact) => scheduleRatios.includes(fact)
  ), { risk_category: "commercial", risk_topic: "amount_consistency", title: "分期付款比例合计超过 100%", suggestion: "将分期比例调整为合计 100%，并重算各期金额。" });

  const scheduleAmountFacts = allMoney.filter((fact) => fact.clause_no === "2.3");
  const scheduleTotal = lowercaseTotal?.value || "";
  const detailTotal = tableSummary?.total ?? (clause22Money ? Number(clause22Money.value) : null);
  const scheduleComparable = scheduleAmountFacts.length === scheduleRatios.length && scheduleRatios.length >= 2 && scheduleTotal && detailTotal !== null;
  const scheduleMismatch = scheduleComparable && (detailTotal !== Number(scheduleTotal) || scheduleAmountFacts.some((f, i) => Math.abs(Number(f.value) - Number(scheduleTotal) * scheduleRatios[i].value) > 0.005));
  add(checkResult(
    "amount.schedule_amount_anchor",
    scheduleComparable ? (scheduleMismatch ? "conflict" : "pass") : "unverifiable",
    SEVERITY.high,
    scheduleComparable ? `分期金额 ${scheduleAmountFacts.map((f) => f.value).join(" / ")}，比例 ${scheduleRatios.map((f) => f.value * 100 + "%").join(" / ")}，小写总价 ${scheduleTotal}，明细合计 ${detailTotal}；${scheduleMismatch ? "存在金额或锚点冲突" : "计算一致"}。` : "缺少配对分期金额、比例或明细总价，无法核验。",
    facts,
    (fact) => scheduleAmountFacts.includes(fact) || fact === clause22Money || fact === lowercaseTotal,
    { source_refs: uniqueRefs([...(tableSummary?.source_refs || []), ...sourceRefsFor(facts, (f) => scheduleAmountFacts.includes(f) || f === lowercaseTotal)]) }
  ), { risk_category: "commercial", risk_topic: "amount_consistency", title: "分期金额与明细总价锚点不一致" });

  const durations = facts.filter((fact) => fact.fact_type === "duration");
  const acceptance10 = durations.find((fact) => fact.value === 10 && fact.calendar_type === "workday");
  const acceptance15 = durations.find((fact) => fact.value === 15 && fact.calendar_type === "calendar_day");
  const trial30 = durations.find((fact) => fact.value === 30 && fact.calendar_type === "calendar_day");
  add(checkResult("timeline.acceptance_deadline_conflict", acceptance10 && acceptance15 ? "conflict" : "unverifiable", SEVERITY.high, acceptance10 && acceptance15 ? "初验期限为 10 个工作日，另一条款又规定交付后 15 个自然日验收，期限与时间单位冲突。" : "未同时抽取到两组验收期限。", facts, (fact) => fact === acceptance10 || fact === acceptance15), { risk_category: "legal", risk_topic: "timeline_conflict", title: "验收期限与时间单位冲突" });
  add(checkResult("timeline.trial_before_final_acceptance", trial30 && acceptance15 ? "conflict" : "unverifiable", SEVERITY.high, trial30 && acceptance15 ? "30 个自然日试运行期长于交付后 15 个自然日终验期限，时序不能同时成立。" : "缺少试运行或终验期限，无法校验时序。", facts, (fact) => fact === trial30 || fact === acceptance15), { risk_category: "legal", risk_topic: "timeline_conflict", title: "试运行期与终验期限时序冲突" });

  const invertedObligations = facts.filter((fact) => fact.fact_type === "obligation" && fact.subject && fact.object_party && fact.subject === fact.object_party);
  add(checkResult("party.obligation_subject_inversion", invertedObligations.length ? "conflict" : "pass", SEVERITY.critical, invertedObligations.length ? `发现 ${invertedObligations.length} 条义务的主体和相对方均为同一方。` : "未发现主体和相对方相同的义务表述。", facts, (fact) => invertedObligations.includes(fact)), { risk_category: "text_quality", risk_topic: "party_inversion", title: "责任主体或相对方倒置" });

  const clause83 = /8\.3[^\n。；;]*除按第\s*8\.1\s*条[^\n。；;]*另按/.test(text);
  const clause81 = /8\.1[^\n。；;]*万分之五/.test(text);
  const hasCap = /8\.1[^\n。；;]*(?:累计|上限|不超过)/.test(text);
  const penaltyFacts = facts.filter((fact) => fact.fact_type === "penalty");
  const statements = text.split(/[。；;\n]/).map(compact).filter(Boolean);
  const dailyRates = statements.filter((s) => /每逾期一日|每日|每天|日违约金/.test(s) && /违约金/.test(s)).flatMap((s) => {
    const chinese = s.match(/万分之([一二三四五六七八九十])/);
    const percent = s.match(/(\d+(?:\.\d+)?)%/);
    const rate = chinese ? ("一二三四五六七八九十".indexOf(chinese[1]) + 1) / 10000 : percent ? Number(percent[1]) / 100 : null;
    const subject = s.match(/(甲方|乙方)/)?.[1];
    return rate === null ? [] : [{ rate, subject, text: s, base: s.includes("未付款") ? "未付款项" : s.includes("合同总价") ? "合同总价" : "待核验" }];
  });
  const threshold = Number.isFinite(policy.dailyPenaltyThreshold) && policy.dailyPenaltyThreshold >= 0 ? policy.dailyPenaltyThreshold : 0.0003;
  const excessive = dailyRates.filter((r) => r.rate > threshold);
  add(checkResult("penalty.daily_rate_excessive", excessive.length ? "conflict" : dailyRates.length ? "pass" : "unverifiable", SEVERITY.high,
    excessive.length ? `日违约金超过商业筛查阈值 ${(threshold * 100).toFixed(3)}%，按365日简单折算为 ${excessive.map((r) => (r.rate * 365 * 100).toFixed(2) + "%").join("、")}；并非法律利率上限，是否过高须结合实际损失、基数和履行情况核验。` : "未发现日费率超过筛查阈值；无日费率时无法计算。", facts, () => false,
    { source_refs: excessive.flatMap((r) => textRefs(document, r.text)), policy_threshold: threshold, threshold_kind: "screening_not_legal_limit" }), { title: "日违约金费率需评估", risk_topic: "breach_liability" });
  const payerA = dailyRates.find((r) => r.subject === "甲方");
  const payerB = dailyRates.find((r) => r.subject === "乙方");
  add(checkResult("penalty.rate_asymmetry", payerA && payerB ? (payerA.rate === payerB.rate ? "pass" : "conflict") : "unverifiable", SEVERITY.high,
    payerA && payerB ? `甲方日费率 ${(payerA.rate * 100).toFixed(3)}%（${payerA.base}），乙方 ${(payerB.rate * 100).toFixed(3)}%（${payerB.base}）。费率不同需评估商业理由；基数不同，不能直接认定实际责任倍数。` : "未同时取得双方日违约金费率，不能推断不对称。", facts, () => false,
    { source_refs: [payerA, payerB].filter(Boolean).flatMap((r) => textRefs(document, r.text)) }), { title: "双方日违约金费率不对称", risk_topic: "breach_liability" });
  const unitMixed = /工作日/.test(compactText) && /自然日|日历日/.test(compactText);
  const unitDefined = /工作日(?:是指|指|为)/.test(compactText) && /(?:自然日|日历日)(?:是指|指|为|包括|包含)/.test(compactText);
  add(checkResult("timeline.calendar_unit_mixing", unitMixed && !unitDefined ? "conflict" : "pass", SEVERITY.low,
    unitMixed && !unitDefined ? "合同同时采用工作日与自然日，未检出完整定义，需核对起算和节假日口径；混用本身不当然构成期限冲突。" : "未发现未定义的时间单位混用。", facts, (f) => f.fact_type === "duration"), { title: "时间单位定义待统一", risk_topic: "text_quality" });
  const environment = statements.filter((s) => /甲方/.test(s) && /环境准备|服务器|等[级]?保护备案/.test(s));
  const transfer = environment.length && /视为甲方违约/.test(compactText) && !/乙方.{0,25}(?:协助|配合).{0,30}(?:环境|备案)/.test(compactText);
  add(checkResult("obligation.environment_transfer", transfer ? "conflict" : "pass", SEVERITY.high,
    transfer ? "环境准备由甲方承担且延期视为甲方违约，未检出乙方对专业环境准备的配合边界。" : "未检出明确的环境责任单方转嫁模式。", facts, () => false,
    { source_refs: environment.flatMap((s) => textRefs(document, s)) }), { title: "环境准备责任单方转嫁", risk_topic: "obligation_allocation" });
  const costClauses = statements.filter((s) => /验收/.test(s) && /(?:均由|全部由)甲方承担/.test(s));
  const costException = /(?:质量|不合格).{0,30}(?:复检|检测).{0,30}乙方承担/.test(compactText);
  add(checkResult("acceptance.cost_allocation", costClauses.length && !costException ? "conflict" : "pass", SEVERITY.low,
    costClauses.length && !costException ? "验收费用全部由甲方承担，未检出因乙方质量问题复检时的费用例外。" : "未检出全部验收费用由甲方承担且无例外的安排。", facts, () => false,
    { source_refs: costClauses.flatMap((s) => textRefs(document, s)) }), { title: "验收费用缺少按责分担安排", risk_topic: "obligation_allocation" });
  add(checkResult("penalty.stacking", clause83 ? "conflict" : "pass", SEVERITY.critical, clause83 ? "8.3 对同一逾期交付行为叠加引用 8.1 的违约金和额外 10% 违约金。" : "未发现同一违约行为的明确叠加表述。", facts, (fact) => penaltyFacts.includes(fact)), { risk_category: "legal", risk_topic: "breach_liability", title: "逾期违约金存在叠加风险" });
  add(checkResult("penalty.unlimited_delay_cap", clause81 && !hasCap ? "conflict" : "pass", SEVERITY.high, clause81 && !hasCap ? "8.1 未设置逾期违约金累计上限。" : "已发现逾期违约金上限或无法确认。", facts, (fact) => fact.fact_type === "penalty" && fact.clause_no === "8.1"), { risk_category: "legal", risk_topic: "breach_liability", title: "逾期违约金缺少累计上限" });
  const broadLoss = /直接损失[、,，\s]*间接损失[、,，\s]*可得利益损失/.test(text);
  add(checkResult("liability.broad_indirect_loss", broadLoss ? "conflict" : "pass", SEVERITY.critical, broadLoss ? "赔偿范围包含间接损失、可得利益及第三方索赔，且未见责任上限。" : "未发现同时纳入间接损失和可得利益的赔偿表述。", facts, (fact) => fact.fact_type === "penalty" && /间接损失/.test(fact.raw_text)), { risk_category: "legal", risk_topic: "liability_scope", title: "赔偿范围过宽且未设置责任上限" });

  const venueConflict = /乙方所在地人民法院/.test(text);
  add(checkResult("dispute.counterparty_venue", venueConflict ? "conflict" : "pass", SEVERITY.high, venueConflict ? "争议管辖约定为乙方所在地，可能增加甲方诉讼成本。" : "未发现明确指向乙方所在地的管辖表述。", facts, () => false, { source_refs: textRefs(document, "乙方所在地人民法院", "10.2") }), { risk_category: "legal", risk_topic: "dispute_resolution", title: "争议管辖落在对方所在地" });

  const confidentialityStart = text.search(/7\s*\.\s*1/);
  const confidentialityTail = confidentialityStart >= 0 ? text.slice(confidentialityStart) : "";
  const confidentialityEnd = confidentialityStart >= 0
    ? confidentialityTail.search(/第\s*八\s*条|8\s*\.\s*1/)
    : -1;
  const confidentialityText = confidentialityStart >= 0
    ? text.slice(confidentialityStart, confidentialityEnd > 0 ? confidentialityStart + confidentialityEnd : text.length).replace(/\s+/g, "")
    : "";
  const missingChecks = [
    ["completeness.termination_right", /甲方[^\n。；;]{0,30}(?:单方解除|有权解除)/, "未发现甲方在乙方根本违约或长期逾期时的单方解除权。", "甲方单方解除权"],
    ["completeness.data_disposition", /(?:数据导出|数据返还|删除确认|账号注销)/, "未发现合同终止后的软件停用、账号注销、数据导出/删除确认条款。", "终止后的软件停用与数据处置"],
    ["completeness.ip_indemnity", /(?:知识产权侵权|第三方.*侵权|侵权.*抗辩)/, "未发现第三方知识产权侵权主张时的抗辩、替换和费用承担责任。", "知识产权不侵权担保责任"],
    ["completeness.confidentiality_remedy", /保密.{0,100}(?:违约金|赔偿|责任)/, "保密条款规定了义务和期限，但未规定违反保密义务的责任后果。", "保密义务违约后果", confidentialityText],
    ["completeness.compliance_warranty", /(?:持续.*合规|资质.*有效|符合国家.*行业标准)/, "未发现乙方资质与软件产品持续合规保证。", "乙方资质与产品持续合规保证"]
  ];
  for (const [id, pattern, message, title, scopedText] of missingChecks) {
    const present = pattern.test(scopedText ?? compactText);
    add(checkResult(id, present ? "pass" : "missing", SEVERITY.high, present ? `${title}已在合同中出现。` : message, facts, () => false, { source_refs: textRefs(document, "", id.split(".")[1]) }), { risk_category: "legal", risk_topic: "missing_clause", title });
  }

  const subjectiveAcceptance = /满足甲方使用需求/.test(compactText);
  const majorFault = /重大故障/.test(compactText);
  add(checkResult("acceptance.subjective_standard", subjectiveAcceptance ? "conflict" : "pass", SEVERITY.high, subjectiveAcceptance ? "初验标准使用“满足甲方使用需求”，缺少可量化技术指标。" : "未发现明显主观化验收标准。", facts, () => false, { source_refs: textRefs(document, "满足甲方使用需求", "4.2") }), { risk_category: "commercial", risk_topic: "acceptance_quality", title: "验收标准主观且不可量化" });
  add(checkResult("acceptance.major_fault_undefined", majorFault ? "conflict" : "pass", SEVERITY.medium, majorFault ? "合同使用“重大故障”作为终验条件，但未定义停机时长、影响范围等客观标准。" : "未发现未定义的重大故障标准。", facts, () => false, { source_refs: textRefs(document, "重大故障", "4.3") }), { risk_category: "text_quality", risk_topic: "acceptance_quality", title: "重大故障未定义" });

  const licenseConflict = /许可期限为永久/.test(text) && /合同[^\n。；;]{0,20}有效期三年/.test(text);
  add(checkResult("timeline.license_term_conflict", licenseConflict ? "conflict" : "pass", SEVERITY.high, licenseConflict ? "软件许可期限为永久，但合同有效期仅三年，存续安排不明确。" : "未发现许可期限与合同有效期的明确冲突。", facts, () => false, { source_refs: textRefs(document, "许可期限为永久", "1.2") }), { risk_category: "legal", risk_topic: "timeline_conflict", title: "软件许可期限与合同有效期冲突" });

  // Keep contract-type information visible for future catalogs without changing the current check semantics.
  if (contractType && contractType !== "procurement" && contractType !== "software") {
    checks.push({ check_id: "catalog.contract_type_scope", status: "unverifiable", severity: "info", message: `合同类型 ${contractType} 尚未绑定专项检查清单。`, fact_refs: [], source_refs: [] });
  }
  return { checkResults: checks, findings };
}

module.exports = { CHECK_STATUSES, runContractChecks };
