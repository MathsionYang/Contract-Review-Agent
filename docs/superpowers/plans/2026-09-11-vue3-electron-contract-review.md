# Vue 3 Electron 合同审查实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有合同审查交互原型改造成 Vue 3 + Electron 本地桌面应用，支持本地合同导入、DOCX/PDF 文本解析阅读、本地持久化、人工审查操作和 Validator 导出门禁。

**Architecture:** Vue 3 只负责界面和交互，Pinia 保存当前渲染状态；Electron 主进程负责文件选择、格式与大小校验、SHA-256、DOCX/PDF 解析、项目文件版本保存、Validator 和实际导出。渲染层通过 `contextBridge` 使用白名单 API，不直接访问 Node 文件系统。

**Tech Stack:** JavaScript、Vue 3、Vite、Pinia、Electron、Node.js、mammoth、pdfjs-dist、docx、pdf-lib、exceljs、Node `node:test`。

**Spec:** `合同审查Agent需求说明.md`

## Global Constraints

- 使用 Electron 本地桌面端，直接获取本地文件。
- 界面层使用 Vue 3，新增源码包含中文注释。
- 合同支持 DOCX、可搜索 PDF 和扫描 PDF 的识别状态；默认单文件上限 50 MB、200 页。
- 文件选择和文件系统访问只能发生在 Electron 主进程，渲染层不得直接使用 `fs`、`path` 或 `child_process`。
- 原始文件按版本保存，不覆盖原文件；导出前必须执行 Validator。
- 高风险或关键证据未完成人工复核时，导出必须被阻断，并保留错误码与审计记录。
- 确定性规则库和企业制度在配置界面使用表格选择，列为勾选状态、文件名、文件摘要。

---

### Task 1: Electron 工程骨架与安全 API

**Files:**
- Create: `package.json`
- Create: `vite.config.mjs`
- Create: `index.html`
- Create: `electron/main.cjs`
- Create: `electron/preload.cjs`
- Create: `src/main.js`
- Create: `src/App.vue`
- Create: `src/services/electronApi.js`
- Test: `test/electron-api-contract.test.cjs`

**Interfaces:**
- Produces `window.contractApp.selectContractFile()`, `window.contractApp.importContract(options)`, `window.contractApp.loadState()`, `window.contractApp.saveState(state)`, `window.contractApp.validateExport(payload)`, `window.contractApp.exportReview(payload)`.

- [ ] **Step 1: Write the failing API contract test**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { exposedApiKeys } = require("../electron/preload.cjs");

test("preload only exposes the documented contract API", () => {
  assert.deepEqual(exposedApiKeys().sort(), [
    "exportReview",
    "importContract",
    "loadState",
    "saveState",
    "selectContractFile",
    "validateExport"
  ]);
});
```

- [ ] **Step 2: Run the contract test and verify it fails because the Electron files do not exist**

Run: `node --test test/electron-api-contract.test.cjs`

Expected: FAIL with a missing module or missing exported API.

- [ ] **Step 3: Add the Vite/Electron package scripts and secure preload**

`preload.cjs` must export `exposedApiKeys()` for the test and use `contextBridge.exposeInMainWorld` with only the six approved methods. `main.cjs` must create a `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.

- [ ] **Step 4: Run the contract test and a syntax check**

Run: `node --test test/electron-api-contract.test.cjs`

Expected: PASS.

Run: `node --check electron/main.cjs; node --check electron/preload.cjs`

Expected: exit code 0.

### Task 2: 本地持久化、文件版本和真实解析

**Files:**
- Create: `electron/storage.cjs`
- Create: `electron/parser.cjs`
- Create: `test/storage.test.cjs`
- Create: `test/parser.test.cjs`
- Modify: `electron/main.cjs`

**Interfaces:**
- `createStorage(rootDir).loadState() -> object`
- `createStorage(rootDir).saveState(state) -> object`
- `parseContract(filePath, options) -> Promise<ParsedContract>`
- `ParsedContract` includes `fileName`, `extension`, `mimeType`, `sha256`, `sizeBytes`, `pageCount`, `documentType`, `pages[]`, and `text`.

- [ ] **Step 1: Write failing storage and parser tests**

```js
test("state survives a new storage instance", () => {
  const first = createStorage(tempDir);
  first.saveState({ projects: [{ project_id: "p1" }] });
  assert.deepEqual(createStorage(tempDir).loadState().projects[0].project_id, "p1");
});

test("parser rejects unsupported extensions before reading content", async () => {
  await assert.rejects(() => parseContract(path.join(tempDir, "bad.exe")), /UNSUPPORTED_FILE_TYPE/);
});
```

- [ ] **Step 2: Run both tests and verify the expected failures**

Run: `node --test test/storage.test.cjs test/parser.test.cjs`

Expected: FAIL because the storage and parser modules are absent.

