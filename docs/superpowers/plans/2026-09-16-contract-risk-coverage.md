# Contract Risk Coverage Implementation Plan

> **For agentic workers:** This plan is executed inline in the current session. Each task follows TDD: write a failing test, verify the failure, implement the smallest change, then run the focused and full suites.

**Goal:** Make the contract review pipeline detect and explain the high-value risks in `data/软件采购合同.docx` and `data/软件采购合同.pdf` through structured facts, deterministic checks, semantic coverage records, and evidence-safe locations.

**Architecture:** Preserve the existing `document.text`, `document.pages`, and `review.risks` contracts while adding `document.blocks`, normalized contract facts, and `review.check_results`. A new fact/check module will run after parsing and before optional model analysis; its findings will be merged with existing rules and model findings. Evidence anchors must resolve to an exact block quote; unresolved anchors become `needs_verification` without fabricated page fallback.

**Tech Stack:** Node.js CommonJS, Node built-in test runner, Mammoth, pdfjs-dist, existing Electron review runner and review engine.

**Spec:** `合同审批/docs/合同风险漏检根因分析与改进方案.md`

## Closeout verification — 2026-09-16

Tasks 1–6 are verified for the delivered scope. Checkmarks below describe the current implementation and regression results; the original pre-implementation failure targets are retained as design context, not as claims that historical red-phase runs were replayed.

- [x] Full suite: `npm test` — 79 passed, 0 failed, 0 skipped.
- [x] Production bundle: `npm run build` — passed.
- [x] Syntax: parser, contract facts/checks/evidence, general checklist, review engine/runner, and validator — 8 modules passed.
- [x] Real DOCX/PDF: all 24 deterministic check IDs/statuses and all 95 general checklist IDs/statuses agree; critical risk quotes resolve to their source blocks.
- [x] DOCX: 157 blocks, 84 cells in 6 tables; all character ranges match the original document text. PDF: 7 pages and 7 page blocks.
- [x] Closeout fixes: original-text offsets for DOCX; consistent exclusion of `not_applicable` from executed coverage; correct penalty clause attribution around whitespace/headings; warnings and reduced confidence for ambiguous address segmentation.

Both fixture reviews remain `partial`: 24 deterministic checks produce 19 conflicts and 5 missing results; the 95-item general checklist produces 2 passes, 11 conflicts, 16 missing results, 55 unverifiable items, and 11 not-applicable items. Of the unverifiable items, 32 are high severity and produce `CHECKLIST_REVIEW_REQUIRED`. Merged output contains 40 candidate risks; mapped checklist items are not additional independent risks.

Fact sets are not fully equivalent (54 DOCX records, 52 PDF records). PDF address fields can merge with adjacent content and now produce `PARTY_ADDRESS_SEGMENTATION_UNCERTAIN` at confidence 0.4; DOCX also has an additional heading-only penalty match. DOCX physical pagination, OCR, precise PDF table segmentation, complete 26-defect scoring, live model verification, and extraction/analysis dual-role orchestration remain outside this delivery.

## Global Constraints

- Keep the existing risk enums and backward-compatible fields.
- Persist money as decimal strings or integer minor units, never binary floating point.
- A risk cannot be `confirmed` without verifiable contract evidence and human review.
- A completed task must expose check coverage; skipped critical checks force `partial` or `input_required`.
- Do not fabricate a physical DOCX page number when the source has no reliable pagination.
- Existing tests must remain green.

---

### Task 1: Add evidence blocks to DOCX and PDF parsing

**Files:**
- Modify: `electron/parser.cjs`
- Test: `test/parser.test.cjs`

**Interfaces:**
- Produces `document.blocks[]` with `block_id`, `block_type`, `page`, `text`, `char_range`, `text_hash`, and optional `table_ref`/`bbox`.
- Keeps `document.text`, `document.pages`, `pageCount`, `sha256`, and OCR fields unchanged.

- [x] **Step 1: Add parser regression tests**

Add tests that parse a generated DOCX containing a paragraph and a 2x2 table, then assert that blocks include a paragraph block and table-cell blocks with row/column references. Add a PDF assertion that each extracted page has at least one block whose `page` equals the page number and whose quote can be found in the page text.

- [x] **Step 2: Verify parser regression results**

Run `npm test -- test/parser.test.cjs`.

Original failure target: `parsed.blocks` was undefined when the parser only returned flattened text/pages. Current block assertions pass.

- [x] **Step 3: Implement minimal block extraction**

