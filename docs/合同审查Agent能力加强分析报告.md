# 合同审查 Agent 能力加强分析报告

> 文档日期：2026-09-17
> 分析基线：工作区当前代码（含未提交改动），`git HEAD = 6accf01 功能新增`
> 验证方式：完整通读 `electron/` 19 个主进程模块、`src/` 全部组件与 store、`test/` 26 个测试文件、9 份契约/阶段/根因文档；执行 `npm test`（177 通过 / 0 失败 / 0 跳过）
> 结论口径：本报告只描述"已经能跑通"和"还不足以支撑验收"的差距，不重复需求说明中的远期规划（OCR、真实 MCP 执行器、多用户治理等）。

---

## 1. 结论摘要

当前项目已经完成 P0–P2 的真实本地闭环：真实 DOCX/PDF 解析、24–25 项确定性检查、95 项通用清单、事实抽取、三源知识检索（含真实远程 embedding + 余弦 + RRF）、模型流式审查、对话审核与记忆候选、人工清单复核、双模式导出门禁、Electron 安全边界，177 项自动化测试全绿。**能跑通的部分质量不低**，主要问题不在"缺功能"，而集中在四类结构性弱点：

1. **门禁与恢复的信任边界不成立**：导出门禁校验的是渲染层提交的对象而非持久化版本；任务取消、Checkpoint、幂等键三者都只是字段占位。
2. **正式导出路径在真实合同上不可达**：约 35 项 high 级通用检查恒为 `unverifiable`，人工复核又不接受 `unverifiable` 结论，导致只能走 `draft`。
3. **人工修订能力严重不足**：需求 FR-041–FR-044 要求的"修改等级/类别/主题/分析/建议/结论/证据/定位"在 UI 上全部只读，且无撤销、无修订历史。
4. **度量与回归网缺失**：11 个阻断码、7 个草稿降级码零测试覆盖；`test/fixtures/golden-set`、M3 回归报告、质量阈值三件套不存在。

建议按 **P0（6 项，先做门禁与可靠性）→ P1（9 项，再做可用性与治理）→ P2（3 项，最后做输出与体验）** 的顺序推进。P0 前两项（导出信任边界、正式门禁可达性）成本只有 S/M，却能立刻恢复"门禁可信"和"正式报告可出"两条主干。

---

## 2. 已实现能力盘点

### 2.1 主进程（`electron/`）

