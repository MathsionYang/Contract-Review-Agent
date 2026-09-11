# P0 Real Review Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成阶段文档 P0，使真实导入合同可以通过本地知识文件、确定性规则、已配置模型和法律快照生成可核验的审查结果。

**Architecture:** Electron 主进程负责文件系统、网络和审查编排，Vue/Pinia 只负责展示任务和结果。新增的纯函数服务先接受结构化输入并返回可序列化结果，再由 IPC 连接到现有 `state.json` 和审核工作区。

**Tech Stack:** Vue 3、Pinia、Vite、Electron 44、Node.js CommonJS 主进程、Node Test Runner、mammoth、pdfjs-dist、原生 `fetch` 和 Node crypto/fs/path。

**Spec:** `docs/superpowers/specs/2026-09-11-p0-real-review-pipeline-design.md`

## Global Constraints

- 保持 Electron `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- 渲染层不得直接使用 `fs`、`path`、`crypto`、网络请求或 Electron 原生对象。
- 原始合同和知识文件按版本复制保存，不覆盖历史文件。
- 任何缺少证据、定位或模型结构化输出的结果只能是待核验/部分完成，不能伪造为已确认。
- 明文 API Key、Bearer Token 和私钥不能进入 `state.json`、日志、审计、执行快照或导出文件。
- 新增和修改代码使用中文注释；先写失败测试，再写实现。

---

### Task 1: 纯函数知识文件与规则/检索领域服务

**Files:**
- Create: `electron/knowledge.cjs`
- Create: `electron/review-engine.cjs`
- Modify: `test/management-state.test.cjs`
- Create: `test/p0-engine.test.cjs`

**Interfaces:**
- `knowledge.cjs` exports `validateKnowledgeFile(filePath, kind, options)`, `buildKnowledgeItem(input)`, `extractKnowledgeClauses(text, kind)`, and `searchKnowledgeSources(sources, query, options)`.
- `review-engine.cjs` exports `evaluateDeterministicRules(document, rules, options)`, `normalizeModelRisks(payload, context)`, `mergeReviewFindings(findings)`, and `buildReviewTaskResult(input)`.
- `searchKnowledgeSources()` returns `{ source_id, file_name, clause_no, clause_title, excerpt, score, source_type, version }` only for parsed and selected sources.

- [ ] **Step 1: Write the failing tests**

Add tests that assert:

```js
const item = buildKnowledgeItem({
  kind: "policies",
  filePath: "D:/knowledge/采购制度.docx",
  fileName: "采购制度.docx",
  summary: "采购付款规则",
  sha256: "sha256:abc",
  size: 120,
  version: "v1",
  clauses: [{ clause_no: "4.2", title: "预付款", text: "预付款比例不得超过 30%" }]
});
assert.equal(item.source_type, "enterprise_policy");
assert.equal(item.clauses[0].clause_no, "4.2");

const hits = searchKnowledgeSources([item], "预付款比例");
assert.equal(hits[0].file_name, "采购制度.docx");
assert.equal(hits[0].clause_no, "4.2");
assert.match(hits[0].excerpt, /30%/);
```

Also assert a rule with a missing input returns `conclusion_status: "needs_verification"`, a valid rule returns a finding with `evidence_status: "verified"`, and invalid model JSON returns no confirmed risk.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `node --test test/p0-engine.test.cjs`

Expected: FAIL because `electron/knowledge.cjs`, `electron/review-engine.cjs` and their exported functions do not exist.

- [ ] **Step 3: Implement the minimal domain services**

Implement extension/size validation, stable source IDs from SHA-256, clause extraction from numbered lines/headings, token-overlap search, deterministic rule evaluation for `amount_ratio`, `required_clause` and `date_order`, model risk allow-list normalization, and finding merge without accepting invalid/unsupported risk fields.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/p0-engine.test.cjs`

Expected: all P0 domain tests pass. Then run: `npm test` and expect the existing suite plus the new tests to pass.

### Task 2: Electron 知识文件上传与法律快照导入

