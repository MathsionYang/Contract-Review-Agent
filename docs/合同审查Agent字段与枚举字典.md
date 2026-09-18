# 合同审查 Agent 字段与枚举字典

> 文档版本：M3-A-1.0
>
> 基线：`合同审查 Agent 需求说明.md` v0.4
>
> 状态：M3-A 契约冻结版（2026-09-15）
>
> 适用范围：本地 Electron 主进程、渲染层 IPC、持久化状态、Trace/审计、模型/Tool 适配器和后续服务化实现。

## 1. 使用约定

本字典是字段命名、类型、必填性、枚举值和跨对象约束的单一参考。实现可以使用关系数据库、文档数据库或本地 JSON，但对外 IPC、审计和持久化字段不得另行定义同义字段。

| 术语 | 约束 |
|---|---|
| 必须 | 字段或行为是接口验收前提，缺失时返回错误，不得静默补默认值。 |
| 应当 | 默认实现要求；需要偏离时必须在配置或审计中说明原因。 |
| 可以 | 可选扩展，不得改变必需字段的语义。 |
| `null` | 已知字段但当前没有值；不得用空字符串代替。 |
| 未知枚举 | 不得透传到持久化层；在适配边界返回 `SCHEMA_001`。 |

### 1.1 全局类型和命名

| 项目 | 冻结规则 |
|---|---|
| 字段命名 | 持久化和 IPC 使用 `snake_case`；展示层可以使用中文标签。 |
| ID | 所有 `*_id` 为不可变、不可猜测的字符串；推荐 UUID 或同等强度标识。 |
| 版本 | `version`/`config_version`/`state_version` 为从 1 开始递增的整数；更新必须带 `expected_version`。 |
| 时间 | `created_at`、`updated_at`、事件时间使用 ISO 8601 UTC，例如 `2026-09-15T08:00:00Z`。 |
| 日期 | 仅表示自然日时使用 `YYYY-MM-DD`，不携带时区。 |
| 哈希 | 文件、文本、输入和配置内容使用小写十六进制 SHA-256，形式为 `sha256:<hex>`。 |
| 数值 | 比例、置信度和相似度使用 `[0,1]` 的 JSON number；金额使用字符串或定点 decimal，禁止二进制浮点直接作为金额持久化值。 |
| 大文本 | 合同原文、OCR、模型原始响应和检索全文通过 `Artifact` 引用；业务对象只保存摘要、哈希和引用。 |
| 删除 | 采用逻辑删除或 Tombstone；不得破坏历史审查版本、Trace、Artifact 和审计引用。 |

## 2. 共享枚举

### 2.1 合同、审查和数据策略

| 字段 | 允许值 | 说明 |
|---|---|---|
| `contract_type` | `procurement`、`supplier_service`、`sales_customer_service`、`property_lease`、`software_development`、`other` | 合同类型的持久化值；`other` 或未确认不得直接触发专项审查。 |
| `review_mode` | `standard`、`realtime`、`internet_lead` | `internet_lead` 只能形成线索或待核验项。 |
| `sensitivity_level` | `public`、`internal`、`confidential`、`restricted` | 出域、记忆注入、日志和导出均受此字段约束。 |
| `source_level` | `l1`、`l2`、`l3`、`l4`、`l5`、`rule`、`memory` | 法律来源、企业制度、案例/经验、规则和企业记忆的来源等级。 `l5` 不能单独支持确认法律结论。 |
| `source_status` | `draft`、`published`、`historical`、`in_force`、`superseded`、`revoked`、`invalid` | `published`/`in_force` 的含义由对象类型确定，来源必须同时满足有效期。 |
| `data_policy` | `local_only`、`approved_external`、`redacted_external`、`deny_external` | 模型或 Tool 使用前必须完成数据策略判断。 |
| `scope_type` | `system`、`organization`、`contract_type`、`project`、`user`、`task`、`file_version` | 作用域由窄到宽的优先级在权限策略中定义，不得通过字符串前缀猜测。 |

### 2.2 风险字段枚举

