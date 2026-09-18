# 通用合同风险证据与规则准确性优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一套适用于采购、软件、服务、租赁等合同类型的通用风险审查增强方案，修复条款误索引、证据错绑、风险定级过低、跨条款规则失效和同一风险重复拆分的问题，并支持按合同类型加载不同的基准缺陷集进行端到端回归。

**Architecture:** 先以解析器已有的 `block_id、clause_no、char_range、text_hash` 建立统一 `clause_registry` 和证据对象，所有事实、规则、清单和模型风险都通过同一套证据解析接口。风险严重度与证据/结论置信度分离；确定性规则负责结构化事实和跨条款计算，模型只负责语义候选；合同类型差异通过规则包、清单适用性和基准适配器配置，不通过固定条款号硬编码。最终由本地校验、风险组聚合和导出验证收敛结果。

**Tech Stack:** Node.js CommonJS、Node Test Runner、现有 DOCX/PDF parser、现有 Electron review pipeline、现有 JSON/XLSX/PDF exporter；不新增运行时依赖。

**Spec:** `docs/合同审查Agent需求说明.md`、`docs/合同审查内容体系与通用审查清单.md`、`docs/设备采购合同-HLXQ-CG-2026-0917-修改后风险评估与代码加强报告.md`（最后一份仅作为一个采购样本，不作为通用规则来源）

## Global Constraints

- 不改变现有模型配置、知识库多模型并存和导出格式的既有行为；只增加兼容字段和校验。新增规则必须声明适用的合同类型和前置条件。
- 不把任何单一合同的条款编号、金额、主体名称、行业术语或缺陷编号写死在通用解析器中；个案只进入独立的回归夹具和规则包。
- 运行时统一使用 `contract_type`、`profile` 和规则包的适用性条件；当合同类型无法确定时使用 `unknown` profile，只运行通用安全检查，不猜测行业专属义务。
- 所有验收指标按 profile 分别计算并给出宏平均；新增合同类型只需增加夹具、规则包和基准清单，不修改已有 profile 的解析接口。
- 不使用模型输出中的条款号作为可信定位，必须回到当前 `document.blocks` 验证 `block_id + char_range + quote`。
- `risk_level` 表示合同风险影响等级；`decision_confidence` 表示当前结论可信度，二者不得互相覆盖。
- `high/critical` 风险在未人工确认时可以保持 `candidate` 或 `needs_verification`，但不得仅因未确认而降为 `medium`。
- 通用规则必须同时支持“显式条款存在”“条款缺失候选”“外部材料不足”和“不适用”四种状态，不能用单一关键词命中替代适用性判断。
- 发现“条款缺失”时，必须保存全文扫描范围、文档哈希和缺失字段；没有正向 quote 不等于没有证据。
- 保护当前工作区中已有的未提交改动；禁止使用 `git reset --hard`、`git checkout --` 或覆盖无关文件。
- 每个任务都必须先写回归测试，再实现最小改动，再运行该任务的定向测试。
- 完成所有任务后运行：`npm test`、`npm run build`，并执行一次基准合同端到端审查。

---

### Task 1: 建立通用基准回归框架与行业合同夹具

**Files:**
- Create: `electron/contract-profiles.cjs`
- Create: `test/fixtures/contract-regression-fixtures.cjs`
- Create: `test/contract-regression.test.cjs`
- Create: `test/fixtures/contract-baseline-manifest.json`
- Modify: `test/contract-fixture.test.cjs`（仅复用已有真实合同断言，不改变现有测试语义）

**Interfaces:**
- Produces `getContractProfile(profile) -> { profile, contract_type, rule_pack_version, applicabilityRules, topicAliases }` and `evaluateApplicability(profile, { document, facts }) -> { status, reason, matchedRules }`；生产代码只通过该接口选择规则包。
- Produces `createContractDocument(profile)`，返回 `{ document, expectations }`；`document` 包含 `text`、`pages`、`blocks`、`fileVersionId`、`documentType`，`expectations` 只保存该 profile 的稳定测试锚点。
- `expectations` 可按夹具需要提供 `validQuotedClauseNo`、`decimalLikeToken`、`validReferenceId`、`missingReferenceId`、`shortQuoteFactId`、`shortQuoteClauseNo`、`validEvidenceRef` 和 `penaltyFacts`；这些字段只供测试读取，不进入生产结果。
- Produces `loadBaselineCase(caseId)`，从 manifest 加载一个 profile 夹具和预期结果；生产代码不得读取测试夹具或 manifest。
- Produces `BASELINE_MANIFEST`，以稳定的 `case_id`、`issue_id`、`expected_topics`、`expected_severity_floor`、`expected_clause_patterns`、`evidence_requirement` 描述基准，不依赖某一份合同的 D 编号。
- 支持至少 `procurement`、`software`、`service`、`lease` 四个 profile；现有设备采购合同只能作为 `procurement` profile 的离线样本挂载，不改变通用接口。
- Consumes `runContractChecks()`、`runGeneralChecklist()`、`runReview()`、`validateReview()`。

