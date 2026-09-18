const CHECK_STATUSES = new Set(["pass", "conflict", "missing", "missing_candidate", "unverifiable", "not_applicable"]);
const { compact, resolveRefs, resolveClauseRefs, clauseDefinitions, extractClauseReferences } = require("./contract-evidence.cjs");
const { normalizeFindingSeverity } = require("./review-engine.cjs");
const { analyzePenaltyRules } = require("./penalty-rules.cjs");

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
    // Ambiguous/unresolved candidates are useful for review UX, but they are
    // not admissible as deterministic rule evidence.
    if (fact.source_refs_status && fact.source_refs_status !== "verified") continue;
    for (const ref of fact.source_refs || []) {
      const key = `${ref.block_id}|${ref.page}|${ref.quote}|${(ref.char_range || []).join("-")}`;
      if (!refs.some((item) => `${item.block_id}|${item.page}|${item.quote}|${(item.char_range || []).join("-")}` === key)) refs.push(ref);
    }
  }
  return refs;
}

function textRefs(document = {}, text = "", clauseNo = "") {
  if (!text && clauseNo) return resolveClauseRefs(document, clauseNo);
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
    const headerCells = cells.filter((cell) => Number.isInteger(cell.table_ref?.column) && Number.isInteger(cell.table_ref?.row));
    if (!headerCells.length) continue;
    const headerRow = Math.min(...headerCells.map((cell) => cell.table_ref.row));
    const columnText = (column) => String(headerCells.find((cell) => cell.table_ref.row === headerRow && cell.table_ref.column === column)?.text || "");
    // 表头列名必须容忍常见写法差异。
    // 原实现写死要找「项目」列：实测一份完整无缺的 8×7 采购明细表（表头为
    // 序号／设备名称／规格型号／单位／数量／单价（元）／金额（元））因为没有叫「项目」的列
    // 被整表跳过，导致"未能完整抽取明细金额"——数据其实完整，是列名匹配失败。
    const pickColumn = (pattern) => {
      const columns = [...new Set(headerCells.map((cell) => cell.table_ref.column))].sort((a, b) => a - b);
      return columns.find((column) => pattern.test(columnText(column)));
    };
    const amountColumn = pickColumn(/金额|合计金额|总价|小计/);
    const itemColumn = pickColumn(/项目|品名|名称|货物|设备|标的|内容|规格/);
    // 金额列是硬条件；项目列只是用来确认"这是一张明细表"而不是别的金额表。
    if (amountColumn === undefined || itemColumn === undefined) continue;
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
      if (rowCells.some((cell) => /合计|总计|小计/.test(String(cell.text || "")))) total = value;
      else if (amountCell.table_ref.row > headerRow) {
        itemValues.push(value);
        // 单价与数量同样按同义词匹配，并只在表头行里找，避免命中正文中同名的单元格。
        const unitColumn = pickColumn(/单价|单位价格|价格/);
        const quantityColumn = pickColumn(/数量|数目/);
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

// 分级与证据强度的绑定规则收敛在 src/services/evidenceLevel.mjs，避免多处实现漂移。
let evidenceLevel = { capLevelByEvidence: (level) => level, locationConfidence: (anchored, verified) => (anchored ? (verified ? 0.94 : 0.6) : 0) };
try {
  // electron 主进程可直接 require ESM（Node 22+），失败时退回下方内联实现，不影响审查。
  evidenceLevel = require("../src/services/evidenceLevel.mjs");
} catch (_error) { /* 保持内联回退实现 */ }

function findingFor(check, document = {}, options = {}) {
  const refs = uniqueRefs([
    ...(check.source_refs || []),
    ...(options.clause_no ? textRefs(document, "", options.clause_no) : [])
  ]);
  const first = refs.find((ref) => ref && ref.block_id !== "unresolved") || refs[0] || {};
  const anchored = Boolean(first.block_id && first.block_id !== "unresolved");
  const evidence = check.status === "conflict" && anchored ? "verified" : "unverified";
  const conclusion = check.status === "conflict" ? "candidate" : "needs_verification";
  // 唯一能决定证据强度的是"有没有落到原文"。解析自述类条目（未能抽取…）没有定位，
  // 不应因为清单项本身是 critical 就被当成 critical 上报。
  const declared = check.severity || "medium";
  const capped = evidenceLevel.capLevelByEvidence(declared, anchored);
  const downgraded = capped !== declared;
  return normalizeFindingSeverity({
    risk_id: `check_${check.check_id.replace(/[^a-zA-Z0-9_]+/g, "_")}`,
    source_type: "deterministic_check",
    evidence_origin: "deterministic_check",
    rule_id: check.check_id,
    risk_level: capped,
    risk_category: options.risk_category || "commercial",
    risk_topic: options.risk_topic || check.check_id.split(".")[0],
    title: ["unverifiable", "missing_candidate"].includes(check.status) ? `待核验：${check.message}` : options.title || check.message,
    conclusion_status: conclusion,
    evidence_status: evidence,
    check_status: check.status,
    human_status: "pending_review",
    // 没有定位就不该给出"接近确定"的置信度：原来无定位也写 0.38，看起来像已定位但弱。
    location_confidence: evidenceLevel.locationConfidence(anchored, evidence === "verified"),
    ...(downgraded ? { level_capped_from: declared, level_cap_reason: "缺少原文定位，等级上限为 medium" } : {}),
    contract_location: {
      file_version_id: document.fileVersionId || document.file_version_id || "",
      page: Number.isInteger(first.page) ? first.page : null,
      clause_no: String(first.clause_no || options.clause_no || ""),
      quote: String(first.quote || ""),
      char_range: Array.isArray(first.char_range) ? first.char_range : null,
      source_refs: refs,
      location_status: anchored ? "resolved" : "unresolved"
    },
    analysis: check.message,
    suggestion: ["unverifiable", "missing_candidate"].includes(check.status) ? "当前抽取结果不足以判断是否存在问题，请核对原文及所需材料后再确认。" : options.suggestion || "请结合合同原文和业务背景完成人工复核。",
    legal_basis: [],
    company_basis: [],
    related_checks: [check.check_id]
    ,aggregation_key: options.aggregation_key || options.risk_group || check.aggregation_key,
    related_clause_nos: options.related_clause_nos || check.related_clause_nos || [],
    cross_clause: options.cross_clause === true || check.cross_clause === true
  });
}

function moneyFacts(facts) {
  // 必须是可解析的十进制金额。原实现用 /^\d+$/ 只接受整数，
  // 于是 "2860000.00"、"1286000.00" 这类带小数点的金额被整体丢弃——
  // 而合同里的小写总价恰恰总是写成 ¥2,860,000.00 这种形式，
  // 结果大小写金额配对、明细合计交叉核对全部退化为"未能提供"。
  return facts.filter((fact) => fact.fact_type === "money" && /^\d+(?:\.\d+)?$/.test(String(fact.value ?? "").trim()));
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
    if (["conflict", "missing", "missing_candidate", "unverifiable"].includes(check.status)) findings.push(findingFor(check, document, options));
  };

  const allMoney = moneyFacts(facts);

  const clauseReferences = extractClauseReferences(text);
  const definedClauseNos = new Set(clauseDefinitions(text).map((item) => String(item.clause_no || "").replace(/\s+/g, "")));
  const unresolvedReferences = clauseReferences.filter((edge) => edge.target_clause_no && !definedClauseNos.has(edge.target_clause_no));
  add(checkResult(
    "reference.unresolved_target",
    unresolvedReferences.length ? "conflict" : "pass",
    SEVERITY.high,
    unresolvedReferences.length
      ? `发现 ${unresolvedReferences.length} 处交叉引用指向合同中未定义的条款：${unresolvedReferences.map((edge) => `${edge.from_clause_no || "未知条款"}->${edge.target_clause_no}`).join("、")}。`
      : "未发现指向不存在条款的交叉引用。",
    facts,
    () => false,
    {
      source_refs: uniqueRefs(unresolvedReferences.flatMap((edge) => textRefs(document, edge.quote, edge.from_clause_no))),
      reference_edges: unresolvedReferences,
      aggregation_key: "cross-clause-reference",
      cross_clause: true,
      related_clause_nos: [...new Set(unresolvedReferences.flatMap((edge) => [edge.from_clause_no, edge.target_clause_no]).filter(Boolean))]
    }
  ), { risk_category: "legal", risk_topic: "cross_clause_reference", title: "交叉引用指向不存在条款", aggregation_key: "cross-clause-reference", cross_clause: true });
  const isUppercase = (fact) => /[壹贰叁肆伍陆柒捌玖零〇一二三四五六七八九拾佰仟万億亿]/.test(fact.raw_text || "");
  const uppercaseTotal = allMoney.find((fact) => isUppercase(fact));
  // 小写总价的定位不能写死条款号。
  // 原实现要求 `fact.clause_no === "2.1"`，而实测合同的价款条款在第 3.1 条、
  // 4.1 条付款方式里也出现同一个小写金额，于是大写与小写无法配对，
  // 检查退化为"未能配对提取"，把真实存在的大小写不一致（D-05）掩盖掉。
  // 改为按"与大写总价同一条款优先、否则取首个阿拉伯数字金额"配对：
  // 大小写金额在合同里总是紧邻书写的，同条款是最可靠的信号。
  const lowercaseTotal = (uppercaseTotal
    ? allMoney.find((fact) => !isUppercase(fact) && fact.clause_no === uppercaseTotal.clause_no)
    : null)
    || allMoney.find((fact) => !isUppercase(fact));
  const clause22Money = allMoney.find((fact) => fact.clause_no === "2.2" || /合计/.test(fact.raw_text || ""));
  const totalRefs = sourceRefsFor(facts, (fact) => fact === uppercaseTotal || fact === lowercaseTotal || fact === clause22Money);
  add(checkResult(
    "amount.total_vs_uppercase",
    uppercaseTotal && lowercaseTotal ? (uppercaseTotal.value === lowercaseTotal.value ? "pass" : "conflict") : "unverifiable",
    SEVERITY.critical,
    uppercaseTotal && lowercaseTotal ? `大写金额 ${uppercaseTotal.value} 与小写金额 ${lowercaseTotal.value}${uppercaseTotal.value === lowercaseTotal.value ? "一致" : "不一致"}。` : "未能配对提取大写总价和小写总价，无法完成校验；请核对价款条款的大写与小写金额。",
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

  // 分期条款的位置不能写死条款号（原实现固定 2.3 条），否则条款编号体系一变整条检查失效。
  // 但也不能简单取"比例最密集的条"：实测违约金条款会写多条费率（如 0.5%／0.005%／1%），
  // 比真正的付款计划更密集，会被误判成分期。
  // 判据取两者的组合：比例之和接近 100%，且条款标题/上下文不是惩罚性表述。
  const PENALTY_HINTS = /违约金|逾期|赔偿|违约|罚则|滞纳/;
  const ratioFacts = facts.filter((fact) => fact.fact_type === "ratio");
  const ratiosByClause = new Map();
  for (const fact of ratioFacts) {
    const key = String(fact.clause_no || "");
    if (!key) continue;
    ratiosByClause.set(key, [...(ratiosByClause.get(key) || []), fact]);
  }
  const clauseContext = (clauseNo) => facts.filter((fact) => String(fact.clause_no || "") === clauseNo)
    .map((fact) => String(fact.raw_text || "")).join(" ");
  const scheduleCandidates = [...ratiosByClause.entries()]
    .filter(([clauseNo, group]) => {
      if (group.length < 2) return false;
      if (PENALTY_HINTS.test(clauseContext(clauseNo))) return false;
      const sum = group.reduce((total, fact) => total + Number(fact.value), 0);
      // 付款计划的各期比例应当构成完整价款：允许因笔误略超 100%，但不可能只有百分之几。
      return sum > 0.5 && sum <= 1.2;
    })
    .sort((left, right) => right[1].length - left[1].length);
  const scheduleClause = scheduleCandidates[0];
  const scheduleRatios = scheduleClause ? scheduleClause[1] : [];
  const ratioSum = scheduleRatios.reduce((sum, fact) => sum + Number(fact.value), 0);
  // 少于两期说明这不是分期付款安排（例如签约后一次付清 100%）。
  // 原实现把"少于三期"判为 unverifiable 并挂 critical，于是"全额预付"这种真缺陷
  // 被一条解析自述盖住，critical 级别也被占用。没有分期安排时应判为不适用。
  const hasSchedule = scheduleRatios.length >= 2;
  add(checkResult(
    "amount.schedule_ratio_sum",
    hasSchedule ? (Math.abs(ratioSum - 1) < 1e-9 ? "pass" : "conflict") : "not_applicable",
    SEVERITY.critical,
    hasSchedule ? `第 ${scheduleClause[0]} 条分期比例合计 ${(ratioSum * 100).toFixed(2)}%。`
      : "本合同未检出台账式分期付款安排（未找到合计接近 100% 的多期比例），分期比例合计不适用。",
    facts,
    (fact) => scheduleRatios.includes(fact)
  ), { risk_category: "commercial", risk_topic: "amount_consistency", title: "分期付款比例合计不等于 100%", suggestion: "将分期比例调整为合计 100%，并重算各期金额。" });

  const scheduleAmountFacts = scheduleClause ? allMoney.filter((fact) => fact.clause_no === scheduleClause[0]) : [];
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

  const penaltyRules = analyzePenaltyRules({ text, facts, dailyPenaltyThreshold: policy.dailyPenaltyThreshold });
  const {
    penaltyFacts, stackingFacts, stackingDetected, delayPenaltyFacts, delayPenaltyDetected, hasCap,
    dailyRates, excessive, threshold, payerA, payerB, relatedClauseNos
  } = penaltyRules;
  const statements = text.split(/[。；;\n]/).map(compact).filter(Boolean);
  add(checkResult("penalty.daily_rate_excessive", excessive.length ? "conflict" : dailyRates.length ? "pass" : "unverifiable", SEVERITY.high,
    excessive.length ? `日违约金超过商业筛查阈值 ${(threshold * 100).toFixed(3)}%，按365日简单折算为 ${excessive.map((r) => (r.rate * 365 * 100).toFixed(2) + "%").join("、")}；并非法律利率上限，是否过高须结合实际损失、基数和履行情况核验。` : "未发现日费率超过筛查阈值；无日费率时无法计算。", facts, () => false,
    { source_refs: excessive.flatMap((r) => textRefs(document, r.text)), policy_threshold: threshold, threshold_kind: "screening_not_legal_limit" }), { title: "日违约金费率需评估", risk_topic: "breach_liability" });
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
  const penaltyRefs = uniqueRefs([
    ...sourceRefsFor(facts, (fact) => stackingFacts.includes(fact) || delayPenaltyFacts.includes(fact)),
    ...stackingFacts.flatMap((fact) => (fact.references || []).flatMap((clauseNo) => textRefs(document, "", clauseNo)))
  ]);
  add(checkResult("penalty.stacking", stackingDetected ? "conflict" : "pass", SEVERITY.critical, stackingDetected ? "同一逾期行为同时引用基础违约金和额外违约金，存在重复计罚风险。" : "未发现同一违约行为的明确叠加表述。", facts, (fact) => stackingFacts.includes(fact) || penaltyFacts.includes(fact), { source_refs: penaltyRefs, related_clause_nos: relatedClauseNos }), { risk_category: "legal", risk_topic: "breach_liability", title: "逾期违约金存在叠加风险", related_clause_nos: relatedClauseNos, cross_clause: relatedClauseNos.length > 1 });
  add(checkResult("penalty.unlimited_delay_cap", delayPenaltyDetected && !hasCap ? "conflict" : "pass", SEVERITY.high, delayPenaltyDetected && !hasCap ? "逾期违约金条款未设置累计上限。" : "已发现逾期违约金上限或无法确认。", facts, (fact) => delayPenaltyFacts.includes(fact), { source_refs: sourceRefsFor(facts, (fact) => delayPenaltyFacts.includes(fact)) }), { risk_category: "legal", risk_topic: "breach_liability", title: "逾期违约金缺少累计上限" });
  // 责任上限必须真的去查，不能凭空断言"未见"。
  // 原实现只判 broadLoss 就直接写"且未见责任上限"，而实测合同第 13.5 条明确写着
  // "累计不超过合同总价的 5%"——这条断言与原文相反，且方向有害：
  // 照它建议"补一个上限"会把风险做大（该上限过低才是真缺陷）。
  const hasLiabilityCap = /累计不超过|赔偿上限|责任上限|上限为|最高不超过|累计上限/.test(compactText);
  // 免责范围的写法很灵活："不承担任何间接损失、可得利益损失、数据损失及停产损失"
  // 并不出现"直接损失/间接损失/可得利益损失"这种连写，原正则因此漏判。
  const broadLoss = /(?:不承担|不赔偿|免除)[^。；;]{0,40}(?:间接损失|可得利益|停产损失|数据损失)/.test(compactText)
    || /直接损失[、,，\s]*间接损失[、,，\s]*(?:可得利益损失)?/.test(text);
  add(checkResult(
    "liability.broad_indirect_loss",
    // 宽免责 + 有上限 = 需要核验上限是否合理；宽免责 + 无上限 = 真正的冲突。
    broadLoss ? (hasLiabilityCap ? "unverifiable" : "conflict") : "pass",
    SEVERITY.critical,
    broadLoss
      ? (hasLiabilityCap ? "赔偿范围排除了间接损失、可得利益、数据损失等，且约定了责任上限；上限是否过低需结合合同金额与违约后果人工核验。" : "赔偿范围排除了间接损失、可得利益等，且未见责任上限。")
      : "未发现同时纳入间接损失和可得利益的赔偿表述。",
    facts, (fact) => fact.fact_type === "penalty" && /间接损失/.test(fact.raw_text)
  ), { risk_category: "legal", risk_topic: "liability_scope",
    title: hasLiabilityCap ? "责任上限与免责范围需人工核验" : "赔偿范围过宽且未设置责任上限" });

  const venueConflict = /乙方所在地人民法院/.test(text);
  add(checkResult("dispute.counterparty_venue", venueConflict ? "conflict" : "pass", SEVERITY.high, venueConflict ? "争议管辖约定为乙方所在地，可能增加甲方诉讼成本。" : "未发现明确指向乙方所在地的管辖表述。", facts, () => false, { source_refs: textRefs(document, "乙方所在地人民法院", "10.2") }), { risk_category: "legal", risk_topic: "dispute_resolution", title: "争议管辖落在对方所在地" });

  // 保密条款的位置不能按条款号写死。
  // 原实现沿用示例合同的 "7.1 → 第八条" 区间，而实测合同的保密约定在第十二条，
  // 于是切片落在"安装与调试"条款上（该段根本没有保密内容），
  // 检查必然判 missing，产出"未规定违反保密义务的责任后果"——与原文 12.3 直接相反。
  // 改为从首个"保密"出现处起、到下一个章标题（第 X 条）为止。
  const confidentialityStart = text.search(/保密/);
  const confidentialityTail = confidentialityStart >= 0 ? text.slice(confidentialityStart) : "";
  const confidentialityEnd = confidentialityStart >= 0
    ? confidentialityTail.search(/第\s*[一二三四五六七八九十百]+条/)
    : -1;
  const confidentialityText = confidentialityStart >= 0
    ? text.slice(confidentialityStart, confidentialityEnd > 0 ? confidentialityStart + confidentialityEnd : text.length).replace(/\s+/g, "")
    : "";
  const missingChecks = [
    ["completeness.termination_right", /甲方[^\n。；;]{0,30}(?:单方解除|有权解除)/, "未发现甲方在乙方根本违约或长期逾期时的单方解除权。", "甲方单方解除权"],
    ["completeness.data_disposition", /(?:数据导出|数据返还|删除确认|账号注销)/, "未发现合同终止后的软件停用、账号注销、数据导出/删除确认条款。", "终止后的软件停用与数据处置"],
    ["completeness.ip_indemnity", /(?:知识产权侵权|第三方.*侵权|侵权.*抗辩)/, "未发现第三方知识产权侵权主张时的抗辩、替换和费用承担责任。", "知识产权不侵权担保责任"],
    // 保密责任条款的措辞很灵活："甲方违反本条保密义务的，应赔偿乙方因此遭受的全部损失。"
    // 中"保密"与"赔偿"相隔较远且中间夹着"义务"，原模式 /保密.{0,100}(?:违约金|赔偿|责任)/
    // 因窗口过窄而漏判，进而产出"未规定违反保密义务的责任后果"——与原文相反。
    ["completeness.confidentiality_remedy", /保密[\s\S]{0,400}?(?:违约金|赔偿|赔偿损失|承担.{0,10}责任|全部损失|损失)/, "保密条款规定了义务和期限，但未规定违反保密义务的责任后果。", "保密义务违约后果", confidentialityText],
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