| 领域 | 已实现能力 | 关键位置 |
|---|---|---|
| 解析 | DOCX/PDF 解析、`document.blocks[]` 证据块（DOCX 157 块含表格单元格，PDF 7 页块含 bbox）、字符范围与文本哈希、SHA-256、扫描件状态识别 | `parser.cjs` |
| 事实层 | 中文大写/阿拉伯金额、比例、工作日/自然日期限、主体地址、义务关系、违约金事实，带 `source_refs` 与置信度 | `contract-facts.cjs` |
| 确定性检查 | 25 项：金额勾稽、分期比例与金额锚点、验收时序、主体倒置、违约金叠加/封顶/费率不对称、赔偿范围、管辖、5 项缺失条款、许可期限等 | `contract-checks.cjs:173-327` |
| 通用清单 | `GC-1.0-2026-09-16` 95 项判据 + 适用条件 + 证据要求 + 实际检查方法；模型收到 `check_plan` | `general-checklist.cjs`、`general-checklist-catalog.json` |
| 覆盖率 | `total/executed/passed/conflict/missing/unverifiable/not_applicable/skipped` 单一口径，生成器与校验器共用 | `checklist-policy.cjs:3-13` |
| 审查编排 | 事实→检查→清单→规则→检索→模型→校验→持久化；风险流式逐条发布；上下文二分查找压页；token 预算快照 | `review-runner.cjs` |
| 风险契约 | 5 等级/5 类别/4 结论/5 证据状态硬校验，模型输出强制 `needs_verification`，引用无法匹配不回退首页 | `review-engine.cjs:4-7,175-208` |
| 模型网关 | 流式 SSE、空闲/总时限双计时、指数退避、embedding `index` 校验、服务商错误脱敏、endpoint 禁凭据 | `model-gateway.cjs` |
| 事实抽取模型化 | 按 token 预算分块（重叠 120 字符）、事实原文锚定、数值一致性校验 | `model-extraction.cjs` |
| 检索 | 真实远程 `/embeddings` + 余弦相似度 + RRF 混合、磁盘向量缓存（原子写）、单路失败熔断降级关键词 | `knowledge-retrieval.cjs` |
| 记忆 | 敏感扫描、冲突检测、候选确认/放弃/撤销、有效期与作用域过滤 | `memory-service.cjs` |
| 对话 | 会话/请求/快照持久化、真实取消、失败重试、记忆候选确认、长会话摘要 | `review-chat.cjs` |
| Tool 协议 | 权限/开关/执行器三重门禁 + 参数脱敏 + 审计（无真实执行器时明确阻断） | `tool-protocol.cjs:52-118` |
| 存储 | 临时文件 + rename 原子写、路径段净化、文件哈希 | `storage.cjs:19-38,81-140` |
| 导出门禁 | draft/formal 双模式、28 阻断码、14 降级码、策略版本 `review-export@2.0.0`、DOCX 块锚点"哈希+块内范围+唯一性"校验 | `validator.cjs` |
| 导出 | DOCX/PDF/XLSX/JSON 四格式，草稿/正式双标记，JSON 保留清单/事实/覆盖/上下文 | `exporter.cjs` |
| 安全边界 | `sandbox: true` + `contextIsolation` + 最小 IPC 白名单 + safeStorage 凭据加密 | `main.cjs:39-45`、`preload.cjs`、`credential-store.cjs` |

### 2.2 渲染层（`src/`）

外壳分组导航与风险徽标、`aria-live` toast、7 阶段流水线可视化与失败重试、风险点击→页码高亮→滚动、划词标记与局部审查（`charRange` + `text_hash` 留痕）、等级筛选、清单六层筛选 + 人工复核表单、对话上下文 chip / SSE 流式 / 停止 / 重试 / 引用回跳 / 记忆冲突三选一、知识库全选与批量删除、快照发布确认、模型表 + 连接测试 + 凭据掩码、四类设置项，以及 `runId` + `sequence` 丢弃过期进度的并发基础。

### 2.3 质量体系

177 项测试（157 顶层 + 20 子测试）覆盖 validator 15 项、模型集成 18 项、P0 引擎 16 项、对话上下文记忆 14 项、状态管理 13 项、风险流 11 项、IPC 8 项等；含真实合同 DOCX/PDF 双格式夹具回归（24 项确定性结果 + 95 项清单状态逐项一致）。

---

## 3. P0 加强项（阻断可信度与可靠性）