`contract-baseline-manifest.json` 的每条记录至少包含：`case_id`、`contract_type`、`profile`、`rule_pack_version`、`issue_id`、`expected_topics`、`expected_severity_floor`、`expected_clause_patterns`、`evidence_requirement`、`sample_topics`；`expected_clause_patterns` 只描述“数字条款标题/付款条件/责任上限”等模式，不保存某个合同的固定条款号。profile 规则包通过 `appliesWhen(document, facts)` 返回 `applicable`、`not_applicable` 或 `unverifiable`，回归框架据此区分漏检和合理跳过。

- [ ] **Step 1: 写失败测试，固定当前问题的可观测断言**

在 `test/contract-regression.test.cjs` 中加入以下测试名：

```js
test("带引号的数字条款可被索引，真实缺失引用才报冲突", () => {});
test("重复短引文只绑定声明条款，不跨条款串联", () => {});
test("P0 确定性冲突保持 critical/high，不因待复核降为 medium", () => {});
test("金额、税务、争议和验收风险按 canonical issue group 聚合", () => {});
test("不同合同类型使用各自基准，但共享证据和风险接口", () => {});
```

采购夹具应覆盖：带引号数字条款、交叉引用、含税冲突、全额预付、交付/验收、质保、数据、保密、罚则、变更/转让、送达、争议、附件等代表性段落；软件夹具增加许可期限、开源和数据处理；服务夹具增加 SLA、里程碑、服务验收和人员替换；租赁夹具增加租期、交付占有、维修责任、押金和返还条件。每个夹具只能表达该 profile 的事实，不把采购条款号复制到其他类型。

- [ ] **Step 2: 运行测试确认当前实现确实失败**

Run: `node --test test/contract-regression.test.cjs`

Expected: FAIL，至少暴露条款边界、重复短引文、P0 被压为 medium 或风险组拆分中的一项；失败信息必须带 `case_id` 和 `issue_id`。

- [ ] **Step 3: 实现 profile 注册表和适用性判定**

在 `electron/contract-profiles.cjs` 中注册 `procurement`、`software`、`service`、`lease` 和 `unknown`；每个 profile 只声明主题别名、适用性谓词和规则包版本。`evaluateApplicability()` 对缺少外部材料返回 `unverifiable`，对不属于该合同类型返回 `not_applicable`，不得把两者转换为风险缺失。

- [ ] **Step 4: 将外部合同结果映射到基准清单，而不是让测试依赖单一文件路径**

在夹具中只保存必要合同片段和块元数据，使用稳定的 block ID；测试不得读取开发机 Desktop、缓存目录或某一合同的绝对路径。真实合同导出可作为离线评估输入，但不能成为通用运行时依赖。

- [ ] **Step 5: 运行夹具测试并保存基线输出**

Run: `node --test test/contract-regression.test.cjs`

Expected after later tasks: PASS；在本任务完成时允许失败，但失败名称必须对应本计划后续任务，不得出现未说明的随机失败。

- [ ] **Step 6: Commit checkpoint**

```text
git add electron/contract-profiles.cjs test/fixtures/contract-regression-fixtures.cjs test/contract-regression.test.cjs test/fixtures/contract-baseline-manifest.json test/contract-fixture.test.cjs
git commit -m "test: add contract-type regression baseline"
```

### Task 2: 建立统一条款注册表并修复交叉引用

**Files:**
- Create: `electron/clause-registry.cjs`
- Modify: `electron/contract-evidence.cjs:45-124`
- Modify: `electron/contract-checks.cjs:225-244`
- Modify: `electron/general-checklist.cjs:155-164`
- Test: `test/contract-regression.test.cjs`
- Test: `test/risk-correlation.test.cjs`

**Interfaces:**
- `buildClauseRegistry(document) -> { entries, byNumber, byBlockId }`
- `entries[]` 元素：`{ clause_instance_id, clause_no, heading, block_id, page, logical_page, char_range, quote, text_hash }`
- `extractReferenceEdges(document) -> edge[]`；每条 edge 包含 `from_ref`、`target_ref|null`、`from_clause_no`、`target_clause_no`、`target_exists`、`char_range`、`quote`。
- `resolveEvidenceRange(document, { block_id, char_range, clause_no, quote }) -> EvidenceRef | null`
- `contract-evidence.cjs` 保留 `resolveRefs()`、`resolveClauseRefs()`、`extractClauseReferences()` 的旧导出名，内部委托新注册表，避免一次性破坏调用方。

