const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_KNOWLEDGE_FILE_SIZE = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".docx", ".pdf", ".md", ".txt", ".json"]);
const SOURCE_TYPES = {
  rules: "deterministic_rule",
  policies: "enterprise_policy",
  legalSnapshots: "legal_snapshot"
};
const KEYWORD_DICTIONARY = [
  "完成后方可申请付款",
  "需要专项审批",
  "授权代表签字",
  "不得超过",
  "预付款",
  "验收",
  "比例",
  "超过时",
  "交付日期",
  "签署日期",
  "付款",
  "合同",
  "责任",
  "期限",
  "日期"
];

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function mimeTypeFor(extension) {
  return {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".md": "text/markdown",
    ".txt": "text/plain"
  }[extension] || "application/octet-stream";
}

function validateKnowledgeFile(filePath, kind, options = {}) {
  if (!["rules", "policies", "legalSnapshots"].includes(kind)) {
    throw createError("KNOWLEDGE_KIND_INVALID", "知识文件类型无效");
  }
  if (!filePath || !fs.existsSync(filePath)) {
    throw createError("KNOWLEDGE_FILE_NOT_FOUND", "知识文件不存在");
  }
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw createError("KNOWLEDGE_NOT_A_FILE", "知识文件路径不是普通文件");
  const extension = path.extname(filePath).toLowerCase();
  const allowedExtensions = new Set(options.allowedExtensions || ALLOWED_EXTENSIONS);
  if (!allowedExtensions.has(extension)) {
    throw createError("KNOWLEDGE_FILE_INVALID", `不支持的知识文件类型：${extension || "无扩展名"}`);
  }
  const maxFileSize = Number.isFinite(options.maxFileSize) ? options.maxFileSize : MAX_KNOWLEDGE_FILE_SIZE;
  if (stats.size > maxFileSize) {
    throw createError("KNOWLEDGE_FILE_INVALID", `知识文件不能超过 ${Math.floor(maxFileSize / 1024 / 1024)} MB`);
  }
  return {
    filePath: path.resolve(filePath),
    fileName: path.basename(filePath),
    extension,
    mimeType: mimeTypeFor(extension),
    size: stats.size,
    sha256: sha256File(filePath)
  };
}

