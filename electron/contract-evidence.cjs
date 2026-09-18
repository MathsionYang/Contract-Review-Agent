const crypto = require("node:crypto");

function compact(value) { return String(value || "").replace(/\s+/g, ""); }

function normalizeClauseNo(value) {
  return String(value || "").replace(/\s+/g, "").replace(/^第/, "").replace(/条$/, "");
}

function documentBlocks(document = {}) {
  if (Array.isArray(document.blocks) && document.blocks.length) return document.blocks;
  const pages = Array.isArray(document.pages) && document.pages.length
    ? document.pages
    : [{ page: 1, text: String(document.text || "") }];
  return pages.map((page, index) => ({
    block_id: `page_${page.page || index + 1}`,
    page: document.documentType === "docx" ? null : (page.page || index + 1),
    logical_page: page.page || index + 1,
    text: String(page.text || "")
  }));
}

function trimmedRange(raw, start, end) {
  let rangeStart = Math.max(0, start);
  let rangeEnd = Math.min(String(raw || "").length, end);
  while (rangeStart < rangeEnd && /\s/.test(raw[rangeStart])) rangeStart += 1;
  while (rangeEnd > rangeStart && /\s/.test(raw[rangeEnd - 1])) rangeEnd -= 1;
  return [rangeStart, rangeEnd];
}

function refForRange(block, raw, range, clauseNo = "") {
  const [start, end] = range;
  const quote = String(raw || "").slice(start, end);
  return {
    block_id: block.block_id,
    page: block.page ?? null,
    logical_page: block.logical_page ?? block.page ?? null,
    clause_no: normalizeClauseNo(clauseNo || block.clause_no || ""),
    quote,
    char_range: [start, end],
    range_scope: "block",
    text_hash: block.text_hash || `sha256:${crypto.createHash("sha256").update(String(raw || "")).digest("hex")}`
  };
}

function resolveClauseRefs(document = {}, clauseNo = "") {
  const target = normalizeClauseNo(clauseNo);
  if (!target) return [];
  // Keep the legacy API, but resolve through the shared registry so quoted
  // headings and repeated clause numbers use the same clause instances.
  try {
    const { buildClauseRegistry } = require("./clause-registry.cjs");
    const blocks = documentBlocks(document);
    const entries = buildClauseRegistry(document).byNumber.get(target) || [];
    if (entries.length) return entries.map((entry) => {
      const block = blocks.find((item) => item.block_id === entry.block_id) || { text: entry.quote };
      return refForRange(block, String(block.text || ""), entry.char_range, entry.clause_no);
    });
  } catch (_error) {
    // During module initialization the registry may not be available yet;
    // retain the local fallback below for backwards compatibility.
  }
  const refs = [];
  for (const block of documentBlocks(document)) {
    const raw = String(block.text || "");
    const definitions = clauseDefinitions(raw);
    const definitionIndex = definitions.findIndex((item) => normalizeClauseNo(item.clause_no) === target);
    if (definitionIndex >= 0) {
      const definition = definitions[definitionIndex];
      const next = definitions[definitionIndex + 1];
      const range = trimmedRange(raw, definition.index, next?.index ?? raw.length);
      refs.push(refForRange(block, raw, range, target));
      continue;
    }
    if (normalizeClauseNo(block.clause_no) === target) {
      refs.push(refForRange(block, raw, trimmedRange(raw, 0, raw.length), target));
    }
  }
  return refs;
}

function extractClauseReferences(text = "") {
  const source = String(text || "");
  const definitions = clauseDefinitions(source);
  const edges = [];
  // 只把带小数层级的合同条款作为内部引用，避免把“第 585 条民法典”等外部法条误判为合同缺失条款。
  const pattern = /(?:第\s*)?(\d+\.\d+(?:\.\d+)*)\s*条/g;
  let match;
  while ((match = pattern.exec(source))) {
    const targetClauseNo = normalizeClauseNo(match[1]);
    const from = definitions.filter((item) => item.index < match.index).at(-1);
    const contextStart = Math.max(from?.index ?? 0, match.index - 48);
    const contextEnd = Math.min(source.length, match.index + match[0].length + 48);
    edges.push({
      reference_id: `reference_${edges.length + 1}`,
      from_clause_no: normalizeClauseNo(from?.clause_no || ""),
      target_clause_no: targetClauseNo,
      quote: source.slice(contextStart, contextEnd).trim(),
      char_range: [contextStart, contextEnd],
      target_exists: definitions.some((item) => normalizeClauseNo(item.clause_no) === targetClauseNo)
    });
  }
  return edges;
}

function resolveRefs(document = {}, query = "", clauseNo = "") {
  const needle = compact(query);
  if (!needle) return clauseNo ? resolveClauseRefs(document, clauseNo) : [];
  const blocks = documentBlocks(document);
  const refs = [];
  for (const block of blocks) {
    const raw = String(block.text || "");
    const map = [];
    let normalized = "";
    for (let i = 0; i < raw.length; i += 1) {
      if (!/\s/.test(raw[i])) { map.push(i); normalized += raw[i]; }
    }
    for (let start = normalized.indexOf(needle); start >= 0; start = normalized.indexOf(needle, start + needle.length)) {
      const range = [map[start], map[start + needle.length - 1] + 1];
      const clause = clauseDefinitions(raw).filter((c) => c.index <= range[0]).at(-1)?.clause_no
        || block.clause_no || clauseNo;
      if (clauseNo && normalizeClauseNo(clause) !== normalizeClauseNo(clauseNo)) continue;
      refs.push({ block_id: block.block_id, page: block.page ?? null, logical_page: block.logical_page ?? block.page ?? null,
        clause_no: clause || block.clause_no || clauseNo || "",
        quote: raw.slice(...range), char_range: range, range_scope: "block",
        text_hash: block.text_hash || `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}` });
    }
  }
  return refs;
}

function clauseDefinitions(text = "") {
  // A clause heading may be followed by whitespace, quotes, brackets or a
  // colon. Numeric amounts and versions are excluded by requiring a heading
  // marker followed by a non-numeric heading character.
  const numericCandidates = [...String(text).matchAll(/(?<![A-Za-z\d.第])(\d+(?:\.\d+)+)(?![\d.])/g)];
  const starts = numericCandidates.filter((m) => {
    const tail = String(text).slice(m.index + m[0].length, m.index + m[0].length + 16);
    const headingTail = tail.match(/^\s*(?:[“”"'‘’「」『』()（）【】\[\]]\s*)*(?:[：:、.]\s*)?[\u3400-\u9fff]/);
    const before = String(text).slice(Math.max(0, m.index - 6), m.index);
    return Boolean(headingTail) && !/第\s*$/.test(before);
  });
  const chinese = [...String(text).matchAll(/(?:^|\n)[ \t]*(第[ \t]*[零〇一二三四五六七八九十百千万两\d]+[ \t]*条)(?=[\s、：:]|$)/g)]
    .map((match) => ({ 1: match[1].replace(/\s/g, ""), index: match.index + match[0].indexOf("第") }));
  const definitions = [...starts, ...chinese].sort((a, b) => a.index - b.index);
  return definitions.map((m, i) => ({ clause_no: m[1], index: m.index, text: text.slice(m.index, definitions[i + 1]?.index ?? text.length).trim() }));
}

module.exports = {
  compact,
  resolveRefs,
  resolveClauseRefs,
  extractClauseReferences,
  normalizeClauseNo,
  clauseDefinitions
};