- [ ] **Step 1: 写条款注册表失败测试**

断言以下结果：

```js
const { createContractDocument } = require("./fixtures/contract-regression-fixtures.cjs");
const { buildClauseRegistry, extractReferenceEdges } = require("../electron/clause-registry.cjs");
const { document, expectations } = createContractDocument("procurement");
const registry = buildClauseRegistry(document);
assert.ok(registry.entries.some((e) => e.clause_no === expectations.validQuotedClauseNo));
assert.ok(!registry.entries.some((e) => e.clause_no === expectations.decimalLikeToken));
const edges = extractReferenceEdges(document);
assert.equal(edges.find((e) => e.reference_id === expectations.validReferenceId).target_exists, true);
assert.equal(edges.find((e) => e.reference_id === expectations.missingReferenceId).target_exists, false);
```

- [ ] **Step 2: 实现候选条款识别和实例化索引**

解析顺序固定为：先读取 `document.blocks[].clause_no` 和 `char_range`，再对没有块元数据的纯文本做标题兜底识别。数字条款标题允许空格、全角空格、引号、括号、冒号；排除小数金额、版本号以及“第 X 条”外部引用。重复的“第九条”生成不同的 `clause_instance_id`，但保留相同 `clause_no`。

- [ ] **Step 3: 使用字符范围生成引用证据**

`extractReferenceEdges()` 不再通过完整上下文 quote 重新全文搜索；它直接用来源块的 `char_range` 生成 `from_ref`。目标存在时用注册表生成 `target_ref`，目标缺失时保留 `target_ref: null` 和 `target_exists: false`。

- [ ] **Step 4: 更新确定性检查与通用清单**

`reference.unresolved_target` 和 `GC-2-25` 只对 `target_exists=false` 报冲突，并保留来源条款证据。`GC-6-08` 使用 `clause_instance_id` 判断重复编号，不把合法的多级子条款或金额小数当作重复条款。

- [ ] **Step 5: 运行定向测试**

Run: `node --test test/risk-correlation.test.cjs test/general-checklist.test.cjs test/contract-regression.test.cjs`

Expected: 每个合同 profile 的有效引用不再出现在 unresolved targets，真正缺失的目标保持冲突；每条引用冲突至少有一个来源块证据。

- [ ] **Step 6: Commit checkpoint**

```text
git add electron/clause-registry.cjs electron/contract-evidence.cjs electron/contract-checks.cjs electron/general-checklist.cjs test/risk-correlation.test.cjs test/general-checklist.test.cjs test/contract-regression.test.cjs
git commit -m "fix: unify clause registry and cross-reference evidence"
```

### Task 3: 修复事实来源唯一性与证据状态

**Files:**
- Modify: `electron/contract-facts.cjs:65-70、89-95、116-244`
- Modify: `electron/contract-evidence.cjs:89-110`
- Modify: `electron/contract-checks.cjs:12-26、122-140`
- Test: `test/risk-location.test.cjs`
- Test: `test/contract-regression.test.cjs`

**Interfaces:**
- `sourceRefs(blocks, rawText, options) -> { refs, status, candidates }`
- `options`：`clauseNo`、`blockId`、`charRange`、`allowCrossClause`。
- `status`：`verified`、`ambiguous`、`unresolved`。
- 所有 fact 的 `source_refs[].clause_no` 默认必须等于 `fact.clause_no`；跨条款事实必须显式设置 `allowCrossClause=true` 和 `cross_clause=true`。

- [ ] **Step 1: 写短引文和重复出现测试**

在测试中创建三个条款都包含同一短引文的文档，断言事实只绑定声明条款：

```js
const { createContractDocument } = require("./fixtures/contract-regression-fixtures.cjs");
const { document, expectations } = createContractDocument("service");
const { extractContractFacts } = require("../electron/contract-facts.cjs");
const facts = extractContractFacts(document, { contractType: "service" }).facts;
const fact = facts.find((item) => item.fact_id === expectations.shortQuoteFactId);
assert.deepEqual([...new Set(fact.source_refs.map((ref) => ref.clause_no))], [expectations.shortQuoteClauseNo]);
```

再创建没有 `char_range` 且短引文出现两次的模型事实，断言 `status === "ambiguous"`、定位为 unresolved，不自动选择第一个命中。

- [ ] **Step 2: 实现按块、条款和字符范围的定位优先级**