| 字段 | 允许值或约束 | 业务语义 |
|---|---|---|
| `risk_level` | `critical`、`high`、`medium`、`low`、`info` | `critical`/`high` 默认必须人工复核。 |
| `risk_category` | `legal`、`commercial`、`company_policy`、`text_quality`、`evidence` | 固定分类，不得写入“违约责任”等具体主题。 |
| `risk_topic` | 主题字典中的 `snake_case` 字符串 | 例如 `breach_liability`、`payment_condition`、`ip_ownership`、`termination`。未知主题必须标记 `topic_unmapped=true`，不得伪造已有主题。 |
| `conclusion_status` | `candidate`、`confirmed`、`needs_verification`、`rejected` | `needs_verification` 表示无法确认，不等于已确认风险。 |
| `evidence_status` | `verified`、`partially_verified`、`unverified`、`invalid`、`not_applicable` | 证据链状态；`invalid` 不得作为已验证依据展示。 |
| `human_status` | `pending_review`、`accepted`、`modified`、`false_positive`、`deferred`、`added_by_human`、`deleted` | 人工工作流状态，不替代结论状态。 |
| `realtime_verification_status` | `not_requested`、`verified`、`realtime_unverified`、`unavailable` | 只描述本次实时核验，不替代来源的法律效力状态。 |
| `confidence` | `number[0,1]` | 模型或规则对风险判断的置信度，不得解释为统计概率。 |
| `location_confidence` | `number[0,1]` | 原文定位置信度；定位失败时为 `0` 或 `null`，由 Schema 版本决定。 |

风险状态组合必须满足：

- `critical` 或 `high` 且 `evidence_status != verified` 时，`conclusion_status` 不得为 `confirmed`。
- `confidence` 或 `location_confidence` 低于项目阈值时，`conclusion_status` 至少为 `needs_verification`，并记录触发原因。
- `evidence_status=invalid` 时，法律依据不得进入“已验证依据”区域。
- 人工修改不得覆盖 AI 原始结果；必须创建新的 `review_version_id` 并保存差异。

### 2.3 任务和执行枚举

| 字段 | 允许值 |
|---|---|
| `task_type` | `full_review`、`selected_text_review`、`recheck`、`export`、`model_health_check`、`skill_validation` |
| `task_status` | `submitted`、`working`、`input_required`、`validating`、`waiting_confirmation`、`completed`、`partial`、`failed`、`cancelled` |
| `task_step` | `input`、`parse`、`classify`、`rules`、`retrieve`、`model`、`validate`、`persist`、`export` |
| `review_source_type` | `initial`、`ai`、`human_revision`、`local_review`、`memory_candidate` |
| `review_status` | `draft`、`candidate`、`validated`、`superseded`、`rejected` |
| `artifact_status` | `staged`、`available`、`failed`、`deleted`、`quarantined` |
| `trace_status` | `started`、`running`、`completed`、`failed`、`blocked`、`cancelled` |
| `tool_status` | `queued`、`running`、`awaiting_confirmation`、`completed`、`failed`、`timed_out`、`blocked`、`cancelled` |

`completed` 和 `cancelled` 是任务终态；对已完成结果的修改必须创建新版本。实现中的 `running` 只能作为兼容输入映射到规范状态 `working`，不得作为新的持久化任务状态。

### 2.4 模型和 Skill 生命周期

| 对象 | 允许值 |
|---|---|
| `model_status` | `draft`、`testing`、`test_failed`、`active`、`disabled`、`unhealthy`、`credential_expired`、`revoked`、`rolled_back` |
| `model_role` | `analysis`、`extraction`、`embedding`、`rerank`、`vision` |
| `model_test_status` | `untested`、`running`、`passed`、`failed`、`expired` |
| `skill_status` | `uploaded`、`validating`、`validation_failed`、`installed`、`enabled`、`disabled`、`isolated`、`rolled_back`、`deprecated` |
| `skill_scope_type` | `system`、`organization`、`contract_type`、`project`、`user` |
| `binding_status` | `active`、`disabled`、`superseded`、`rolled_back` |

### 2.5 记忆和检索枚举

| 字段 | 允许值或约束 |
|---|---|
| `memory_type` | `policy_preference`、`review_practice`、`historical_case`、`user_preference`、`confirmed_correction`、`meta` |
| `memory_status` | `candidate`、`formal`、`revoked`、`expired`、`dismissed` |
| `retrieval_route` | `vector`、`keyword`、`graph` |
| `fallback_status` | `none`、`vector_unavailable`、`index_unavailable`、`reranker_unavailable`、`all_unavailable` |
| `filter_reason` | `not_formal`、`revoked`、`expired`、`future_effective`、`scope_mismatch`、`sensitivity_blocked`、`source_invalid`、`policy_blocked`、`version_mismatch` |

UI 现有的 `正式`、`候选`、`已撤销`是展示兼容值，边界适配器必须转换为 `formal`、`candidate`、`revoked` 后再进入持久化和检索契约。

## 3. 核心数据对象

