const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_PAGE_COUNT = 300;

function parserError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function splitPages(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const pages = normalized.split("\f");
  return pages.length ? pages : [""];
}

function textHash(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value || "")).digest("hex")}`;
}

function decodeHtmlText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function inferClauseNo(value) {
  const match = String(value || "").trim().match(/^(?:第\s*[一二三四五六七八九十百千万\d]+\s*条|\d+(?:\.\d+)+(?=\s*[\u3400-\u9fff]))/);
  return match ? match[0].replace(/\s+/g, "") : "";
}

function docxBlocksFromHtml(html, text) {
  const blocks = [];
  const source = String(html || "");
  const fullText = String(text || "");
  const sourceOffsets = [];
  let normalizedText = "";
  for (const match of fullText.matchAll(/\s+|\S/g)) {
    normalizedText += /\s/.test(match[0]) ? " " : match[0];
    sourceOffsets.push(match.index);
  }
  let normalizedCursor = 0;
  let order = 0;
  let currentClause = "";
  const append = (input = {}) => {
    const blockText = String(input.text || "").trim();
    if (!blockText) return;
    const normalizedBlock = blockText.replace(/\s+/g, " ");
    const start = normalizedText.indexOf(normalizedBlock, normalizedCursor);
    // Match normalized text, but store offsets into the original document text.
    const charRange = start >= 0
      ? [sourceOffsets[start], sourceOffsets[start + normalizedBlock.length - 1] + 1]
      : null;
    const clauseNo = input.clause_no || inferClauseNo(blockText) || currentClause;
    if (clauseNo) currentClause = clauseNo;
    blocks.push({
      block_id: `docx_block_${++order}`,
      source_type: "docx",
      page: null,
      logical_page: 1,
      page_status: "unresolved",
      block_type: input.block_type || "paragraph",
      clause_no: clauseNo,
      text: blockText,
      char_range: charRange,
      text_hash: textHash(blockText),
      ...(input.table_ref ? { table_ref: input.table_ref } : {})
    });
    if (start >= 0) normalizedCursor = start + normalizedBlock.length;
  };

  const tokenPattern = /<table\b[\s\S]*?<\/table\s*>|<(p|h[1-6])\b[\s\S]*?<\/\1\s*>/gi;
  let token;
  while ((token = tokenPattern.exec(source))) {
    const value = token[0];
    if (/^<table\b/i.test(value)) {
      const tableId = `table_${order + 1}`;
      let row = -1;
      const rowPattern = /<tr\b[\s\S]*?<\/tr\s*>/gi;
      let rowMatch;
      while ((rowMatch = rowPattern.exec(value))) {
        row += 1;
        let column = -1;
        const cellPattern = /<(td|th)\b[\s\S]*?<\/\1\s*>/gi;
        let cellMatch;
        while ((cellMatch = cellPattern.exec(rowMatch[0]))) {
          column += 1;
          append({
            block_type: "table_cell",
            text: decodeHtmlText(cellMatch[0]),
            table_ref: { table_id: tableId, row, column }
          });
        }
      }
      continue;
    }
    append({
      block_type: /^<h[1-6]/i.test(value) ? "heading" : "paragraph",
      text: decodeHtmlText(value)
    });
  }
  if (!blocks.length && fullText.trim()) {
    append({ block_type: "paragraph", text: fullText.trim() });
  }
  return blocks;
}

function baseDocumentMetadata(filePath, buffer) {
  const extension = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);
  const mimeType = extension === ".pdf"
    ? "application/pdf"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return {
    fileName,
    extension,
    mimeType,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    sizeBytes: buffer.length
  };
}

async function parseDocx(filePath, buffer) {
  const mammoth = require("mammoth");
  const result = await mammoth.extractRawText({ path: filePath });
  const htmlResult = await mammoth.convertToHtml({ path: filePath });
  const text = String(result.value || "").trim();
  const pageTexts = splitPages(text);
  if (pageTexts.length > MAX_PAGE_COUNT) {
    throw parserError("PAGE_LIMIT_EXCEEDED", `合同页数超过 ${MAX_PAGE_COUNT} 页限制`);
  }
  return {
    ...baseDocumentMetadata(filePath, buffer),
    documentType: "docx",
    pageCount: pageTexts.length,
    pages: pageTexts.map((pageText, index) => ({
      page: index + 1,
      text: pageText,
      ocr: { status: "not_required" }
    })),
    blocks: docxBlocksFromHtml(htmlResult.value, text),
    text,
    parseMessages: [
      ...(Array.isArray(result.messages) ? result.messages : []),
      ...(Array.isArray(htmlResult.messages) ? htmlResult.messages : [])
    ],
    ocr: { status: "not_required" }
  };
}

async function loadPdfJs() {
  // pdfjs-dist 6 使用 ESM，主进程通过动态导入保持 CommonJS 工程兼容。
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

async function parsePdf(filePath, buffer) {
  const pdfjs = await loadPdfJs();
  const standardFontDirectory = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    useWorkerFetch: false,
    isEvalSupported: false,
    standardFontDataUrl: `${standardFontDirectory.split(path.sep).join("/")}/`
  });
  const pdf = await loadingTask.promise;
  if (pdf.numPages > MAX_PAGE_COUNT) {
    throw parserError("PAGE_LIMIT_EXCEEDED", `合同页数超过 ${MAX_PAGE_COUNT} 页限制`);
  }

  const pages = [];
  const blocks = [];
  let textCursor = 0;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => item.str || "")
      .join(" ")
      .replace(/[ \t]+/g, " ")
      .trim();
    const viewport = page.getViewport({ scale: 1 });
    const start = text ? textCursor : -1;
    if (text) textCursor += text.length + 2;
    blocks.push({
      block_id: `pdf_page_${pageNumber}`,
      source_type: "pdf",
      page: pageNumber,
      logical_page: pageNumber,
      page_status: "resolved",
      block_type: "page",
      clause_no: inferClauseNo(text),
      text,
      bbox: [0, 0, viewport.width, viewport.height],
      char_range: start >= 0 ? [start, start + text.length] : null,
      text_hash: textHash(text)
    });
    pages.push({
      page: pageNumber,
      text,
      ocr: text ? { status: "not_required" } : {
        status: "unavailable",
        reason: "页面没有可提取的文本层，当前版本未内置 OCR 引擎"
      }
    });
  }

  const text = pages.map((page) => page.text).filter(Boolean).join("\n\n");
  const searchable = Boolean(text);
  return {
    ...baseDocumentMetadata(filePath, buffer),
    documentType: searchable ? "searchable_pdf" : "scanned_pdf",
    pageCount: pdf.numPages,
    pages,
    blocks,
    text,
    ocr: searchable
      ? { status: "not_required" }
      : { status: "unavailable", reason: "当前版本未内置 OCR 引擎" }
  };
}

async function parseContract(filePath, options = {}) {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  if (![".docx", ".pdf"].includes(extension)) {
    throw parserError("UNSUPPORTED_FILE_TYPE", "仅支持 DOCX 和 PDF 合同文件");
  }

  if (!filePath || !fs.existsSync(filePath)) {
    throw parserError("FILE_NOT_FOUND", "合同文件不存在");
  }
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw parserError("NOT_A_FILE", "选择的路径不是普通文件");

  const maxFileSize = Number.isFinite(options.maxFileSize) ? options.maxFileSize : MAX_FILE_SIZE;
  if (stats.size > maxFileSize) {
    throw parserError("FILE_SIZE_LIMIT_EXCEEDED", `合同文件不能超过 ${Math.floor(maxFileSize / 1024 / 1024)} MB`);
  }
  const buffer = fs.readFileSync(filePath);
  return extension === ".docx"
    ? parseDocx(filePath, buffer)
    : parsePdf(filePath, buffer);
}

module.exports = { parseContract, MAX_FILE_SIZE, MAX_PAGE_COUNT };