定位顺序：`blockId + charRange` > `clauseNo + exact rawText` > `clauseNo + normalized rawText` > 全文唯一命中。多命中时返回全部候选和 ambiguous 状态，不把所有候选写入同一事实的 verified 证据。

- [ ] **Step 3: 让金额、比例、期限、罚则和义务事实传递来源约束**

修改所有 `sourceRefs(blocks, raw)` 调用点，传入 `clauseNo` 和模型/解析器已有的块范围；`sourceRefsFor()` 去重键增加 `char_range`，不得只按 `block_id + quote` 去重。

- [ ] **Step 4: 将歧义状态传递到风险层**

`evidence_status` 映射为：`verified` 仅对应唯一合法范围，`partially_verified` 对应存在合法候选但仍有歧义，`unverified` 对应没有合法范围。不得因为候选数组非空就写 `verified`。

- [ ] **Step 5: 运行定向测试**

Run: `node --test test/risk-location.test.cjs test/contract-checks.test.cjs test/contract-regression.test.cjs`

Expected: 短引文错绑测试通过；所有风险证据 quote 都能在对应 block 的 `char_range` 中回放。

- [ ] **Step 6: Commit checkpoint**

```text
git add electron/contract-facts.cjs electron/contract-evidence.cjs electron/contract-checks.cjs test/risk-location.test.cjs test/contract-checks.test.cjs test/contract-regression.test.cjs
git commit -m "fix: bind facts to unique clause evidence"
```

### Task 4: 分离风险等级与结论置信度

**Files:**
- Modify: `src/services/evidenceLevel.mjs:10-21`
- Modify: `electron/review-engine.cjs:42-74、77-124、348-385`
- Modify: `electron/contract-checks.cjs:145-197`
- Modify: `electron/general-checklist.cjs:194-210`
- Modify: `electron/validator.cjs:265-374`
- Modify: `electron/exporter.cjs:182-207、452-501`
- Modify: `docs/合同审查Agent字段与枚举字典.md`
- Test: `test/risk-correlation.test.cjs`
- Test: `test/validator.test.cjs`
- Test: `test/exporter.test.cjs`

**Interfaces:**
- 新增可选枚举字段 `decision_confidence: "high" | "medium" | "low"`；缺省时由 `evidence_status` 和定位状态兼容推导。
- `normalizeFindingSeverity(finding, { preserveDeterministicLevel })`：模型候选默认仍受证据门槛约束；确定性 `conflict/missing` 按规则等级保留。
- `capLevelByEvidence(level, context)`：context 至少包含 `source_type`、`check_status`、`anchored`、`evidence_status`、`conclusion_status`、`absence_scope`。

- [ ] **Step 1: 写失败定级测试**

断言以下情况：

```js
const { createContractDocument } = require("./fixtures/contract-regression-fixtures.cjs");
const { normalizeFindingSeverity } = require("../electron/review-engine.cjs");
const { expectations } = createContractDocument("procurement");
const validRef = expectations.validEvidenceRef;
const risk = normalizeFindingSeverity({
  source_type: "deterministic_check", rule_id: "amount.total_vs_uppercase",
  risk_level: "critical", conclusion_status: "candidate", evidence_status: "verified",
  contract_location: { location_status: "resolved", source_refs: [validRef] }
});
assert.equal(risk.risk_level, "critical");
assert.equal(risk.decision_confidence, "medium");
```

同时保留原有约束：没有定位的纯模型候选不得保留 high/critical；`confirmed + invalid` 仍然被 validator 拒绝。

- [ ] **Step 2: 实现风险等级与置信度矩阵**

规则：

| 来源/状态 | 风险等级 | 置信度 |
| --- | --- | --- |
| 确定性 `conflict` + 合法原文范围 | 保留规则声明等级 | medium/high，取决于外部材料是否需要 |
| 确定性 `missing` + 全文扫描证据 | 保留清单声明等级 | medium |
| 模型候选 + 合法原文范围 | 保留模型等级，但若未有本地规则交叉验证最多 high | low/medium |
| 模型候选 + 无合法范围 | 上限 medium | low |
| `rejected` 或无适用条件 | 不进入风险主列表 | high |

- [ ] **Step 3: 让高风险待复核可导出草稿但阻断正式导出**

`validator.cjs` 只在 `formal` 模式继续要求高风险人工复核和 verified 证据；`draft` 模式保留 critical/high，输出 `PENDING_HUMAN_REVIEW`，不再通过降级隐藏风险。XLSX/PDF/JSON 同步展示 `decision_confidence`。

- [ ] **Step 4: 更新字段字典和兼容导出**

