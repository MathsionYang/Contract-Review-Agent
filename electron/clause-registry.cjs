const crypto = require("node:crypto");
const { clauseDefinitions, normalizeClauseNo } = require("./contract-evidence.cjs");

function hashText(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value || "")).digest("hex")}`;
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
    block_type: "page",
    clause_no: "",
    text: String(page.text || ""),
    text_hash: hashText(page.text || "")
  }));
}

function rangeForDefinition(raw, start, end) {
  let from = Math.max(0, Number(start) || 0);
  let to = Math.min(String(raw || "").length, Number(end) || String(raw || "").length);
  while (from < to && /\s/.test(raw[from])) from += 1;
  while (to > from && /\s/.test(raw[to - 1])) to -= 1;
  return [from, to];
}

function entryFor(block, raw, clauseNo, range, sequence, heading = "") {
  const charRange = rangeForDefinition(raw, range[0], range[1]);
  const quote = raw.slice(charRange[0], charRange[1]);
  const normalized = normalizeClauseNo(clauseNo);
  const instanceId = `clause_${sequence}_${crypto.createHash("sha1")
    .update(`${block.block_id}|${charRange.join(":")}|${normalized}|${quote}`)
    .digest("hex").slice(0, 12)}`;
  return {
    clause_instance_id: instanceId,
    clause_no: normalized,
    heading: heading || quote.split(/\r?\n/)[0].trim().slice(0, 160),
    block_id: block.block_id,
    page: block.page ?? null,
    logical_page: block.logical_page ?? block.page ?? null,
    char_range: charRange,
    quote,
    text_hash: block.text_hash || hashText(raw)
  };
}

function buildClauseRegistry(document = {}) {
  const entries = [];
  let sequence = 0;
  for (const block of documentBlocks(document)) {
    const raw = String(block.text || "");
    if (!raw.trim()) continue;
    const definitions = clauseDefinitions(raw);
    if (definitions.length) {
      definitions.forEach((definition, index) => {
        const next = definitions[index + 1];
        entries.push(entryFor(block, raw, definition.clause_no,
          [definition.index, next?.index ?? raw.length], sequence += 1, definition.text.split(/\r?\n/)[0]));
      });
      continue;
    }
    if (block.clause_no) {
      entries.push(entryFor(block, raw, block.clause_no,
        Array.isArray(block.char_range) && block.char_range.length === 2 ? [0, raw.length] : [0, raw.length], sequence += 1));
    }
  }
  const byNumber = new Map();
  const byBlockId = new Map();
  for (const entry of entries) {
    const list = byNumber.get(entry.clause_no) || [];
    list.push(entry);
    byNumber.set(entry.clause_no, list);
    const blockEntries = byBlockId.get(entry.block_id) || [];
    blockEntries.push(entry);
    byBlockId.set(entry.block_id, blockEntries);
  }
  return { entries, byNumber, byBlockId };
}

function resolveEvidenceRange(document = {}, input = {}) {
  const registry = buildClauseRegistry(document);
  const blockId = String(input.block_id || input.blockId || "");
  const clauseNo = normalizeClauseNo(input.clause_no || input.clauseNo || "");
  const charRange = input.char_range || input.charRange;
  const quote = String(input.quote || "");
  let candidates = registry.entries.filter((entry) => (!blockId || entry.block_id === blockId)
    && (!clauseNo || entry.clause_no === clauseNo));
  if (Array.isArray(charRange) && charRange.length === 2) {
    candidates = candidates.filter((entry) => entry.char_range[0] <= Number(charRange[0])
      && entry.char_range[1] >= Number(charRange[1]));
  }
  if (quote) candidates = candidates.filter((entry) => entry.quote.includes(quote) || quote.includes(entry.quote));
  return candidates.length === 1 ? candidates[0] : null;
}

function extractReferenceEdges(document = {}) {
  const registry = buildClauseRegistry(document);
  const edges = [];
  for (const entry of registry.entries) {
    const refs = [...entry.quote.matchAll(/(?:第\s*)?(\d+(?:\.\d+)+)\s*条/g)];
    for (const match of refs) {
      const targetClauseNo = normalizeClauseNo(match[1]);
      const localStart = Math.max(0, match.index - 48);
      const localEnd = Math.min(entry.quote.length, match.index + match[0].length + 48);
      const quote = entry.quote.slice(localStart, localEnd).trim();
      const target = registry.byNumber.get(targetClauseNo)?.[0] || null;
      edges.push({
        reference_id: `reference_${edges.length + 1}`,
        from_ref: { block_id: entry.block_id, clause_no: entry.clause_no, char_range: entry.char_range, quote: entry.quote },
        target_ref: target ? { block_id: target.block_id, clause_no: target.clause_no, char_range: target.char_range, quote: target.quote } : null,
        from_clause_no: entry.clause_no,
        target_clause_no: targetClauseNo,
        target_exists: Boolean(target),
        char_range: [entry.char_range[0] + localStart, entry.char_range[0] + localEnd],
        quote
      });
    }
  }
  return edges;
}

module.exports = { buildClauseRegistry, extractReferenceEdges, resolveEvidenceRange, documentBlocks };