**Files:**
- Modify: `electron/main.cjs`
- Modify: `electron/preload.cjs`
- Modify: `src/services/electronApi.js`
- Modify: `electron/storage.cjs`
- Modify: `test/p0-engine.test.cjs`

**Interfaces:**
- IPC `knowledge:select-files` returns `{ canceled, files: [{ filePath, fileName }] }`.
- IPC `knowledge:import-files` accepts `{ kind, files, summaries }` and returns `{ items, state }`.
- IPC `legal:import-snapshot` accepts `{ filePath }` and returns `{ snapshot, state }`.
- IPC `legal:verify-realtime` accepts `{ snapshotId, query }` and returns `{ status, sources, errorCode }`.

- [ ] **Step 1: Write failing IPC/storage tests**

Assert that a knowledge import stores the file under `userData/knowledge/<kind>/<file_version_id>/`, records `sha256`, `size`, `parse_status`, `clauses` and `selected: false`, and rejects `.exe` or files over 50 MB. Assert a legal snapshot import preserves `id`/`hash` and refuses a malformed snapshot.

- [ ] **Step 2: Run tests and verify expected failures**

Run: `node --test test/p0-engine.test.cjs`

Expected: FAIL because the new IPC handlers and storage functions do not exist.

- [ ] **Step 3: Implement main-process upload/import handlers**

Use `dialog.showOpenDialog` with multiple selection for `.docx`, `.pdf`, `.md`, `.txt`, `.json`; copy files through storage; parse text with the existing parser; update `state.knowledge.rules` or `state.knowledge.policies`; prepend audit records; never delete historical versions.

- [ ] **Step 4: Add preload and renderer wrappers**

Expose only `selectKnowledgeFiles`, `importKnowledgeFiles`, `importLegalSnapshot` and `verifyLegalRealtime`. Browser preview returns a clear Electron-unavailable error for these operations.

- [ ] **Step 5: Verify**

Run: `node --test test/p0-engine.test.cjs && npm test`

Expected: upload/storage tests and the full existing suite pass.

### Task 3: 模型网关与法律实时核验

**Files:**
- Create: `electron/model-gateway.cjs`
- Create: `electron/legal-source.cjs`
- Modify: `electron/main.cjs`
- Modify: `test/p0-engine.test.cjs`

**Interfaces:**
- `invokeModel({ model, messages, responseSchema, fetchImpl, credentialResolver, signal })` returns `{ ok, data, usage, latencyMs, errorCode }`.
- `verifyLegalSource({ url, query, allowlist, fetchImpl })` returns `{ status: "verified|unavailable|unauthorized", sources, errorCode }`.

- [ ] **Step 1: Write failing gateway tests**

Use injected `fetchImpl` to test an OpenAI-compatible JSON response, malformed JSON, HTTP 429, timeout/abort and missing credential reference. Assert request headers are built from the injected credential but the returned audit-safe object contains no secret.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test test/p0-engine.test.cjs`

Expected: FAIL because both modules are absent.

- [ ] **Step 3: Implement model gateway**

Resolve credentials only in the main process, call `${endpoint}/chat/completions` when the configured endpoint does not already end with that path, request JSON output, parse/validate the returned content, and convert failures to `MODEL_CONFIG_INVALID`, `MODEL_REQUEST_FAILED` or `MODEL_OUTPUT_INVALID`.

- [ ] **Step 4: Implement allowlisted legal verification**

Normalize configured URLs, reject hosts outside `settings.legalSourceAllowlist`, call a JSON endpoint with a bounded timeout, and return offline fallback status without inventing legal sources.

- [ ] **Step 5: Verify**

Run: `node --test test/p0-engine.test.cjs && npm test`; then run `node --check electron/model-gateway.cjs` and `node --check electron/legal-source.cjs`.

### Task 4: 真实审查任务编排与 Pinia 状态连接

**Files:**
- Create: `electron/review-runner.cjs`
- Modify: `electron/main.cjs`
- Modify: `electron/preload.cjs`
- Modify: `src/services/electronApi.js`
- Modify: `src/stores/review.js`
- Modify: `src/components/ReviewWorkspace.vue`
- Modify: `test/p0-engine.test.cjs`

**Interfaces:**
- IPC `review:run` accepts `{ projectId, review }` and returns `{ review, state }`.
- `runReview({ review, state, services, onProgress })` returns a serializable review with `task.status`, `task.current_step`, `task.errors`, `risks`, `config.execution` and `auditRecords` updates.

- [ ] **Step 1: Write failing orchestration tests**

Create a parsed contract fixture with a payment clause and a selected policy clause. Assert the runner produces a non-empty risk whose source is `deterministic_rule` or `knowledge_retrieval`, whose basis includes file name/clause/title/excerpt, and whose `task.status` is `completed` or `partial`. Assert the fixture does not import risks from `sampleData.js`.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test test/p0-engine.test.cjs`

