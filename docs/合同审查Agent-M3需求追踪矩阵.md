# 合同审查 Agent M3 需求追踪矩阵

> 文档版本：M3-A-1.0
>
> 基线：`合同审查 Agent 需求说明.md` v0.4、`合同审查Agent技术实现阶段文档.md` M3 章节
>
> 状态：M3-A 首版冻结（2026-09-15）
>
> 说明：本矩阵覆盖 M3-A 至 M3-E 的阶段要求。`contract_frozen` 表示契约已冻结，`planned` 表示已定义但尚未实现，`verified` 只能在测试和验收证据归档后使用。

## 1. 追踪规则

M3 采用以下闭环：

```text
阶段需求 ID -> 需求/设计依据 -> 字段/状态/错误码契约 -> 代码区域 -> 测试用例 -> 验收用例 -> 指标/门禁 -> 证据
```

每一行只能表达一个可独立判定的断言；同一断言有多个失败原因时，在测试用例中拆分检查项。矩阵中的路径和测试 ID 是稳定引用，文件重命名或测试重组时必须同步更新本表。

状态定义：

| 状态 | 含义 |
|---|---|
| `contract_frozen` | 字段、枚举、状态或错误码已在 M3-A 契约中冻结。 |
| `planned` | 已有实现任务、测试和验收入口，但尚未形成通过证据。 |
| `in_progress` | 已开始实现或测试，尚未满足验收门槛。 |
| `verified` | 测试、验收和证据引用均已归档，可声明完成。 |
| `blocked` | 存在阻断缺口或待确认决策，不能继续标记完成。 |

## 2. M3-A 契约和状态机追踪