function clauseHeading(line) {
  const value = String(line || "").trim().replace(/^#+\s*/, "");
  const legalHeading = value.match(/^(第[零〇一二三四五六七八九十百千万两\d]+条)\s*(.*)$/);
  if (legalHeading) return { clause_no: legalHeading[1], title: legalHeading[2].trim() || legalHeading[1] };
  let match = value.match(/^第\s*([0-9]+(?:\.[0-9]+)+)\s*(?:条|节)?\s*(.*)$/);
  if (!match) match = value.match(/^([0-9]+(?:\.[0-9]+)+)\s*[、.．]?\s*(.*)$/);
  if (!match) match = value.match(/^([A-Z]{1,4}-\d+)\s*[、.．]?\s*(.*)$/i);
  if (!match) return null;
  const clauseNo = match[1].trim();
  const title = match[2].replace(/^[：:、\s]+/, "").trim();
  if (!title) return null;
  return { clause_no: clauseNo, title };
}

function tokenizeChinese(text) {
  const value = String(text || "").replace(/\s+/g, "").trim();
  if (!value) return [];
  const matches = [];
  const dictionary = [...KEYWORD_DICTIONARY].sort((a, b) => b.length - a.length);
  let index = 0;
  while (index < value.length) {
    const numberMatch = value.slice(index).match(/^\d+(?:\.\d+)?%?/);
    if (numberMatch) {
      matches.push(numberMatch[0]);
      index += numberMatch[0].length;
      continue;
    }
    const word = dictionary.find((candidate) => value.startsWith(candidate, index));
    if (word) {
      matches.push(word);
      index += word.length;
      continue;
    }
    const punctuation = value[index].match(/[，。；：:、,.!?！？()（）\[\]{}“”"'‘’]/);
    if (punctuation) {
      index += 1;
      continue;
    }
    let next = index + 1;
    while (next < value.length && !/[，。；：:、,.!?！？()（）\[\]{}“”"'‘’\d]/.test(value[next])) next += 1;
    const chunk = value.slice(index, next);
    if (chunk.length >= 2) matches.push(chunk);
    index = next;
  }
  return [...new Set(matches)];
}

function extractKnowledgeClauses(text, _kind = "policies") {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const clauses = [];
  let current = null;
  for (const line of lines) {
    const heading = clauseHeading(line);
    if (heading) {
      if (current) clauses.push(current);
      current = { ...heading, lines: [] };
      continue;
    }
    if (!current) current = { clause_no: "全文", title: "全文", lines: [] };
    current.lines.push(line);
  }
  if (current) clauses.push(current);
  return clauses.map((clause) => {
    const clauseText = clause.lines.join(" ").replace(/\s+/g, " ").trim();
    const sourceText = `${clause.title} ${clauseText}`.trim();
    return {
      clause_no: clause.clause_no,
      title: clause.title,
      text: clauseText || clause.title,
      keywords: tokenizeChinese(sourceText)
    };
  });
}

function buildKnowledgeItem(input = {}) {
  const kind = input.kind || input.type || "policies";
  const sourceType = SOURCE_TYPES[kind] || "enterprise_policy";
  const fileName = String(input.fileName || input.file || "未命名知识文件").trim();
  const sha256 = String(input.sha256 || "").trim();
  const fileVersionId = String(input.fileVersionId || input.file_version_id || `${kind}_${(sha256 || fileName).replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 32)}`);
  const clauses = Array.isArray(input.clauses) && input.clauses.length
    ? input.clauses.map((clause) => ({
      clause_no: String(clause.clause_no || clause.clauseNo || "全文"),
      title: String(clause.title || "全文"),
      text: String(clause.text || clause.excerpt || "").trim(),
      keywords: Array.isArray(clause.keywords) ? clause.keywords : tokenizeChinese(`${clause.title || ""} ${clause.text || clause.excerpt || ""}`)
    }))
    : extractKnowledgeClauses(input.text || input.content || "", kind);
  return {
    ...input,
    file: fileName,
    file_name: fileName,
    source_type: sourceType,
    source_id: String(input.sourceId || input.source_id || fileVersionId),
    file_version_id: fileVersionId,
    source_path_ref: String(input.sourcePathRef || input.source_path_ref || ""),
    summary: String(input.summary || "").trim(),
    version: String(input.version || "v1.0").trim(),
    selected: Boolean(input.selected),
    parse_status: input.parseStatus || input.parse_status || "parsed",
    size: Number(input.size ?? input.sizeBytes ?? 0),
    sha256,
    clauses
  };
}

function sourceMatchesQuery(clause, query) {
  const queryText = String(query || "").trim();
  if (!queryText) return 0;
  const haystack = `${clause.title || ""} ${clause.text || ""} ${(clause.keywords || []).join(" ")}`.toLowerCase();
  const queryTokens = tokenizeChinese(queryText);
  const exact = haystack.includes(queryText.toLowerCase()) ? 1 : 0;
  const matched = queryTokens.filter((token) => haystack.includes(token.toLowerCase())).length;
  return exact + (queryTokens.length ? matched / queryTokens.length : 0);
}

function searchKnowledgeSources(sources = [], query, options = {}) {
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0.2;
  const hits = [];
  for (const rawSource of sources) {
    const source = buildKnowledgeItem(rawSource);
    if (source.selected === false || source.parse_status === "failed") continue;
    for (const clause of source.clauses || []) {
      const score = sourceMatchesQuery(clause, query);
      if (score < minScore) continue;
      hits.push({
        source_id: source.source_id,
        source_type: source.source_type,
        file_name: source.file_name,
        file_version_id: source.file_version_id,
        version: source.version,
        snapshot_id: source.source_type === "legal_snapshot" ? source.id : undefined,
        clause_no: clause.clause_no,
        clause_title: clause.title,
        excerpt: clause.text,
        score: Number(score.toFixed(4))
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, options.limit || 10);
}

async function parseKnowledgeFile(filePath, kind, options = {}) {
  const metadata = validateKnowledgeFile(filePath, kind, options);
  const extension = metadata.extension;
  try {
    let text = "";
    let clauses = [];
    let pages = [];
    if (extension === ".docx" || extension === ".pdf") {
      // 合同解析器已经处理 DOCX/PDF 文本层，这里复用相同的安全边界和页信息。
      const { parseContract } = require("./parser.cjs");
      const parsed = await parseContract(metadata.filePath);
      text = parsed.text || "";
      pages = parsed.pages || [];
    } else if (extension === ".json") {
      const payload = JSON.parse(fs.readFileSync(metadata.filePath, "utf8"));
      if (Array.isArray(payload)) clauses = payload;
      else if (Array.isArray(payload.clauses)) clauses = payload.clauses;
      text = typeof payload === "string" ? payload : String(payload.text || payload.content || "");
      if (!text && clauses.length) text = clauses.map((clause) => `${clause.clause_no || ""} ${clause.title || ""}\n${clause.text || clause.excerpt || ""}`).join("\n");
    } else {
      text = fs.readFileSync(metadata.filePath, "utf8");
    }
    const normalizedClauses = clauses.length ? clauses : extractKnowledgeClauses(text, kind);
    return {
      ...metadata,
      text: String(text || "").trim(),
      pages,
      clauses: normalizedClauses,
      parseStatus: "parsed"
    };
  } catch (error) {
    const wrapped = createError("KNOWLEDGE_PARSE_FAILED", `知识文件解析失败：${metadata.fileName}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

async function parseLegalSnapshotFile(filePath, options = {}) {
  const metadata = validateKnowledgeFile(filePath, "legalSnapshots", {
    ...options,
    allowedExtensions: [".json", ".md", ".txt"]
  });
  try {
    const raw = fs.readFileSync(metadata.filePath, "utf8").replace(/^\uFEFF/, "");
    let payload;
    if (metadata.extension === ".json") payload = JSON.parse(raw);
    else payload = { id: `LOCAL-${metadata.sha256.slice(0, 16)}`, name: path.basename(metadata.fileName, metadata.extension), status: "draft", coverage: "待填写", text: raw };
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !String(payload.id || "").trim() || !String(payload.name || "").trim()) {
      throw createError("LEGAL_SNAPSHOT_INVALID", "法律快照缺少 id 或 name");
    }
    const clauses = Array.isArray(payload.clauses) && payload.clauses.length
      ? payload.clauses.map((clause) => ({
        clause_no: String(clause.clause_no || clause.clauseNo || "全文"),
        title: String(clause.title || clause.clause_title || "全文"),
        text: String(clause.text || clause.excerpt || "").trim(),
        keywords: Array.isArray(clause.keywords) ? clause.keywords : tokenizeChinese(`${clause.title || ""} ${clause.text || clause.excerpt || ""}`)
      }))
      : extractKnowledgeClauses(payload.text || payload.content || "", "legalSnapshots");
    if (!clauses.length || clauses.some((clause) => !clause.text.trim())) {
      throw createError("LEGAL_SNAPSHOT_INVALID", "法律快照必须包含非空条款正文（clauses、text 或 content）");
    }
    const status = String(payload.status || "draft");
    if (!["published", "draft", "historical", "superseded", "revoked"].includes(status)) {
      throw createError("LEGAL_SNAPSHOT_INVALID", "法律快照状态无效");
    }
    if (payload.sources !== undefined && (!Number.isInteger(Number(payload.sources)) || Number(payload.sources) < 0)) {
      throw createError("LEGAL_SNAPSHOT_INVALID", "法律来源数必须是非负整数");
    }
    return {
      id: String(payload.id).trim(),
      name: String(payload.name).trim(),
      status,
      coverage: String(payload.coverage || "").trim(),
      sources: Number.isInteger(Number(payload.sources)) ? Number(payload.sources) : clauses.length,
      publishedAt: String(payload.publishedAt || payload.published_at || ""),
      source_url: String(payload.source_url || payload.sourceUrl || ""),
      hash: `sha256:${metadata.sha256}`,
      fileName: metadata.fileName,
      sourcePath: metadata.filePath,
      fileVersionId: `legal_snapshot_${metadata.sha256.slice(0, 16)}`,
      clauses,
      parseStatus: "parsed"
    };
  } catch (error) {
    if (error.code === "LEGAL_SNAPSHOT_INVALID") throw error;
    const wrapped = createError("LEGAL_SNAPSHOT_INVALID", `法律快照解析失败：${metadata.fileName}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

module.exports = {
  ALLOWED_EXTENSIONS,
  MAX_KNOWLEDGE_FILE_SIZE,
  buildKnowledgeItem,
  extractKnowledgeClauses,
  parseLegalSnapshotFile,
  parseKnowledgeFile,
  searchKnowledgeSources,
  sourceMatchesQuery,
  validateKnowledgeFile
};