### 3.1 `ReviewTask`

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `task_id` | `string` | 是 | 不可变主键。 |
| `project_id` | `string` | 是 | 必须指向当前项目。 |
| `file_version_id` | `string` | 是 | 任务只能绑定一个合同文件版本。 |
| `task_type` | enum | 是 | 见 2.3。 |
| `review_mode` | enum | 是 | 默认 `standard`。 |
| `status` | enum | 是 | 见任务状态机。 |
| `plan_version` | `string` | 是 | 执行计划版本。 |
| `cursor` | `object` | 是 | 当前步骤、序号和输入/输出 Artifact 引用。 |
| `task_budget_version` | `string` | 是 | Token、耗时和 Tool 次数预算版本。 |
| `retry_count` | `integer` | 是 | `>=0`，不得超过策略上限。 |
| `version` | `integer` | 是 | 乐观并发版本。 |
| `errors` | `ErrorRef[]` | 是 | 可为空数组；每项必须可追溯到 TraceEvent。 |
| `created_at`/`updated_at` | `datetime` | 是 | UTC。 |

### 3.2 `RiskItem`

| 字段 | 类型 | 必填 | 约束 |
|---|---|---:|---|
| `risk_id` | `string` | 是 | 不可变主键。 |
| `task_id`/`review_version_id` | `string` | 是 | 必须存在且属于同一项目。 |
| `risk_level`/`risk_category`/`risk_topic` | enum/string | 是 | 见 2.2。 |
| `title` | `string` | 是 | 非空，展示标题。 |
| `conclusion_status` | enum | 是 | 受证据和人工状态约束。 |
| `contract_location` | `ContractLocation` | 是 | 无法定位时保留对象并设置 `status=unresolved`，不得伪造页码。 |
| `legal_basis`/`company_basis` | `EvidenceRef[]` | 是 | 可为空，但必须与 `evidence_status` 一致。 |
| `analysis` | `string` | 是 | 结论分析，不得把推断写成已核实事实。 |
| `suggestion` | `string` | 否 | 修改建议。 |
| `confidence`/`location_confidence` | `number` | 是 | `[0,1]`。 |
| `evidence_status`/`realtime_verification_status`/`human_status` | enum | 是 | 见 2.2。 |
| `provenance` | `Provenance` | 是 | 必须包含来源步骤、规则/模型/知识版本。 |
| `created_by`/`created_at`/`updated_at` | string/datetime | 是 | 记录产生主体和时间。 |

`ContractLocation` 至少包含 `file_version_id`、`page`、`clause_no`、`char_range` 或 `bbox`、`quote`、`text_hash`、`status` 和 `location_confidence`。`EvidenceRef` 至少包含 `source_id`、`source_level`、`title`、`clause_no`/`article`、`status`、`version_label`、`evidence_quote`、`text_hash` 和 `retrieved_at`。

### 3.3 `Memory` 和 `ContextSnapshot`

`Memory` 必须包含：`memory_id`、`memory_type`、`scope`、`content`、`source_refs`、`evidence_refs`、`confidence`、`status`、`conflict_set`、`retrieval_policy`、`sensitivity_level`、`valid_from`、`valid_until`、`version`、`created_at` 和 `updated_at`。M3-E 增加 `embedding`、`embedding_model_version`、`embedding_dimension`、`index_version`，这些字段缺失或版本不匹配时不得进入向量路由。

`ContextSnapshot` 必须包含：`snapshot_id`、`query`、`review_id`、`file_version_id`、`selected_context`、`citations`、`memory_refs`、`retrieval_evidence`、`retained_sections`、`omitted_sections`、`token_budget`、`estimated_tokens`、`model_config_ref`、`schema_version`、`created_at`。`retrieval_evidence` 按 M3-E 契约保存各路候选数、rank、RRF、重排、过滤和 fallback，不保存敏感记忆全文。

### 3.4 `ModelEndpointConfig`、`SkillPackage`、`ToolExecution`

| 对象 | 必填字段 |
|---|---|
| `ModelEndpointConfig` | `model_config_id`、`provider_id`、`model_id`、`model_role`、`capabilities`、`context_window`、`max_output_tokens`、`timeout_seconds`、`retry_policy`、`data_policy`、`config_version`、`status`。API 地址和 `credential_ref` 只允许主进程读取，明文 Key 不属于此对象。 |
| `SkillPackage` | `skill_version_id`、`name`、`version_label`、`source`、`package_uri`、`sha256`、`permission_manifest`、`validation_report_id`、`status`。 |
| `ToolExecution` | `execution_id`、`tool_call_id`、`kind`、`name`、`requested_permission`、`permission_decision`、`sandbox`、`status`、`error_ref`、`started_at`、`completed_at`、`artifact_refs`。 |