| 需求 ID | 可验证需求 | 需求/设计依据 | 契约位置 | 代码区域 | 测试用例 | 验收用例 | 指标/门禁 | 状态 |
|---|---|---|---|---|---|---|---|---|
| M3-A-001 | 风险必须使用统一的等级、类别、主题、结论、证据和人工状态字段。 | FR-120–FR-124、需求说明 §7.8 | 字段字典 §2.2、§3.2 | `review-engine.cjs`、`validator.cjs`、`review-chat.cjs` | `M3A-RISK-001` | `AC-M3-A-001` | 未知枚举阻断；高风险无证据不得确认 | contract_frozen |
| M3-A-002 | 风险定位、依据和来源必须绑定合同文件版本并可追溯。 | FR-016、FR-023–FR-025、DATA-002 | 字段字典 §3.2 `ContractLocation`/`EvidenceRef` | `review-engine.cjs`、`validator.cjs` | `M3A-RISK-002` | `AC-M3-A-002` | 定位/证据缺失不得进入完成 | contract_frozen |
| M3-A-003 | 任务状态只能按冻结的事件、守卫和次态转移。 | FR-140–FR-141、需求说明 §11.1 | 状态文档 §2 | `review-runner.cjs`、`main.cjs`、`review.js` | `M3A-TASK-001` 至 `M3A-TASK-003` | `AC-M3-A-003` | 未定义组合返回 `STATE_001` | contract_frozen |
| M3-A-004 | 任务终态 `completed`/`cancelled` 不得原地修改。 | FR-005、FR-043、DATA-003 | 状态文档 §2.2 | `review-runner.cjs`、`managementState.mjs` | `M3A-TASK-004` | `AC-M3-A-004` | 修订必须创建新版本 | contract_frozen |
| M3-A-005 | 模型配置必须经过测试后才能进入 `active`，配置或凭据变化必须重新测试。 | FR-070–FR-078、需求说明 §7.11.5 | 状态文档 §3 | `managementState.mjs`、`model-gateway.cjs` | `M3A-MODEL-001` 至 `M3A-MODEL-003` | `AC-M3-A-005` | 未测试模型不得被任务选择 | contract_frozen |
| M3-A-006 | Skill 必须经过隔离校验，未通过或被隔离的版本不得启用。 | FR-080–FR-086、需求说明 §8.6 | 状态文档 §4 | `tool-protocol.cjs`、Skill 管理模块 | `M3A-SKILL-001` 至 `M3A-SKILL-002` | `AC-M3-A-006` | 任一安全阻断项错误放行即阻断 | contract_frozen |
| M3-A-007 | Tool 调用必须先校验 Schema 和权限，并按确认、阻断、执行、失败和超时状态记录。 | FR-090–FR-094、需求说明 §9.4 | 状态文档 §5 | `tool-protocol.cjs` | `M3A-TOOL-001` 至 `M3A-TOOL-004` | `AC-M3-A-007` | 失败不得当作成功；写入调用幂等 | contract_frozen |
| M3-A-008 | 企业记忆只能从候选经确认成为正式记忆，撤销/过期后默认不可召回。 | FR-100–FR-106、设计方案 §7/§10 | 状态文档 §6.1、字段字典 §2.5 | `memory-service.cjs`、`review-chat.cjs` | `M3A-MEMORY-001` 至 `M3A-MEMORY-003` | `AC-M3-A-008` | 过期/撤销/越权记忆不得注入 | contract_frozen |
| M3-A-009 | 所有错误必须使用 `DOMAIN_NNN` 规范码、统一响应字段和可追溯 Trace。 | 需求说明 §11.4.1、FR-092、FR-123 | 状态文档 §7.1–§7.5 | 全部主进程模块、IPC 边界 | `M3A-ERR-001` 至 `M3A-ERR-003` | `AC-M3-A-009` | 错误响应字段完整；详情脱敏 | contract_frozen |
| M3-A-010 | 现有描述型错误码必须可映射到规范码，新写入不得产生未登记错误码。 | 现有 P0/P1 实现和错误码兼容要求 | 状态文档 §7.6 | `model-gateway.cjs`、`review-chat.cjs`、`tool-protocol.cjs` | `M3A-ERR-004` | `AC-M3-A-010` | 未登记错误码数量为 0 | contract_frozen |
| M3-A-011 | 相同幂等键重复请求返回原结果，不同请求复用幂等键返回并发冲突。 | DATA-003、FR-093、需求说明 §11.3 | 状态文档 §1.1、§7.3 | `storage.cjs`、`review-runner.cjs`、`tool-protocol.cjs` | `M3A-IDEMP-001`、`M3A-IDEMP-002` | `AC-M3-A-011` | 重复风险/Artifact/审计副作用为 0 | contract_frozen |
| M3-A-012 | 每次状态转移和错误都写入审计和 Trace，且不得包含凭据或不必要原文。 | SEC-003、SEC-005、DATA-004 | 状态文档 §1.1、§8 | `storage.cjs`、`tool-protocol.cjs`、审计写入点 | `M3A-AUDIT-001`、`M3A-AUDIT-002` | `AC-M3-A-012` | 敏感泄漏任意 1 例即阻断 | contract_frozen |
| M3-A-013 | M3-A 需求、契约、测试和验收必须通过本矩阵互相回溯。 | 需求说明 §21、M3 章节 12.2 | 本文档 §2–§6 | 需求/测试管理流程 | `M3A-RTM-001` | `AC-M3-A-013` | 不允许无需求 AC 或无 AC 需求 | contract_frozen |

## 3. M3-B 任务可靠性追踪

