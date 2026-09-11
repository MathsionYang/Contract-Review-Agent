const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Document, Packer, Paragraph, TextRun } = require("docx");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { parseContract } = require("../electron/parser.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-parser-"));
}

test("解析器在读取内容前拒绝不支持的扩展名", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "malware.exe");
  fs.writeFileSync(filePath, "not a contract");

  await assert.rejects(
    () => parseContract(filePath),
    (error) => error.code === "UNSUPPORTED_FILE_TYPE"
  );
});

test("解析 DOCX 时返回正文、页信息和 SHA-256", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "采购合同.docx");
  const document = new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun("甲方：华东供应链有限公司")] }),
        new Paragraph({ children: [new TextRun("第一条 合同标的与付款")] })
      ]
    }]
  });
  fs.writeFileSync(filePath, await Packer.toBuffer(document));

  const parsed = await parseContract(filePath);

  assert.equal(parsed.extension, ".docx");
  assert.match(parsed.text, /华东供应链有限公司/);
  assert.equal(parsed.pageCount, 1);
  assert.match(parsed.sha256, /^[a-f0-9]{64}$/);
  assert.equal(parsed.pages[0].page, 1);
});

test("解析可搜索 PDF 时保留页码和文本层", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "采购合同.pdf");
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([500, 700]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Contract total: 2680000 RMB", {
    x: 40,
    y: 650,
    size: 14,
    font,
    color: rgb(0, 0, 0)
  });
  fs.writeFileSync(filePath, await pdf.save());

  const parsed = await parseContract(filePath);

  assert.equal(parsed.documentType, "searchable_pdf");
  assert.equal(parsed.pageCount, 1);
  assert.match(parsed.text, /2680000/);
  assert.equal(parsed.pages[0].ocr.status, "not_required");
});