### 3.5 错误、审计和并发对象

| 对象 | 最小字段 |
|---|---|
| `ErrorEnvelope` | `schema_version`、`code`、`message_key`、`retryable`、`suggested_state`、`details`、`trace_ref`。 `details` 只允许脱敏定位信息。 |
| `TraceEvent` | `event_id`、`trace_id`、`span_id`、`parent_event_id`、`task_id`、`event_type`、`status`、`error_code`、`input_summary`、`evidence_refs`、`artifact_refs`、`occurred_at`。 |
| `Checkpoint` | `checkpoint_id`、`task_id`、`state`、`state_version`、`plan_cursor`、`completed_steps`、`input_artifact_refs`、`output_artifact_refs`、`idempotency_key`、`human_decisions`、`last_error_code`、`created_at`。 |
| `AuditRecord` | `audit_id`、`actor_id`、`action`、`resource_type`、`resource_id`、`before_hash`、`after_hash`、`reason`、`trace_ref`、`created_at`。 |

## 4. 版本、兼容和校验规则

1. 影响字段含义、枚举或必填性的变化必须递增 `schema_version`，并提供迁移脚本或边界适配器。
2. 只增加可选字段时可以保持同一主版本，但必须更新字典和 RTM。
3. 枚举删除或含义改变属于破坏性变更，必须创建新 Schema，不得复用旧值。
4. 任何对象写入都必须检查 `expected_version`；并发冲突返回规范错误码 `CONCURRENCY_001`，兼容旧码 `IDEMPOTENCY_CONFLICT`。
5. 前端中文显示、旧字段别名和样例数据只能存在于适配层；模型、IPC、持久化和审计使用本字典的规范值。
6. `validator.cjs`、`review-engine.cjs`、`review-runner.cjs`、`tool-protocol.cjs` 和后续 `memory-retrieval` 适配器必须以本字典为输入校验基线。

## 5. M3-A 落地状态

- 字段、枚举、必填性和核心不变量已经冻结为本文件版本 `M3-A-1.0`。
- 任务、模型、Skill、Tool 和错误码状态机见《合同审查Agent状态转移与错误码》；需求、测试和验收映射见《合同审查Agent-M3需求追踪矩阵》。
- 当前 P0-P2 代码仍存在 `running` 任务状态、中文记忆状态和描述型错误码等兼容值；这些差异已登记到 RTM，必须在对应 M3-B/M3-C/M3-E 实现任务中完成边界归一化后，才可宣称代码与冻结契约完全一致。
## 6. 2026-09-18 审查证据与风险聚合扩展

本节补充运行时审查链路实际使用的兼容字段。新增字段不改变既有风险对象的核心枚举，但必须通过 `validator.cjs` 和导出校验。

| 字段 | 类型/取值 | 约束 |
| --- | --- | --- |
| `decision_confidence` | `high` / `medium` / `low` | 表示当前结论可信度，与 `risk_level` 分离；没有合法原文定位时不得为 `high`。 |
| `canonical_issue_id` | `snake_case` string | 风险主问题组标识，例如 `amount_consistency`、`tax_compliance`、`dispute_resolution`、`acceptance_quality`。 |
| `related_risk_ids` | `string[]` | 同一主风险组内的子风险标识，合并时去重并保留来源。 |
| `related_rule_ids` | `string[]` | 触发主风险的规则或清单检查编号。 |
| `related_clause_nos` | `string[]` | 跨条款风险涉及的全部真实条款号。 |
| `cross_clause` | `boolean` | 标记是否需要多条款关系才能成立；必须至少保留来源条款和目标条款证据。 |
| `source_refs_status` | `verified` / `ambiguous` / `unresolved` | 事实原文定位状态；`ambiguous` 只能作为候选展示，不能作为已验证证据。 |
| `source_ref_candidates` | `EvidenceRef[]` | 歧义定位的候选集合，与 `source_refs_status` 配套使用。 |
| `risk_groups` | `RiskItem[]` | 审查结果中的 canonical 主风险集合；兼容规则索引可通过 `is_aggregation_alias=true` 识别。 |

模型风险的 `contract_location` 必须包含 `block_id`、`clause_no`、`char_range` 和 `quote`，并由本地原文回放校验。条款号本身不能替代原文证据；无效、越界或无法回放的引用不得提升 `evidence_status`。