旧结果没有 `decision_confidence` 时按：`verified + resolved -> medium`、`partially_verified -> low`、其他 -> low 推导；新结果必须显式写入。导出版本递增到下一个兼容版本，并保留旧字段。

- [ ] **Step 5: 运行定向测试**

Run: `node --test test/risk-correlation.test.cjs test/validator.test.cjs test/exporter.test.cjs test/contract-regression.test.cjs`

Expected: 每个 profile 的确定性/本地规则信号不再因待复核而统一显示为 `medium`；正式导出仍被人工复核门禁阻断。

- [ ] **Step 6: Commit checkpoint**

```text
git add src/services/evidenceLevel.mjs electron/review-engine.cjs electron/contract-checks.cjs electron/general-checklist.cjs electron/validator.cjs electron/exporter.cjs docs/合同审查Agent字段与枚举字典.md test/risk-correlation.test.cjs test/validator.test.cjs test/exporter.test.cjs test/contract-regression.test.cjs
git commit -m "fix: separate risk severity from decision confidence"
```

### Task 5: 引入 canonical 风险组并合并同一问题

**Files:**
- Create: `electron/risk-grouping.cjs`
- Modify: `electron/review-engine.cjs:11-16、303-385`
- Modify: `electron/contract-checks.cjs:244、267、282、337、394-395`
- Modify: `electron/general-checklist.cjs:194-210`
- Modify: `electron/review-runner.cjs:527-594`
- Modify: `electron/exporter.cjs:452-501`
- Test: `test/risk-correlation.test.cjs`
- Test: `test/contract-regression.test.cjs`

**Interfaces:**
- `CANONICAL_ISSUES`：集中维护规则/清单/模型主题映射。
- `canonicalIssueFor(finding, { profile, document_id, contract_version }) -> { issue_id, topic, merge_scope }`
- `canMergeFindings(left, right, { profile, document_id, contract_version }) -> boolean`
- `mergeFindingGroup(findings) -> finding`，必须保留 `source_risk_ids`、`related_rule_ids`、`checklist_ids`、所有 `source_refs` 和 `related_clause_nos`。

- [ ] **Step 1: 写风险组失败测试**

覆盖以下组：

```text
amount_consistency: amount.total_vs_uppercase, amount.item_sum, amount.schedule_amount_anchor, GC-2-22, GC-2-23
tax_price_basis: GC-2-05, GC-2-06, GC-2-07, GC-5-08
acceptance_quality: timeline.acceptance_deadline_conflict, GC-2-18, GC-2-19, GC-2-20
dispute_resolution: reference/dispute checks, GC-4-19, GC-4-20
breach_liability: penalty checks, GC-4-01..05
```

断言同组风险合并为一个主风险、证据数量累加、最高等级保留；不同条款且没有共享 issue_id 的同名风险不合并。

- [ ] **Step 2: 实现 issue catalog 和合并范围**

`merge_scope` 分为 `same_contract`、`same_clause_set`、`independent`。金额/税务/争议允许跨条款；不同合同版本、不同主体、不同违约事件必须隔离。

- [ ] **Step 3: 替换 `riskAggregationKey()` 的完全集合匹配**

先使用 `canonicalIssueFor()`，再用共享 checklist/rule 的图连接组件合并；标题相似只能作为候选，不能单独触发合并。合并结果的主标题取规则来源优先、模型标题作为补充。

- [ ] **Step 4: 让导出和进度流展示主风险组与子来源**

JSON 增加 `canonical_issue_id`、`source_risk_ids`；XLSX/PDF 继续保持一行一主风险，并在分析字段显示子检查编号，避免用户看到 3 条几乎相同的风险。

- [ ] **Step 5: 运行定向测试**

Run: `node --test test/risk-correlation.test.cjs test/exporter.test.cjs test/contract-regression.test.cjs`

Expected: 金额、税务、争议、验收主题分别形成一个风险组；同一罚则主题按 Task 6 的违约事件进一步细分。

- [ ] **Step 6: Commit checkpoint**

```text
git add electron/risk-grouping.cjs electron/review-engine.cjs electron/contract-checks.cjs electron/general-checklist.cjs electron/review-runner.cjs electron/exporter.cjs test/risk-correlation.test.cjs test/exporter.test.cjs test/contract-regression.test.cjs
git commit -m "feat: aggregate findings by canonical risk issue"
```

### Task 6: 重构罚则、责任上限和重复救济规则

**Files:**
- Create: `electron/penalty-rules.cjs`
- Modify: `electron/contract-facts.cjs:116-244`
- Modify: `electron/contract-checks.cjs:349-395`
- Modify: `electron/risk-grouping.cjs`
- Test: `test/contract-checks.test.cjs`
- Test: `test/amount-checks-accuracy.test.cjs`
- Test: `test/contract-regression.test.cjs`