| # | 加强项 | 证据 | 影响 | 建议 | 量 |
|---|---|---|---|---|---|
| P0-1 | **导出门禁信任边界倒置** | `main.cjs:402` 用渲染层提交的 `payload.review` 作为唯一校验输入；`test/task-deletion-ipc.test.cjs:187-199` 把"用 `review_version_id=old-review` 的旧快照导出"固化为通过用例；`state:save`（`main.cjs:395`）无校验，可改写审计与 `deletedProjectIds`，解除删除保护（`main.cjs:405`） | 门禁可被绕过；导出件与持久化版本无绑定、不可追溯，违反 M3-A-002 | 导出/校验一律按 `project_id` 从 storage 重读 review 作为唯一输入；导出记录写内容哈希；`state:save` 收敛为受校验的域更新 | M |
| P0-2 | **正式门禁实际不可达，draft 成为事实默认** | 文本齐备合同仍有约 35 项 high 恒 `unverifiable`（`GC-2-01/GC-3-01/GC-4-01` 等在 `general-checklist.cjs` 无判定分支，只落默认分支 `:174`）→ `review-runner.cjs:244-245` 恒 `partial` → `validator.cjs:247-249` 恒阻断；同时 `checklist-policy.cjs:17` 只接受 `pass/not_applicable`，而 `checklistReview.mjs:13` 与 `docs/通用风险审查清单强化实施记录.md:27` 允许 `unverifiable`（`checklist-review.test.cjs:15` 已固化） | 真实"无法核验"的结论无法解除阻断，用户被逼走 `draft`（放开 14 个降级码），正式报告形同虚设 | 补无判定项的规则或显式 `not_automated` 状态；`validHumanReview` 接受 `unverifiable` + 强制理由与材料；对"不可自动判定"项与"真缺材料"项分开计数 | M |
| P0-3 | **任务取消 / 进程中断 / 恢复全部缺失** | `task.checkpoint_id`（`main.cjs:372`）、`idempotency_key`（`:373`）生成后全库 0 次读取；`review:run` 不接收 `AbortSignal`，`review-runner.cjs` 全程不传 signal；取消 IPC 只存在于对话链路（`review-chat.cjs:776`） | 断网/超时/关窗后任务永久停在 `running`，无 `cancelled` 终态、无 `TASK_001/TASK_002` 判定；只能整任务重跑，违反状态文档 §2.2/§2.3 | `review:cancel` IPC + signal 贯通 runner/gateway；每步落 cursor 与 artifact 哈希，启动时清理孤儿 `running` 任务 | M–L |
| P0-4 | **幂等键不生效，重跑产生重复副作用** | `review-runner.cjs:381` 每次新建 `review_version_id`；`risk_id` 由 title+page+clause 哈希（`review-engine.cjs:32`），不含输入版本；`main.cjs:300` 按 projectId 覆盖并追加审计 | 重跑后旧/新风险并存于历史导出，审计链与"重复副作用为 0"（M3-A-011）不符 | 建 `(idempotency_key, 请求指纹)` 唯一表，命中返首次结果、冲突返 `CONCURRENCY_001`；risk_id 加入输入版本 | M |
| P0-5 | **错误码未归一化为 `DOMAIN_NNN`** | 全仓 `grep '[A-Z]{3,}_\d{3}'` 命中 0；实际使用 42 个描述型码，其中 `MODEL_CONTEXT_INSUFFICIENT/TRUNCATED`、`MODEL_INPUT_INVALID`、`MODEL_ROLE_UNSUPPORTED`、`MODEL_REQUEST_CANCELLED`、`EXTRACTION_*`、`EMBEDDING_DEGRADED` 连状态文档 §7.6 兼容映射表都未登记 | 违反状态文档 §7.1/§8.5；错误无法按域统计与门禁 | 建 code → `DOMAIN_NNN` 映射表 + 单测断言"未登记码为 0"；新代码只允许规范码 | M |
| P0-6 | **人工修订能力严重不足** | `ReviewWorkspace.vue:584-588` 等级/类别/主题/标题/分析/建议/依据全部只读；`review.js:225-239` 的 `applyRiskAction` 只改 `human_status`；全仓无 undo/revert，`humanRevisions` 只写不读、无历史查看；删除风险（`:581`）无二次确认 | 需求 FR-041–FR-044 与 M3-C-001/C-002 未落地；误操作不可逆，修改无法追溯 | 受控编辑表单（枚举下拉 + 原因必填）→ 生成新 `review_version_id` 并过 Validator；修订历史面板与撤销；删除二次确认 | L |

---

## 4. P1 加强项（可用性、一致性与可观测性）