| 需求 ID | 可验证需求 | 契约/设计依据 | 代码区域 | 测试用例 | 验收用例 | 门禁 | 状态 |
|---|---|---|---|---|---|---|---|
| M3-B-001 | 任务保存步骤游标、Checkpoint 和恢复入口。 | FR-140–FR-142、状态文档 §2.3 | `review-runner.cjs`、`storage.cjs` | `M3B-RECOVERY-001` | `AC-M3-B-001` | 恢复后游标和版本一致 | planned |
| M3-B-002 | 解析、检索、模型、验证和持久化步骤使用稳定幂等键。 | DATA-003、状态文档 §1.1/§2.3 | `review-runner.cjs` | `M3B-IDEMP-001` | `AC-M3-B-002` | 重复副作用为 0 | planned |
| M3-B-003 | 模型超时、取消、进程中断和不可重试错误进入正确次态。 | FR-077、FR-141、状态文档 §2.2 | `review-runner.cjs`、`model-gateway.cjs` | `M3B-FAILURE-001` 至 `M3B-FAILURE-004` | `AC-M3-B-003` | 每类故障状态和错误码可回放 | planned |
| M3-B-004 | 恢复两次不得重复风险、版本、导出或审计写入。 | DATA-003、状态文档 §2.3 | `review-runner.cjs`、`exporter.cjs` | `M3B-RECOVERY-002` | `AC-M3-B-004` | 重复写入为 0 | planned |
| M3-B-005 | 会话摘要检查点与审查任务检查点分离。 | 对话设计方案 §10、M3 章节 12.2 | `review-chat.cjs`、`context-assembler.cjs` | `M3B-CHECKPOINT-001` | `AC-M3-B-005` | 恢复引用类型正确 | planned |

## 4. M3-C 人工修订和局部审查追踪

| 需求 ID | 可验证需求 | 契约/设计依据 | 代码区域 | 测试用例 | 验收用例 | 门禁 | 状态 |
|---|---|---|---|---|---|---|---|
| M3-C-001 | 人工编辑受控修改风险等级、类别、主题、分析、建议、结论、证据和定位。 | FR-041–FR-044、字段字典 §3.2 | `src/components/ReviewWorkspace.vue`、`managementState.mjs` | `M3C-EDIT-001` | `AC-M3-C-001` | 未知枚举和无定位按契约阻断 | planned |
| M3-C-002 | 人工新增风险保存原因、证据状态和原文定位，并默认待核验。 | FR-044、字段字典 §2.2 | `managementState.mjs`、`validator.cjs` | `M3C-ADD-001` | `AC-M3-C-002` | 默认 `candidate + unverified + pending_review` | planned |
| M3-C-003 | 同一选区重新审查复用锚点并生成新的上下文快照和结果版本。 | FR-036–FR-039、设计方案 §6 | `review-chat.cjs`、`context-assembler.cjs` | `M3C-REVIEW-001` | `AC-M3-C-003` | 旧版本只读且引用可回放 | planned |
| M3-C-004 | 聊天结果区分企业记忆、法律依据和合同原文，并显示来源、作用域、置信度和有效期。 | FR-101、设计方案 §5/§6 | `ReviewWorkspace.vue`、`context-assembler.cjs` | `M3C-CITATION-001` | `AC-M3-C-004` | 不得把记忆伪装为法律依据 | planned |
| M3-C-005 | 人工修订、局部审查和聊天风险都进入新 `review_version_id` 并经过 Validator。 | FR-043、FR-046、FR-121 | `managementState.mjs`、`validator.cjs` | `M3C-VERSION-001` | `AC-M3-C-005` | 未验证风险不得绕过导出门禁 | planned |

## 5. M3-D 固定夹具和回归门禁追踪