Expected: FAIL because `review-runner.cjs` and `review:run` are absent.

- [ ] **Step 3: Implement the runner**

Run steps in order: `parse` (reuse parsed document), `rules`, `retrieve`, `model`, `validate`, `persist`. Preserve partial findings when model or realtime verification fails. Use the existing `validateReview` as the final result check, but keep unverified risks as `needs_verification` so the result remains visible and export-blockable.

- [ ] **Step 4: Trigger after contract import**

Change `contract:import` to store the initial review and expose a separate `review:run` call so the renderer can display progress. The Pinia `importContract()` action calls `runReview()` after state replacement, updates the returned review/state, selects page 1, and shows the top-centered notification with the actual result status.

- [ ] **Step 5: Add workspace states**

Show current step, progress, partial/failed status and a retry action in the existing top execution area. When real risks exist, keep the current evidence bubble rendering with file name, clause and excerpt. Do not show a fake risk list for an imported contract.

- [ ] **Step 6: Verify**

Run: `npm test`, `npm run build`, and `node --check electron/review-runner.cjs`.

### Task 5: 法律快照/规则配置交互与阶段文档同步

**Files:**
- Modify: `src/components/KnowledgeView.vue`
- Modify: `src/stores/review.js`
- Modify: `src/components/CapabilityView.vue`
- Modify: `src/components/SettingsView.vue`
- Modify: `docs/合同审查Agent技术实现阶段文档.md`
- Modify: `test/p0-engine.test.cjs`

**Interfaces:**
- Upload buttons call `electronApi.selectKnowledgeFiles()` and `electronApi.importKnowledgeFiles()`; metadata editing remains available for imported records.
- Legal snapshot import/view/edit uses the existing snapshot edit dialog, while published snapshot binding remains restricted.

- [ ] **Step 1: Write failing UI/state tests**

Assert `addKnowledge()` accepts imported metadata, selected sources appear in `review.config.rules`/`review.config.policies`, and a legal snapshot import can be viewed and bound only when `status === "published"`.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test`

Expected: FAIL on imported-file state and snapshot binding assertions.

- [ ] **Step 3: Implement upload interactions**

Replace metadata-only “新增” submission with file selection/import for rules and policies. Keep edit/delete/batch delete; imported records show parsing status and source metadata in the table.

- [ ] **Step 4: Implement snapshot management interaction**

Add local snapshot import and realtime verification entry points. Preserve existing view/edit behavior and display sync/validation errors via the centered notification bubble.

- [ ] **Step 5: Update documentation**

Mark only the P0 items actually verified by tests as implemented, retain explicit boundaries for OCR/MCP/Skill/Memory lifecycle, and update the validation record with fresh counts.

- [ ] **Step 6: Full verification**

Run:

```text
npm test
npm run build
node --check electron/main.cjs
node --check electron/preload.cjs
node --check electron/storage.cjs
node --check electron/parser.cjs
node --check electron/validator.cjs
node --check electron/exporter.cjs
node --check electron/knowledge.cjs
node --check electron/review-engine.cjs
node --check electron/model-gateway.cjs
node --check electron/legal-source.cjs
node --check electron/review-runner.cjs
```

Expected: all tests pass, production build succeeds, and every Electron module passes syntax checking.