| # | 加强项 | 证据 | 影响 | 建议 | 量 |
|---|---|---|---|---|---|
| P1-1 | 记忆注入缺二次校验，撤销/过期仍有注入路径 | 过滤只在 `recallMemories`（`memory-service.cjs:84-89`）；`context-assembler.cjs:194-203` 对传入 memories 原样注入，无状态/有效期复核；记忆引用硬编码 `verification_status:"verified"`（`:214`），`citationBasis` 又置 `status:"published"`（`review-chat.cjs:180`） | 任一调用方传错即绕过过滤；企业经验在导出中呈现为"已发布依据" | 装配时重跑 status/valid_until/scope/sensitivity 过滤；记忆引用降级为非 published 来源标签 | S |
| P1-2 | 单条记忆无长度上限，预算耗尽静默丢指令 | `context-assembler.cjs:81,96` 只限条数；超大记忆可挤掉 `current_page` 等 section，仅 `required:true` 的 system/user_request 被压缩（`:265-268`）；预算耗尽时 `user_request` 被丢弃只记 omitted（`:273-275`），不报错 | 上下文质量不可预测，且失败不可见 | 单条上限 + 超限摘要降级；`user_request` 丢失必须上抛错误码；omit 明细进快照 | S |
| P1-3 | 检索降级不可观测 | 未配置 embedding 模型时 `knowledge-retrieval.cjs:106` 置 `disabled`，静默走关键词；`review-runner.cjs:377` 只处理 `status==="degraded"`，`not_configured` 不报码不加审计，界面仍显示"混合检索"；缓存指纹（`:101`）不含维度与切分版本 | 界面呈现的能力与实际召回路径不符，违反"不伪造召回" | 所有未接入/未配置状态一律落 `RETRIEVAL/MODEL` 域码与审计，并在界面标注实际路径 | S |
| P1-4 | 状态写冲突与跨项目丢更新 | `runningReviewProjects` 仅按 projectId 加锁，不同项目可并发 runReview，结尾各自 `loadState` 后整表覆盖写（`main.cjs:294-302`）；渲染层 `persist()`（`review.js:59-61`）提交整个 state；`storage.cjs:66-75` 是无 `expected_version` 的读-改-写 | 并发审查或"审查中改设置"会丢更新；删除保护可被旧快照写回覆盖 | 引入 `state_version` + CAS（乐观锁）；渲染层改为按域更新 IPC；主进程写队列串行化 | M |
| P1-5 | 风险清单筛选/排序不足，空态误导 | `ReviewWorkspace.vue:55,548` 仅等级筛选，无类别/主题/`human_status`/`evidence_status` 过滤，无排序（`:551`）；`:563` 空态文案在"筛选无结果"时仍显示"暂时没有风险项" | 42+ 条候选风险（含 31 项待核验）无法聚焦待办子集 | 多条件筛选 + 排序（等级/证据/置信度/条款号）+ 区分"无数据"与"筛选无结果" | M |
| P1-6 | 定位闭环不完整 | 原文 mark 只有 `data-risk` 可点（`:209-212`），`data-annotation` 已写入（`:154`）但点击不处理，CSS 却给 `cursor:pointer`（`styles.css:259`）；无上/下一条风险导航；详情面板仅 quote，无上下文对照（`:584`）；搜索仅当前页（`:95-98,180-189`） | 人工高亮"假可点"；无法逐条核验；违反 FR-143 全文搜索 | 双向定位（原文↔清单）、上下条步进、邻域上下文对照、全文搜索 + 防抖 | M |
| P1-7 | 无批量操作；FR-041"驳回"动作缺失 | `:550-561` 无多选与批量键；`review.js:225` 仅 `accepted/false_positive/modified/deferred/deleted`，无"驳回" | 逐条处理成本线性增长；需求动作未覆盖 | 多选 + 批量接受/驳回/延期；补齐 `rejected` 语义与原因输入 | M |
| P1-8 | 修订历史与撤销缺失 | `humanRevisions` 只在 `review.js:230-241` 写入，无读取入口；无 undo/revert | 违反 M3-C-001/C-005"保留修改前后值"，误操作不可逆 | 修订历史时间线 + 一键回滚（生成新版本，不原地改终态） | M |
| P1-9 | 导出与长报告输出质量 | `findCjkFont`（`exporter.cjs:149-158`）失败时静默降级 Helvetica 并把中文替换为 `?`（`:171-179,208`）且导出件无告警；PDF 无书签（`:249-250` 仅 setTitle/setSubject）；`exportRecords` 已建模（`sampleData.js:250`）但无导出历史/预览/失败重试 UI；`wrapText`（`:133-147`）逐字符累计比较为 O(n²)；校验阻断项 `riskId` 仅展示不可跳转（`ExportValidation.vue:28`） | 跨机（无 Windows 中文字体）正式报告中文全变问号且无检测；导出不可追溯、不可修正 | 字体降级写 warning 码并通过 Validator 暴露；补 PDF 书签与 XLSX 列宽/冻结；导出历史与预览；阻断项一键跳转 | M |