- [ ] **Step 3: Implement atomic JSON persistence and guarded file import**

Storage writes a temporary JSON file and renames it, creates project/version folders, copies the original file without overwriting, and records audit entries. Parser checks extension, regular-file status, 50 MB limit, SHA-256, and parses DOCX via `mammoth` and PDF via `pdfjs-dist`.

- [ ] **Step 4: Run the tests and add PDF/DOCX parsing smoke checks**

Run: `node --test test/storage.test.cjs test/parser.test.cjs`

Expected: PASS, with parsed text and page metadata asserted from small fixtures.

### Task 3: Validator 门禁与实际导出

**Files:**
- Create: `electron/validator.cjs`
- Create: `electron/exporter.cjs`
- Create: `test/validator.test.cjs`
- Create: `test/exporter.test.cjs`
- Modify: `electron/main.cjs`

**Interfaces:**
- `validateReview(review, options) -> { canExport, items, blockingCodes }`
- `exportReview({ review, formats, outputDir }) -> ExportRecord[]`

- [ ] **Step 1: Write failing validator tests**

```js
test("pending high risk blocks export", () => {
  const result = validateReview(reviewWithPendingHighRisk);
  assert.equal(result.canExport, false);
  assert.ok(result.blockingCodes.includes("PENDING_HUMAN_REVIEW"));
});

test("accepted high risk with complete evidence can pass the gate", () => {
  const result = validateReview(reviewWithAcceptedHighRisk);
  assert.equal(result.canExport, true);
});
```

- [ ] **Step 2: Run the validator tests and verify they fail**

Run: `node --test test/validator.test.cjs`

Expected: FAIL because the Validator module is absent.

- [ ] **Step 3: Implement checks and real DOCX/PDF/XLSX/JSON generation**

Validator checks input, required fields, evidence, location, human status, render capability, and sensitive strings. Exporter creates one independent record per format, writes actual files, and never reports `completed` when the gate is blocked.

- [ ] **Step 4: Run validator and exporter tests**

Run: `node --test test/validator.test.cjs test/exporter.test.cjs`

Expected: PASS; blocked exports must produce no completed records.

### Task 4: Vue 3 页面与原型交互迁移

**Files:**
- Create: `src/stores/review.js`
- Create: `src/data/sampleData.js`
- Create: `src/components/AppShell.vue`
- Create: `src/components/DashboardView.vue`
- Create: `src/components/ReviewWorkspace.vue`
- Create: `src/components/KnowledgeView.vue`
- Create: `src/components/CapabilityView.vue`
- Create: `src/components/SettingsView.vue`
- Create: `src/components/Modal.vue`
- Create: `src/styles.css`
- Modify: `src/App.vue`
- Modify: `src/main.js`

**Interfaces:**
- Pinia store exposes `projects`, `activeProject`, `review`, `selectRisk`, `applyRiskAction`, `openImport`, `saveConfig`, `runValidator`, and `runExport`.
- Components use the store and `window.contractApp` only through `src/services/electronApi.js`.

- [ ] **Step 1: Build the Vue shell and preserve the prototype visual language**

Create sidebar/topbar, workbench, compact risk details, icon-first actions, and configuration tables. The new-contract modal must omit auxiliary-material setup.

- [ ] **Step 2: Connect import and reading**

The upload button invokes the Electron file dialog, imports the selected file, displays file name, size, hash, parsed page count and real parsed pages, and marks scan PDFs as OCR unavailable instead of fabricating text.

- [ ] **Step 3: Connect persistence and review operations**

Risk actions, config changes, version creation, task status, audit entries, and export records call the store persistence action. Refreshing the renderer reloads the persisted state.

- [ ] **Step 4: Connect Validator/export modal**

The export modal shows check results and error codes. The export button is disabled or rejected when `canExport` is false, and displays the blocking reason.

### Task 5: Build and end-to-end verification

**Files:**
- Modify: `package.json`
- Modify: `electron/main.cjs`
- Modify: `src/**` as needed from verification findings

- [ ] **Step 1: Run unit tests**

Run: `npm test`

Expected: all Node tests pass.

- [ ] **Step 2: Run the Vue production build**

Run: `npm run build`

Expected: Vite produces `dist/index.html` and exits 0.

- [ ] **Step 3: Start the Vite dev server**

Run: `npm run dev -- --host 127.0.0.1`

Expected: the app is reachable at the printed local URL.

- [ ] **Step 4: Start Electron against the built renderer**

Run: `npm run electron`

Expected: Electron starts with the Vue renderer and no preload or IPC errors.

- [ ] **Step 5: Verify the user-visible flow**

Exercise file selection, DOCX/PDF parsing, page switching, risk action persistence, Validator blocking, and successful JSON/DOCX/PDF/XLSX export using a real local fixture. Report any unsupported OCR capability explicitly.