| 需求 ID | 可验证需求 | 契约/设计依据 | 代码/资料区域 | 测试用例 | 验收用例 | 门禁 | 状态 |
|---|---|---|---|---|---|---|---|
| M3-D-001 | 采购合同 Golden Set 覆盖正常、规则、模型失败、证据缺失、定位失败、人工修订和导出阻断。 | 需求说明 §17.1、M3 章节 12.2 | `test/fixtures/golden-set/` | `M3D-GS-001` | `AC-M3-D-001` | 夹具版本、哈希和标注齐全 | planned |
| M3-D-002 | 每个样例具有固定输入、预期风险、必需依据、定位容差和禁止动作。 | 需求说明 §17.1、§17.3 | `test/fixtures/golden-set/` | `M3D-GS-002` | `AC-M3-D-002` | 非开发人员可独立判定 | planned |
| M3-D-003 | 现有自动化测试按单元、集成、编排和导出门禁分层并有 M3 入口。 | M3 章节 12.2 | `test/m3-regression.test.cjs` | `M3D-REG-001` | `AC-M3-D-003` | 回归报告记录通过/失败和版本 | planned |
| M3-D-004 | 回归报告记录结构化输出、任务完成、定位、证据、重复副作用和导出阻断结果。 | KPI-001–KPI-020、M3 章节 12.2 | `docs/合同审查Agent-M3回归报告.md` | `M3D-REPORT-001` | `AC-M3-D-004` | 指标有样本量和基线差异 | planned |
| M3-D-005 | 质量阈值由业务、法务和研发共同确认，建议值不直接作为正式门禁。 | 需求说明 §0、§17.2 | M3 章节 12.2/12.4 | `M3D-GATE-001` | `AC-M3-D-005` | 待确认项有责任人和截止状态 | planned |

## 6. M3-E 混合记忆检索追踪

| 需求 ID | 可验证需求 | 契约/设计依据 | 代码区域 | 测试用例 | 验收用例 | 门禁 | 状态 |
|---|---|---|---|---|---|---|---|
| M3-E-001 | 以自然语言保存原始 query、规范化 query、哈希和规范化版本。 | FR-101、M3-E 数据契约 | `review-chat.cjs`、`context-assembler.cjs` | `M3E-QUERY-001` | `AC-M3-E-001` | 原始 query 不丢失 | planned |
| M3-E-002 | 记忆保存 embedding、模型版本、维度和索引版本，版本不匹配不得进入向量路由。 | FR-071、M3-E 任务范围 | `memory-service.cjs`、向量适配器 | `M3E-VECTOR-001` | `AC-M3-E-002` | 非法向量/索引版本明确报错 | planned |
| M3-E-003 | 关键词检索独立覆盖金额、比例、条款号、专名和精确短语。 | FR-006、FR-101、M3-E 任务范围 | `memory-service.cjs` | `M3E-KEYWORD-001` | `AC-M3-E-003` | 关键词基线可复现 | planned |
| M3-E-004 | 实体/图路径覆盖合同类型、项目/组织、风险主题、冲突键、来源和关联邻居。 | FR-100–FR-105、M3-E 任务范围 | 图信号适配器 | `M3E-GRAPH-001` | `AC-M3-E-004` | 图信号不得绕过权限/有效期 | planned |
| M3-E-005 | 向量、关键词和图三路并行执行，并分别记录超时、候选数和路由状态。 | M3-E 任务范围、上下文设计方案 §5 | `memory-retrieval` 适配层 | `M3E-ROUTE-001` | `AC-M3-E-005` | 单一路径失败不拖垮可用路径 | planned |
| M3-E-006 | 候选进入融合前通过状态、撤销、有效期、作用域、敏感等级、来源和数据策略硬过滤。 | FR-101、FR-104、SEC-001/004 | `memory-service.cjs`、权限过滤器 | `M3E-FILTER-001` 至 `M3E-FILTER-003` | `AC-M3-E-006` | 过期/越权/敏感泄漏为 0 | planned |
| M3-E-007 | 相同记忆多路去重并按带权 RRF 融合，保留各路 rank 和原始 score。 | M3-E 数据契约、上下文设计方案 §5 | `memory-retrieval` 适配层 | `M3E-RRF-001`、`M3E-RRF-002` | `AC-M3-E-007` | RRF 可按快照回放 | planned |
| M3-E-008 | Cross-Encoder 只重排 RRF 后 Top 20–50 候选，失败时降级为 RRF。 | FR-071、FR-077、M3-E 任务范围 | reranker 适配器 | `M3E-RERANK-001`、`M3E-RERANK-002` | `AC-M3-E-008` | 不改变硬过滤结果 | planned |
| M3-E-009 | 最终仅注入 Top-K 少量记忆，并受 Token budget 和单条记忆上限约束。 | FR-101、NFR-001、上下文设计方案 §6 | `context-assembler.cjs` | `M3E-CONTEXT-001` | `AC-M3-E-009` | 注入数量和预算不超限 | planned |
| M3-E-010 | ContextSnapshot 记录 query、配置、路由、过滤、RRF、重排、模型版本和 fallback。 | DATA-002、M3-E 数据契约 | `context-assembler.cjs`、`review-chat.cjs` | `M3E-AUDIT-001` | `AC-M3-E-010` | 候选与实际注入可核对 | planned |
| M3-E-011 | Embedding、索引、reranker 或全部路径不可用时按契约降级，不伪造召回。 | FR-077、M3-E 任务范围 | 检索适配层、`review-chat.cjs` | `M3E-FALLBACK-001` 至 `M3E-FALLBACK-004` | `AC-M3-E-011` | machine-readable fallback 完整 | planned |