---

## 5. P2 加强项（覆盖度与体验）

| # | 加强项 | 证据 | 建议 | 量 |
|---|---|---|---|---|
| P2-1 | 解析容错与边界未测 | `parser.test.cjs` 仅 5 例；未覆盖 `scanned_pdf` 分支（`parser.cjs:214-232`）、`MAX_FILE_SIZE`（`:249`）、`MAX_PAGE_COUNT`（`:142,:180`）、`FILE_NOT_FOUND/NOT_A_FILE`（`:242-246`）；加密 PDF 的 `PasswordException` 无 try/catch；DOCX 文本无 `\f`，`pageCount` 恒为 1，页数上限对 DOCX 是死代码 | 异常输入归一化为 `PARSE_001`/`INPUT_002`；用真实页数或 XML 计数；补 6 例边界测试 | M |
| P2-2 | 无障碍、性能与状态一致性欠账 | 全仓 `tabindex`/`focus()` 0 处；`Modal.vue:13-19` 无焦点陷阱/自动聚焦/焦点归还；无 `prefers-reduced-motion` 而 `.spin` 无限动画（`styles.css:148`）；风险列表全量 `v-for` 无虚拟滚动；每次操作经 `clonePayload` 全量深拷贝持久化；`applyRiskAction`（`review.js:220-244`）无忙锁的读-改-写竞态；`saveModel/toggleSkill/addKnowledge` 等无忙锁；导出弹窗切换即校验无 `requestId` 守卫（`App.vue:210-211`）；`autoSave/autoSaveInterval` 可配但从不读取 | 焦点管理 + Escape/焦点归还；虚拟滚动；持久化防抖；写操作忙锁与幂等；校验请求序号守卫；补齐设置项生效链路 | M–L |
| P2-3 | 契约—实现不一致与支撑测试缺口 | 字段字典 §1.1 要求 snake_case，但 `documentType`/`fileVersionId` 为 camelCase（`parser.cjs:127`、`validator.cjs:132`、`exporter.cjs:72`）且无适配层；`validator.cjs:263` 只校验 6 个必填字段，未校验 §3.2 标"是"的 `risk_topic/analysis/confidence/provenance/created_by`；任务状态白名单（`validator.cjs:102`）漏 `submitted/input_required/validating/waiting_confirmation`（§2.3）；11 个阻断码与 7 个草稿降级码在 `test/` 中 0 命中；`test/fixtures` 目录不存在，`m3-regression.test.cjs`、M3 回归报告、质量阈值文件均缺；`general-checklist.test.cjs:12-16` 不比对严重度，65 个 GC 编号零引用；无性能/压力/崩溃恢复测试；`credential-store.test.cjs` 仅 1 例（`CREDENTIAL_STORE_CORRUPTED`、无 safeStorage、解密失败未测）；`validator.cjs:68-70` 只扫 `sk-` 形态，AKIA/Bearer/PRIVATE KEY 未测 | 收敛字段命名或加适配层；补 §3.2 必填与状态机校验；按码补正反例（表驱动）；建 `fixtures/golden-set` + 指标化回归；补严重度映射与密钥形态测试 | M–L |

---

## 6. 建议的推进路线

### 第一阶段：让门禁可信、任务可靠（P0-1 ~ P0-5）

