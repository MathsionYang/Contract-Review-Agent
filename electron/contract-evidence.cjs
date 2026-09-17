const crypto = require("node:crypto");

function compact(value) { return String(value || "").replace(/\s+/g, ""); }

function resolveRefs(document = {}, query = "", clauseNo = "") {
  const needle = compact(query);
  if (!needle) return [];
  const blocks = document.blocks?.length ? document.blocks : (document.pages?.length ? document.pages : [{ page: 1, text: document.text || "" }]).map((p) => ({
    block_id: `page_${p.page}`, page: document.documentType === "docx" ? null : p.page, logical_page: p.page, text: p.text
  }));
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
      const clause = clauseDefinitions(raw).filter((c) => c.index <= range[0]).at(-1)?.clause_no;
      refs.push({ block_id: block.block_id, page: block.page ?? null, logical_page: block.logical_page ?? block.page ?? null,
        clause_no: clause || block.clause_no || clauseNo || "",
        quote: raw.slice(...range), char_range: range, range_scope: "block",
        text_hash: block.text_hash || `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}` });
    }
  }
  return refs;
}

function clauseDefinitions(text = "") {
  // Exclude version numbers and "第 X 条" references from clause definitions.
  const pattern = /(?<![A-Za-z\d.第])(\d+(?:\.\d+)+)(?![\d.])\s*(?=[\u3400-\u9fff])/g;
  const starts = [...String(text).matchAll(pattern)].filter((m) => (
    !/条/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 1))
    && !/第\s*$/.test(text.slice(Math.max(0, m.index - 5), m.index))
  ));
  const chinese = [...String(text).matchAll(/(?:^|\n)[ \t]*(第[ \t]*[零〇一二三四五六七八九十百千万两\d]+[ \t]*条)(?=[\s、：:]|$)/g)]
    .map((match) => ({ 1: match[1].replace(/\s/g, ""), index: match.index + match[0].indexOf("第") }));
  const definitions = [...starts, ...chinese].sort((a, b) => a.index - b.index);
  return definitions.map((m, i) => ({ clause_no: m[1], index: m.index, text: text.slice(m.index, definitions[i + 1]?.index ?? text.length).trim() }));
}

module.exports = { compact, resolveRefs, clauseDefinitions };