For DOCX, use Mammoth HTML conversion plus a small HTML table/paragraph extractor or OOXML traversal already available in installed dependencies. Emit logical blocks and table cell references, and set `page=null` with `page_status="unresolved"` when no reliable page break exists. For PDF, retain the existing page text and emit page blocks from text items, preserving a normalized quote and page number. Add a deterministic `sha256:<hex>` text hash helper.

- [x] **Step 4: Run focused parser tests and full parser regression**

Run `npm test -- test/parser.test.cjs`, then `npm test`.

- [x] **Step 5: Verify the real contract fixtures**

Run a one-off read-only parser command against both files and assert that the DOCX has table blocks, the PDF has seven pages, and neither document has empty text.

### Task 2: Extract normalized contract facts

**Files:**
- Create: `electron/contract-facts.cjs`
- Test: `test/contract-facts.test.cjs`

**Interfaces:**
- `extractContractFacts(document, options) -> { facts, clauses, warnings }`.
- Fact objects contain `fact_id`, `fact_type`, normalized values, source block IDs, page/clause metadata, and confidence.

- [x] **Step 1: Add fact extraction regression tests**

Use a compact contract text containing the real clauses from 2.1, 2.2, 2.3, 3.2, 4.2, 4.3, 8.1-8.5, 10.2, 11.1, and 11.4. Assert extraction of:

```text
money: 1286000 and 1268000
ratio: 50, 40, 15
duration: 10 workdays, 30 calendar days, 15 calendar days
parties: 甲方/乙方 with addresses
obligations: subject/object pairs for 3.3 and 8.4
penalties: rate, base, fixed amount, and referenced clause
```

- [x] **Step 2: Verify fact extraction regression results**

Run `npm test -- test/contract-facts.test.cjs`.

Original failure target: the fact module did not exist. Current extraction assertions pass.

- [x] **Step 3: Implement normalization helpers**

Implement Chinese uppercase RMB conversion for the units used by the fixture, Arabic currency extraction, percentage and amount extraction, workday/calendar-day parsing, party/address extraction, clause segmentation, and obligation/penalty pattern extraction. Every extracted value must retain `raw_text` and `source_refs`.

- [x] **Step 4: Run focused tests and add edge cases**

Run the focused suite. Add tests for commas, full-width punctuation, `万分之五`, fixed RMB amounts, missing values, and repeated clause numbers. Keep all tests green.

### Task 3: Implement deterministic contract checks

**Files:**
- Create: `electron/contract-checks.cjs`
- Test: `test/contract-checks.test.cjs`

**Interfaces:**
- `runContractChecks({ document, facts, contractType }) -> { checkResults, findings }`.
- `checkResults[]` uses `check_id`, `status`, `severity`, `fact_refs`, `source_refs`, and `message`.
- `findings[]` is compatible with `review-engine.baseFinding` input and never claims confirmed status.

- [x] **Step 1: Add regression checks for the real defect groups**

Add tests asserting that a fixture with the real values produces checks/findings for:

- total uppercase/lowercase mismatch and item total mismatch;
- installment ratio sum `105%` and installment amount anchor mismatch;
- acceptance `10 workdays` versus `15 calendar days`, plus `30 calendar days` ordering;
- subject inversion in 3.3 and 8.4;
- penalty stacking, unlimited cap, and broad indirect-loss scope;
- venue at the counterparty location;
- missing termination/data/IP/confidentiality/compliance clauses;
- subjective acceptance standard and undefined major fault.

- [x] **Step 2: Verify deterministic check regression results**

Run `npm test -- test/contract-checks.test.cjs`.

Original failure target: the check module did not exist and returned no findings. Current defect-group assertions pass.

- [x] **Step 3: Implement the smallest rule families**

Implement pure functions for money arithmetic, ratio sums, duration conflicts, party-role consistency, penalty aggregation/cap detection, liability scope, venue comparison, and required-clause absence. Use a versioned check catalog constant for the software procurement contract. Emit `missing` or `unverifiable` rather than treating absence as a confirmed fact.

- [x] **Step 4: Run focused checks and verify all groups**

Run `npm test -- test/contract-checks.test.cjs`; assert each check has source block references or an explicit unresolved reason.

### Task 4: Integrate facts and checks into the review runner

**Files:**
- Modify: `electron/review-runner.cjs`
- Modify: `electron/review-engine.cjs`
- Test: `test/review-pipeline.test.cjs`