1. **导出信任边界收口**（P0-1，M）：主进程按 `project_id` 重读 review；导出记录绑定内容哈希；`state:save` 拆成受校验的域更新。
2. **正式门禁可达性修复**（P0-2，M）：统一 `validHumanReview` 与 `checklistReview.mjs` 的 outcome 契约；对无自动判定项的 GC 条目显式标记并在清单/校验中区别计数。
3. **取消、Checkpoint、幂等**（P0-3、P0-4，L）：`review:cancel` + signal 贯通；步骤 cursor 落库；启动清理孤儿 `running`；幂等表与 `CONCURRENCY_001`。
4. **错误码归一化**（P0-5，M）：建映射表 + "未登记码为 0" 单测。
5. **回归网先行**（P2-3 的测试部分，S–M）：11 个阻断码 + 7 个降级码表驱动补测，成本低但立刻形成保护。

对应阶段文档：**M3-B 任务可靠性和可恢复执行**。

### 第二阶段：人工闭环与交互质量（P0-6、P1-5 ~ P1-9）

6. 人工修订编辑入口 + 原因留痕 + 新版本 + 撤销与修订历史（P0-6、P1-8，L）。
7. 风险清单多条件筛选/排序/批量操作，补齐"驳回"动作（P1-5、P1-7，M）。
8. 定位闭环：双向定位、上下条导航、上下文对照、全文搜索（P1-6，M）。
9. 导出质量与历史：字体降级告警、PDF 书签、XLSX 列宽、导出历史与预览、阻断项跳转（P1-9，M）。

对应阶段文档：**M3-C 人工修订和局部审查收口**。

### 第三阶段：检索治理与度量体系（P1-1 ~ P1-4、P2-1 ~ P2-3）

10. 记忆注入二次校验、单条记忆上限、降级可观测（P1-1 ~ P1-3，S）。
11. `state_version` + CAS 与写队列，消除跨项目丢更新（P1-4，M）。
12. Golden Set + 指标化回归报告 + 覆盖率最低阈值门禁；解析边界、无障碍、性能补齐（P2-1 ~ P2-3，L）。

对应阶段文档：**M3-D 固定夹具和回归门禁**、**M3-E 混合记忆检索与上下文质量验证**。

---

## 7. 不改变现有契约前提下的最小收益清单

如果资源只够做三件事，建议**只做这三件**，它们分别恢复"门禁可信""正式报告可出""任务不卡死"，且互相独立、可单独验收：

1. `main.cjs` 导出/校验改为按 `project_id` 从 storage 重读 review，并给导出记录加内容哈希（P0-1）。
2. 修复 `validHumanReview` 与 `checklistReview.mjs` 的 outcome 契约冲突，并对无自动判定能力的 GC 条目显式标注（P0-2）。
3. 增加 `review:cancel` IPC 与 signal 贯通，启动时把孤儿 `running` 任务归一化为 `failed/cancelled`（P0-3 的可交付子集）。

三项合计约 1–2 周，不需要改动脉络架构，也不影响现有 177 项测试。

---

## 附录：证据与核验记录

- 自动化测试：`npm test` → 177 通过、0 失败、0 跳过（2026-09-17 本机执行）。
- 本报告关键结论的自行核验点：`main.cjs:395-461`、`test/task-deletion-ipc.test.cjs:187-199`、`electron/checklist-policy.cjs:15-23`、`electron/validator.cjs:234-251`、`electron/general-checklist.cjs:161-174`、`src/services/checklistReview.mjs:13`、`electron/exporter.cjs:149-179`、`electron/storage.cjs:32-75`、`electron/review-runner.cjs:175-392`、`src/stores/review.js:59-65,220-244,335-366`。
- 分工来源：主进程链路审计、渲染层交互审计、质量门禁审计三份独立审计报告；其中渲染层完整版另存为 `docs/渲染层交互审计报告.md`。
- 相关既有文档：`docs/合同审查Agent-M3需求追踪矩阵.md`（M3-B~M3-E 全部为 `planned`）、`docs/合同审查Agent技术实现阶段文档.md` §11–§12、`docs/合同风险漏检根因分析与改进方案.md` §12、`docs/通用风险审查清单强化实施记录.md`。
