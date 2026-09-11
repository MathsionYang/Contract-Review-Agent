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
    text,
    parseMessages: Array.isArray(result.messages) ? result.messages : [],
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
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => item.str || "")
      .join(" ")
      .replace(/[ \t]+/g, " ")
      .trim();
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