**Interfaces:**
- `extractPenaltyTerms(facts, document) -> PenaltyTerm[]`
- `PenaltyTerm`：`{ clause_instance_id, clause_no, subject, breach_event, remedy_scope, rate, rate_base, cap, remedy_type, references, source_refs }`
- `evaluatePenaltyRelations(terms) -> { checks, relations }`；每条 relation 至少包含 `type`、`left_term_ids`、`right_term_ids`、`source_refs`。
- 关系类型：`duplicate_remedy`、`rate_asymmetry`、`missing_independent_cap`、`cap_scope_conflict`、`termination_remedy_mismatch`。

- [ ] **Step 1: 写跨条款罚则关系失败测试**

断言：

```js
const { createContractDocument } = require("./fixtures/contract-regression-fixtures.cjs");
const { extractPenaltyTerms, evaluatePenaltyRelations } = require("../electron/penalty-rules.cjs");
const { document, expectations } = createContractDocument("procurement");
const terms = extractPenaltyTerms(expectations.penaltyFacts, document);
const result = evaluatePenaltyRelations(terms);
assert.ok(result.relations.some((item) => item.type === "duplicate_remedy"));
assert.ok(result.relations.some((item) => item.type === "cap_scope_conflict"));
assert.ok(result.relations.every((item) => item.source_refs.length > 0));
```

`expectations.penaltyFacts` 必须使用 profile 夹具中的条款实例和事件标签，不在测试中写死合同条款号、金额或主体名称；软件、服务和租赁夹具分别覆盖许可违约、SLA 违约、租金/维修责任等适用事件。必须产生重复救济、责任上限范围和费率/基数不对称的结构化关系，而不是只产生一条“费率需评估”。

- [ ] **Step 2: 实现罚则事实规范化**

从已有 `penalty` facts 优先读取结构化字段；缺字段时从同一条款 raw text 解析主体、违约事件、费率、基数、上限和救济类型。禁止用固定条款号规则代替条款语义，条款号只能作为解析结果中的来源字段。

- [ ] **Step 3: 实现关系计算**

按规范化的 `subject + breach_event` 匹配同一违约事件的多种救济；按 `subject + remedy_scope` 检查专项上限与总责任上限是否互相覆盖；比较费率时同时展示 `rate_base`，不得只比较百分比数字。事件和范围来自事实抽取结果，不依赖固定条款号。

- [ ] **Step 4: 接入风险组并保留独立事件**

重复救济和责任上限关系可以归入 `breach_liability`，但付款逾期与交货逾期必须保持不同 `breach_event` 子组，不能因为都叫违约金而合并。

- [ ] **Step 5: 运行定向测试**

Run: `node --test test/contract-checks.test.cjs test/amount-checks-accuracy.test.cjs test/contract-regression.test.cjs`

Expected: 每个适用 profile 对同一事件的重复救济生成候选、专项/总责任上限生成口径冲突；无对方罚则或事件不适用时不虚构费率不对称。

- [ ] **Step 6: Commit checkpoint**

```text
git add electron/penalty-rules.cjs electron/contract-facts.cjs electron/contract-checks.cjs electron/risk-grouping.cjs test/contract-checks.test.cjs test/amount-checks-accuracy.test.cjs test/contract-regression.test.cjs
git commit -m "feat: model penalty remedies and liability caps across clauses"
```

### Task 7: 强化语义模型证据协议和上下文回写

**Files:**
- Modify: `electron/review-runner.cjs:238-294、645-714`
- Modify: `electron/review-engine.cjs:246-289`
- Modify: `electron/model-runtime.cjs`（只在模型协议支持处透传嵌套 JSON Schema）
- Modify: `test/model-integration.test.cjs`
- Modify: `test/risk-location.test.cjs`
- Test: `test/contract-regression.test.cjs`

**Interfaces:**
- `modelMessages()` 的 payload 增加 `evidence_catalog[]`：`block_id、clause_no、char_range、text`，并保留现有 `document/facts/evidence/check_plan`。
- 每个模型风险输出必须包含：`title、risk_level、conclusion_status、checklist_ids、contract_location`；`contract_location` 必须包含 `block_id、clause_no、char_range、quote`。
- 无法定位时必须返回 `unresolved_reason`，不得使用首页或默认页码填充。

- [ ] **Step 1: 写模型 Schema 失败测试**

测试模型返回以下三种结果：