## 7. 证据归档和变更控制

### 7.1 每项需求的最小证据

每行至少归档以下内容后才能从 `planned` 变为 `verified`：

1. 需求和契约版本：需求 ID、本文档版本、字段/状态/错误码契约版本。
2. 代码引用：实现文件、函数或 IPC 名称；如果尚未实现，保留 `planned`。
3. 测试结果：测试文件、测试 ID、执行命令、执行时间、通过/失败数量和日志摘要。
4. 验收结果：验收人员、夹具版本、输入哈希、预期与实际、判定和失败分类。
5. 指标结果：样本量、基线、当前值、置信区间（适用时）和门禁结论。
6. 变更记录：需求、Schema、状态或错误码变化的原因、影响范围和回滚方式。

### 7.2 M3-A 当前证据

| 交付物 | 版本 | 当前证据 | 状态 |
|---|---|---|---|
| `合同审查Agent字段与枚举字典.md` | M3-A-1.0 | 字段、枚举、核心对象、兼容规则已落盘 | contract_frozen |
| `合同审查Agent状态转移与错误码.md` | M3-A-1.0 | 任务/模型/Skill/Tool/记忆状态机和规范错误码已落盘 | contract_frozen |
| `合同审查Agent-M3需求追踪矩阵.md` | M3-A-1.0 | M3-A 至 M3-E 条目已编号并绑定测试/验收入口 | contract_frozen |
| 代码归一化和自动化测试 | 待实现 | 当前代码仍存在描述型错误码、中文记忆状态和兼容任务状态 | planned |

### 7.3 变更规则

- 修改字段必填性、枚举语义、状态转移守卫或错误码含义，必须递增契约版本并新增迁移/兼容测试。
- 新增需求必须先加入本矩阵，再进入代码或测试；没有需求 ID 的验收用例不得作为 M3 发布依据。
- 需求删除或降级必须保留原行，状态改为 `superseded` 或 `blocked`，并写明替代需求。
- 阶段文档的 M3-A 勾选项只能在三份交付物均存在且审查通过后标记完成；代码不一致必须继续在本表中保持 `planned`。

## 8. M3-A 完成判定

M3-A 的文档交付判定如下：

1. 三份交付物均存在，版本号一致，引用路径有效。
2. 风险字段和枚举、任务/模型/Skill/Tool/记忆状态机、统一错误响应和兼容映射均有唯一来源。
3. M3-A 每行都有需求依据、契约位置、测试 ID、验收 ID和门禁，不存在空白追踪列。
4. 所有未定义状态组合和未登记错误码均有阻断规则。
5. 文档结构检查、Markdown 代码围栏检查和 `git diff --check` 通过。

代码层完全收口仍需要后续实现：将现有描述型错误码转换为规范码、在 IPC 边界统一中文状态、补齐状态机守卫和自动化测试。完成这些工作后，才能把本矩阵中的 M3-A 行从 `contract_frozen` 更新为 `verified`。
