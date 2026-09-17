const crypto = require("node:crypto");
const { clauseDefinitions, resolveRefs } = require("./contract-evidence.cjs");

const UPPERCASE_DIGITS = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 贰: 2, 两: 2, 三: 3, 叁: 3,
  四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7,
  八: 8, 捌: 8, 九: 9, 玖: 9
};

function hashText(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value || "")).digest("hex")}`;
}

function parseChineseMoney(input) {
  let text = String(input || "").replace(/[人民币元整圆]/g, "").trim();
  if (!text) return null;
  const digit = (char) => UPPERCASE_DIGITS[char];
  let total = 0;
  let section = 0;
  let number = 0;
  const units = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
  for (const char of text) {
    if (digit(char) !== undefined) {
      number = digit(char);
      continue;
    }
    if (units[char]) {
      section += (number || 1) * units[char];
      number = 0;
      continue;
    }
    if (char === "万" || char === "萬") {
      total += (section + number) * 10000;
      section = 0;
      number = 0;
      continue;
    }
    if (char === "亿" || char === "億") {
      total += (section + number) * 100000000;
      section = 0;
      number = 0;
    }
  }
  total += section + number;
  return String(total);
}

function documentBlocks(document = {}) {
  if (Array.isArray(document.blocks) && document.blocks.length) return document.blocks;
  const pages = Array.isArray(document.pages) && document.pages.length
    ? document.pages
    : [{ page: 1, text: String(document.text || "") }];
  return pages.map((page, index) => ({
    block_id: `page_${page.page || index + 1}`,
    source_type: document.extension === ".pdf" ? "pdf" : "document",
    page: Number(page.page || index + 1),
    page_status: "resolved",
    block_type: "page",
    clause_no: "",
    text: String(page.text || ""),
    text_hash: hashText(page.text || "")
  }));
}

function sourceRefs(blocks, rawText) {
  const needle = String(rawText || "").trim();
  const refs = resolveRefs({ blocks }, needle);
  if (refs.length) return refs;
  return [{ block_id: "unresolved", page: null, clause_no: "", quote: needle, text_hash: hashText(needle) }];
}

function clauseMatches(text) {
  const source = String(text || "");
  const pattern = /(?:第\s*[一二三四五六七八九十百千万\d]+\s*条|\d+(?:\.\d+)+)\s*[^\n]*/g;
  const starts = [];
  let match;
  while ((match = pattern.exec(source))) starts.push({ index: match.index, value: match[0] });
  return starts.map((start, index) => {
    const next = starts[index + 1];
    const raw = source.slice(start.index, next ? next.index : source.length).trim();
    const noMatch = raw.match(/^(第\s*[一二三四五六七八九十百千万\d]+\s*条|\d+(?:\.\d+)+)/);
    return {
      clause_no: noMatch ? noMatch[1].replace(/\s+/g, "") : "",
      text: raw
    };
  });
}

function clauseFor(blocks, rawText) {
  const block = blocks.find((item) => String(item.text || "").includes(String(rawText || "").slice(0, 24)));
  return block?.clause_no || (String(rawText || "").match(/^(?:第\s*[^\s]+\s*条|\d+(?:\.\d+)+)/)?.[0] || "").replace(/\s+/g, "");
}

function clauseNoBefore(text, index) {
  return clauseDefinitions(String(text || "")).filter((c) => c.index <= index).at(-1)?.clause_no || "";
}

function addFact(facts, input) {
  const rawText = String(input.raw_text || input.text || "").trim();
  const fact = {
    fact_id: input.fact_id || `fact_${facts.length + 1}`,
    fact_type: input.fact_type,
    raw_text: rawText,
    clause_no: input.clause_no || "",
    value: input.value,
    source_refs: input.source_refs,
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0.86
  };
  for (const [key, value] of Object.entries(input)) {
    if (!["fact_id", "fact_type", "raw_text", "text", "clause_no", "value", "source_refs", "confidence"].includes(key)) fact[key] = value;
  }
  facts.push(fact);
  return fact;
}

function extractContractFacts(document = {}, options = {}) {
  const text = String(document.text || documentBlocks(document).map((block) => block.text).join("\n"));
  const blocks = documentBlocks(document);
  const clauses = clauseMatches(text).map((clause) => ({
    ...clause,
    source_refs: sourceRefs(blocks, clause.text.slice(0, Math.min(clause.text.length, 160)))
  }));
  const facts = [];
  const warnings = [];

  const moneyPatterns = [
    /人民币\s*([壹贰叁肆伍陆柒捌玖零〇一二三四五六七八九拾佰仟萬万亿億元整圆]+)\s*[元圆]/g,
    /(?:¥|￥)\s*([\d,]+(?:\.\d+)?)\s*元?/g,
    /(?:金额|合计|总价款|总价|即人民币)\s*[:：]?\s*([\d,]+(?:\.\d+)?)\s*元/g
  ];
  const seenMoney = new Set();
  for (const pattern of moneyPatterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const raw = match[0];
      const value = /人民币\s*[壹贰叁肆伍陆柒捌玖零〇一二三四五六七八九拾佰仟萬万亿億元整圆]+/.test(raw)
        ? parseChineseMoney(match[1])
        : String(match[1]).replace(/,/g, "");
      if (!value || seenMoney.has(`${value}|${raw}`)) continue;
      seenMoney.add(`${value}|${raw}`);
      addFact(facts, {
        fact_type: "money",
        value,
        currency: "CNY",
        raw_text: raw,
        clause_no: clauseNoBefore(text, match.index) || clauseFor(blocks, raw),
        source_refs: sourceRefs(blocks, raw)
      });
    }
  }

  const ratioPattern = /(\d+(?:\.\d+)?)\s*%/g;
  let ratioMatch;
  while ((ratioMatch = ratioPattern.exec(text))) {
    const raw = ratioMatch[0];
    addFact(facts, {
      fact_type: "ratio",
      value: Number(ratioMatch[1]) / 100,
      raw_text: raw,
      clause_no: clauseNoBefore(text, ratioMatch.index) || clauseFor(blocks, raw),
      source_refs: sourceRefs(blocks, raw)
    });
  }

  const durationPattern = /(\d+)\s*个?\s*(工作日|自然日|日|年|个月)/g;
  let durationMatch;
  while ((durationMatch = durationPattern.exec(text))) {
    const calendarType = durationMatch[2] === "工作日" ? "workday" : durationMatch[2] === "年" ? "year" : durationMatch[2] === "个月" ? "month" : "calendar_day";
    const raw = durationMatch[0];
    addFact(facts, {
      fact_type: "duration",
      value: Number(durationMatch[1]),
      unit: durationMatch[2],
      calendar_type: calendarType,
      raw_text: raw,
      clause_no: clauseNoBefore(text, durationMatch.index) || clauseFor(blocks, raw),
      source_refs: sourceRefs(blocks, raw)
    });
  }

  const addPartyFact = (input) => {
    const address = String(input.address || "");
    const regions = address.match(/湖南|湖北|广东|浙江|江苏|北京|上海|天津|重庆/g) || [];
    const ambiguous = regions.length > 1 || /联系方式|联系电话|收件人|目录/.test(address);
    const fact = addFact(facts, { ...input, ...(ambiguous ? { confidence: 0.4 } : {}) });
    if (ambiguous) warnings.push({
      code: "PARTY_ADDRESS_SEGMENTATION_UNCERTAIN",
      message: "地址候选可能合并了多个地址或相邻字段，需按原文表格或版面核验。",
      fact_id: fact.fact_id,
      source_refs: fact.source_refs
    });
  };
  const partyPattern = /(甲方|乙方)\s*[：:]\s*([^，。\n;；]+)(?:[，,]\s*地址\s*[：:]\s*([^，。；;\n]+))?/g;
  let partyMatch;
  while ((partyMatch = partyPattern.exec(text))) {
    const partyId = partyMatch[1];
    const value = partyMatch[2].trim();
    const addressMatch = partyMatch[3] || value.match(/((?:湖南|湖北|广东|浙江|江苏|北京|上海|天津|重庆)[^，。；;]+)/)?.[1] || "";
    addPartyFact({
      fact_type: "party",
      party_id: partyId,
      name: value.replace(/地址.*$/, "").trim(),
      address: addressMatch || value,
      raw_text: partyMatch[0],
      source_refs: sourceRefs(blocks, partyMatch[0])
    });
  }
  for (const addressMatch of text.matchAll(/((?:湖南|湖北|广东|浙江|江苏|北京|上海|天津|重庆)[^，。；;\n]+)/g)) {
    const existing = facts.find((fact) => fact.fact_type === "party" && fact.address === addressMatch[1]);
    if (!existing) addPartyFact({ fact_type: "party", party_id: "unknown", name: "", address: addressMatch[1], raw_text: addressMatch[0], source_refs: sourceRefs(blocks, addressMatch[0]) });
  }

  const obligationPattern = /(甲方|乙方)\s*(?:(?:应|须)?\s*(?:向|给)\s*(甲方|乙方)|(?:应|须|负责))\s*([^。；;\n]{2,100})/g;
  let obligationMatch;
  while ((obligationMatch = obligationPattern.exec(text))) {
    const raw = obligationMatch[0];
    const clauseNo = clauseNoBefore(text, obligationMatch.index) || clauseFor(blocks, raw) || "";
    addFact(facts, {
      fact_type: "obligation",
      subject: obligationMatch[1],
      object_party: obligationMatch[2] || "",
      action: obligationMatch[3].trim(),
      raw_text: raw,
      clause_no: clauseNo,
      source_refs: sourceRefs(blocks, raw)
    });
  }

  const penaltyPattern = /([^。；;\n]{0,90}(?:违约金|赔偿)[^。；;\n]{0,130})/g;
  let penaltyMatch;
  while ((penaltyMatch = penaltyPattern.exec(text))) {
    const raw = penaltyMatch[1].trim();
    const contentIndex = penaltyMatch.index + penaltyMatch[1].indexOf(raw);
    const rateMatch = raw.match(/(万分之[一二三四五六七八九十]+|\d+(?:\.\d+)?\s*%)/);
    const fixedMatch = raw.match(/(?:人民币|¥|￥)\s*([\d,]+(?:\.\d+)?)\s*元?/);
    const anchor = rateMatch || fixedMatch || raw.match(/违约金|赔偿/);
    addFact(facts, {
      fact_type: "penalty",
      rate_basis: rateMatch ? rateMatch[1].replace(/\s+/g, "") : "",
      fixed_amount: fixedMatch ? fixedMatch[1].replace(/,/g, "") : "",
      references: [...raw.matchAll(/第\s*([\d.]+)\s*条/g)].map((match) => match[1]),
      raw_text: raw,
      clause_no: clauseNoBefore(text, contentIndex + (anchor?.index || 0)) || clauseFor(blocks, raw) || "",
      source_refs: sourceRefs(blocks, raw)
    });
  }

  if (!clauses.length) warnings.push({ code: "CLAUSE_SEGMENTATION_EMPTY", message: "未能从合同文本识别条款编号" });
  if (!blocks.some((block) => block.page !== null && block.page !== undefined)) warnings.push({ code: "PAGE_LOCATION_UNRESOLVED", message: "当前文档没有可靠物理页码，使用逻辑块定位" });
  return { facts, clauses, warnings, blocks, text, contractType: options.contractType || "" };
}

module.exports = { extractContractFacts, parseChineseMoney };