1. 合法 `block_id + char_range + quote`，应 resolved；
2. 只返回 `clause_no`，应 unresolved 并有 `unresolved_reason`；
3. quote 不在 block 或范围不一致，应拒绝该风险并记录 `MODEL_EVIDENCE_INVALID`。

- [ ] **Step 2: 缩减但结构化提供证据目录**

上下文预算仍按现有分批逻辑执行；只发送与当前批次事实/检查相关的块，目录中的 `text` 必须是连续原文，不使用整篇字符串让模型自行猜偏移。保留现有 `omitted_*` 统计。

- [ ] **Step 3: 扩展响应 Schema 并在本地二次验证**

将 `responseSchema` 从仅约束 `risks` 数组改为约束风险对象必填字段；Schema 失败、范围不一致或 quote 非连续子串时不发布到主风险，写入模型活动的拒绝计数。

- [ ] **Step 4: 保持模型风险和确定性风险的来源边界**

模型风险不能覆盖确定性检查的等级、证据或 `source_refs`；聚合阶段只合并，不用模型的无证据定位替换本地合法定位。

- [ ] **Step 5: 运行定向测试**

Run: `node --test test/model-integration.test.cjs test/risk-location.test.cjs test/contract-regression.test.cjs`

Expected: 语义模型仍能分批完成；无证据风险不再被自动附着到首页；模型输出中的 quote 和 char range 可被回放。

- [ ] **Step 6: Commit checkpoint**

```text
git add electron/review-runner.cjs electron/review-engine.cjs electron/model-runtime.cjs test/model-integration.test.cjs test/risk-location.test.cjs test/contract-regression.test.cjs
git commit -m "fix: enforce structured model evidence contract"
```

### Task 8: 分离通用清单的冲突、缺失候选和不可核验

**Files:**
- Modify: `electron/general-checklist.cjs:88-130、171-212`
- Modify: `electron/validator.cjs:240-255、300-374`
- Modify: `electron/exporter.cjs:452-501`
- Modify: `src/components/ReviewChecklist.vue`（显示扫描范围、缺失字段和相邻条款）
- Modify: `docs/合同审查Agent字段与枚举字典.md`
- Test: `test/general-checklist.test.cjs`
- Test: `test/validator.test.cjs`
- Test: `test/contract-regression.test.cjs`

**Interfaces:**
- 新增清单状态 `missing_candidate`；保留已有 `conflict、missing、unverifiable、not_applicable` 兼容读取。
- `checkResult.scan_evidence`：`{ document_hash, block_ids, clause_nos, matched_patterns, missing_fields }`。
- `checkResult.applicability_reason`：说明为何适用或不适用。

- [ ] **Step 1: 写清单状态转换失败测试**

断言 `GC-2-05` 没有税率但有含税表述时为 `missing_candidate`；缺少外部营业执照时为 `unverifiable`；明确发现诉讼/仲裁并存时为 `conflict`；不触发软件范围时为 `not_applicable`。

- [ ] **Step 2: 修改 `screen()` 保留扫描证据**

每个缺失字段记录匹配正则名称、扫描到的相邻条款号、完整 block 范围和文档哈希。`missing_candidate` 可以进入草稿风险，但不得被解释为“合同已确认缺失”。

- [ ] **Step 3: 更新 validator 和导出**

清单结构允许新状态；正式导出仍要求关键项完成人工复核；JSON/XLSX/PDF 显示“冲突/缺失候选/外部材料待核验”标签和扫描范围。

- [ ] **Step 4: 更新清单界面**

`ReviewChecklist.vue` 在“约定要素待补齐”旁显示缺失字段、相邻条款和所需材料，避免用户只能看到一条泛化提示。

- [ ] **Step 5: 运行定向测试**

Run: `node --test test/general-checklist.test.cjs test/validator.test.cjs test/contract-regression.test.cjs`

Expected: 清单状态与风险列表语义一致，外部材料不足不再伪装成合同缺陷。

- [ ] **Step 6: Commit checkpoint**

```text
git add electron/general-checklist.cjs electron/validator.cjs electron/exporter.cjs src/components/ReviewChecklist.vue docs/合同审查Agent字段与枚举字典.md test/general-checklist.test.cjs test/validator.test.cjs test/contract-regression.test.cjs
git commit -m "feat: distinguish checklist conflicts missing candidates and unverifiable items"
```

### Task 9: 端到端回归、导出验证和交付检查

**Files:**
- Modify: `test/contract-regression.test.cjs`
- Modify: `test/export-report-format.test.cjs`
- Create: `docs/合同风险规则与证据回归验收记录.md`
- Modify: `docs/设备采购合同-HLXQ-CG-2026-0917-修改后风险评估与代码加强报告.md`（仅追加该采购样本的修订核验链接，不改变通用验收口径）