**Interfaces:**
- `runReview()` adds `review.document.blocks`, `review.contract_facts`, `review.check_results`, and `review.coverage`.
- Existing `review.risks` remains the merged risk list.

- [x] **Step 1: Add pipeline regression tests**

Run the real DOCX through `runReview()` with no analysis model. Assert the result contains check results for the amount, penalty, subject, timeline, missing-clause, and acceptance groups; assert at least eight priority risks are represented as candidate/needs-verification findings with source evidence (the six critical checks plus installment amount anchoring and acceptance deadline conflict); assert no finding with an unmatched quote points to page 1 fallback text.

- [x] **Step 2: Verify pipeline regression results**

Run `npm test -- test/review-pipeline.test.cjs`.

Original failure target: `review.check_results` and `review.contract_facts` were absent and the real contract produced only generic keyword findings. Current pipeline assertions pass.

- [x] **Step 3: Integrate the new stages**

After parse validation and before legacy rules, call `extractContractFacts()` and `runContractChecks()`. Convert check findings with the existing risk normalization path, merge them with legacy findings, and retain `check_results` even when no model is configured. Add coverage counts and an execution warning when a configured model was not called.

- [x] **Step 4: Make evidence resolution strict**

Update location resolution so an unmatched quote returns `location_status="unresolved"`, `location_confidence=0`, and an empty quote instead of the first page excerpt. Preserve the old fallback only for legacy findings that explicitly have no quote, and mark them `unverified`.

- [x] **Step 5: Add completion gating**

If critical check families are not executed or parsing warnings prevent evidence-safe checking, set task status to `partial` and add a structured error. Keep existing model failure behavior and existing rule-only reviews compatible.

- [x] **Step 6: Run focused and full tests**

Run `npm test -- test/review-pipeline.test.cjs`, `npm test -- test/p0-engine.test.cjs`, then `npm test`.

### Task 5: Add regression fixture coverage and execution metadata

**Files:**
- Create: `test/contract-fixture.test.cjs`
- Modify: `electron/review-runner.cjs`
- Modify: `electron/validator.cjs`

**Interfaces:**
- `review.coverage` contains `total`, `executed`, `passed`, `conflict`, `missing`, `unverifiable`, and `skipped` counts.
- Validator rejects completed export when critical checks are skipped or high/critical findings lack evidence-safe locations.

- [x] **Step 1: Add ground-truth regression assertions**

Parse `data/软件采购合同.docx`, run the review without a model, and assert:

```text
critical_recall >= 1.0 for the deterministic critical set
overall_check_coverage >= 0.8
money, timeline, subject, penalty, missing_clause, acceptance groups are present
```

Use stable `check_id` assertions rather than exact risk title matching.

- [x] **Step 2: Verify fixture regression results**

Run `npm test -- test/contract-fixture.test.cjs`.

Original failure target: the pipeline had no coverage object and could not meet the recall/coverage assertions. Current fixture assertions pass.

- [x] **Step 3: Implement coverage and validator metadata**

Populate coverage from check results, persist it in the review object, and add validator errors for skipped critical checks, invalid evidence, or unresolved high/critical locations. Do not block ordinary low-risk drafts that are explicitly `needs_verification` unless export policy already requires it.

- [x] **Step 4: Run the fixture and full suite**

Run the focused fixture, then `npm test`.

### Task 6: Update technical documentation and final verification

**Files:**
- Modify: `docs/合同风险漏检根因分析与改进方案.md`
- Modify: `docs/合同审查Agent技术实现阶段文档.md` only where current behavior is changed
- Test: all existing tests plus the fixture suite

- [x] **Step 1: Update the implementation status**

Record which parser blocks, fact types, check families, coverage fields, and gating behaviors are now implemented. Keep future OCR, vector retrieval, and DOCX physical pagination explicitly marked as pending if they were not delivered in this iteration.

- [x] **Step 2: Run the full verification commands**

Run:

```powershell
npm test
npm run build
node --check electron/parser.cjs
node --check electron/contract-facts.cjs
node --check electron/contract-checks.cjs
node --check electron/contract-evidence.cjs
node --check electron/general-checklist.cjs
node --check electron/review-engine.cjs
node --check electron/review-runner.cjs
node --check electron/validator.cjs
```

- [x] **Step 3: Inspect the real fixture output**

Run the parser/review command against both source formats and compare check IDs, coverage, source blocks, and task status. Any discrepancy between DOCX and PDF facts must be reported as a parser warning or fixed before completion.