**Interfaces:**
- `runContractRegression(profile, { caseId })` 返回 `{ profile, caseId, baselineRecall, highImpactRecall, severityFloorViolationRate, evidenceBindingRate, shortQuoteMisbindRate, locationResolutionRate, duplicateMergeRate, notApplicableFalsePositiveRate }`。
- `runAllContractRegressions()` 返回 `{ byProfile, macroAverage, gateFailures }`；`byProfile` 至少包含 `procurement`、`software`、`service`、`lease`，缺少某 profile 的夹具时测试失败而不是跳过。
- 回归结果必须同时保存 `review_version_id`、parser 版本、规则目录版本和测试时间。

- [ ] **Step 1: 写端到端指标断言**

断言门槛按每个 profile 计算：基准案例召回率 `baselineRecall >= 0.95`；高影响风险召回率 `highImpactRecall >= 0.90`；风险严重度低于基准下限的比例 `severityFloorViolationRate === 0`；有原文依据风险的证据绑定率 `evidenceBindingRate >= 0.98`；短引文错绑率 `shortQuoteMisbindRate === 0`；已声明同一主题的重复合并率 `duplicateMergeRate >= 0.90`；标记不适用的清单误报率 `notApplicableFalsePositiveRate <= 0.05`。宏平均只用于总体趋势，不能掩盖单个 profile 未达标。

- [ ] **Step 2: 执行完整测试**

Run: `npm test`

Expected: 所有现有测试和各 profile 回归测试通过；若门槛未达到，测试必须输出 `profile`、`case_id`、`issue_id`、指标名称和失败阶段。

- [ ] **Step 3: 执行构建和导出验证**

Run: `npm run build`

Run: `node --test test/export-report-format.test.cjs test/exporter.test.cjs test/validator.test.cjs`

Expected: JSON/XLSX/PDF 均保留 `canonical_issue_id`、`decision_confidence`、来源条款证据和草稿/正式状态；正式报告仍不会绕过人工复核门禁。

- [ ] **Step 4: 按 profile 重新导出并人工抽样**

每个 profile 按 manifest 的 `sample_topics` 抽取至少 5 条风险或清单项；采购、软件、服务、租赁分别覆盖自身适用的金额/付款、交付或里程碑、验收、责任/救济、争议、数据或知识产权主题。逐条核对原文 quote、block、char range、等级、适用性状态和主风险组，禁止用某一合同的固定条款号代替抽样标准。

- [ ] **Step 5: 更新验收记录和评估报告**

在 `docs/合同风险规则与证据回归验收记录.md` 中保存指标、失败项、导出警告和人工抽样结论；在原评估报告追加“修订核验”章节，不覆盖原始评估数据。

- [ ] **Step 6: 最终全量检查**

Run: `git status --short`

确认只包含计划内代码、测试、文档和构建产物变更；检查没有临时 `risk-summary.json`、调试输出或外部绝对路径依赖。

## Review Checkpoints

- Checkpoint A：Task 1-3 完成后，必须在每个 profile 上确认带引号数字条款、重复短引文和跨条款 evidence ref 正确，再继续定级改造。
- Checkpoint B：Task 4-6 完成后，必须确认确定性高影响风险不再全为 `medium`，金额/税务/争议/验收聚合正确，罚则关系使用事件和责任范围可审计。
- Checkpoint C：Task 7-8 完成后，必须确认模型无证据输出不会污染本地确定性结果，清单缺失与不可核验在界面和导出中分层。
- Checkpoint D：Task 9 完成后，才允许重新导出正式候选报告；任何 P0 召回、证据绑定或正式导出门槛失败，都应回到对应任务修复。

## Plan Self-Review

- 规格覆盖：profile 注册与适用性、条款索引、证据绑定、定级、聚合、罚则、模型 Schema、清单分层、导出和端到端回归均有独立任务。
- 接口一致性：Task 1 产出的 `getContractProfile()`/`evaluateApplicability()` 和基准 manifest 被所有回归 profile 复用；Task 2 产出的 `clause_registry` 被 Task 3、Task 5、Task 8 复用；Task 4 的 `decision_confidence` 被 validator/exporter/field dictionary 同步支持；Task 5 的 `canonical_issue_id` 被 Task 9 验收。
- 回滚边界：每个任务都有单独测试和 commit checkpoint；旧 API 名称保留，新增字段兼容旧结果。
- 未纳入范围：不在本轮重写模型供应商、向量索引、法律知识库内容或前端整体视觉；这些不会解决当前证据和定级根因。
