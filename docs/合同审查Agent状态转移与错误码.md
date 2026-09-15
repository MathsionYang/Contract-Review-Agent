# 合同审查 Agent 状态转移与错误码

> 文档版本：M3-A-1.0
>
> 基线：`合同审查 Agent 需求说明.md` v0.4、《合同审查Agent字段与枚举字典.md》M3-A-1.0
>
> 状态：M3-A 契约冻结版（2026-09-15）

本文档冻结任务、模型、Skill、Tool、记忆和审查结果的生命周期，以及跨模块统一错误响应。未列出的“现态 + 事件”组合必须返回 `STATE_001`，保持原状态，不得以默认值或异常分支静默改变状态。

## 1. 通用状态机规则

### 1.1 事件处理顺序

每个状态事件按以下顺序处理：

```text
接收事件
  -> 校验 schema_version、actor、权限、expected_version 和幂等键
  -> 查找现态 + 事件的唯一转移
  -> 执行守卫条件
  -> 写入状态、版本、Checkpoint/绑定和审计
  -> 发出 TraceEvent 和状态通知
  -> 返回统一成功或失败响应
```

事件处理必须满足：

- 先鉴权、再执行业务动作；权限失败不能通过重试绕过。
- 守卫失败返回对应领域错误码，保持原状态；不得伪造“完成”。
- 状态更新、版本递增、审计记录和幂等结果必须在同一持久化事务或等价原子边界内提交。
- 相同幂等键和相同请求指纹重复提交，返回第一次结果；相同幂等键对应不同请求指纹，返回 `CONCURRENCY_001`。
- 事件时间由主进程生成；客户端传入时间只作为非权威元数据保存。
- 终态对象不能原地修改。需要修订时创建新版本，并通过 `base_*_version_id` 建立关系。

### 1.2 统一事件字段

```json
{
  "event_id": "evt_001",
  "event_type": "task.start",
  "actor_id": "user_001",
  "resource_type": "ReviewTask",
  "resource_id": "task_001",
  "expected_version": 3,
  "idempotency_key": "task_001:start:input_hash",
  "trace_ref": "trace_001",
  "occurred_at": "2026-09-15T08:00:00Z",
  "payload": {}
}
```

响应必须使用：

```json
{
  "schema_version": "agent.response.v1",
  "ok": false,
  "code": "STATE_001",
  "message_key": "state.invalid_transition",
  "retryable": false,
  "suggested_state": "保持原态",
  "details": { "current_state": "completed", "event_type": "task.start" },
  "trace_ref": "trace_001"
}
```

`details` 只能包含脱敏定位字段；不得包含 API Key、凭据、完整合同原文、完整模型提示或受限记忆全文。

## 2. 审查任务状态机

### 2.1 状态定义

| 状态 | 含义 | 是否终态 |
|---|---|---:|
| `submitted` | 已提交，等待执行或重新排队。 | 否 |
| `working` | 正在解析、分类、检索、规则执行或模型审查。 | 否 |
| `input_required` | 缺少合同、上下文、权限、合同类型或必要资料。 | 否 |
| `validating` | 正在进行证据、格式、Schema 和安全校验。 | 否 |
| `waiting_confirmation` | 需要用户确认高风险、不确定或工具动作。 | 否 |
| `partial` | 部分步骤完成，存在明确未完成项。 | 否 |
| `failed` | 任务失败，已保存错误和中间结果。 | 否 |
| `completed` | 必需步骤和门禁通过，结果版本已固化。 | 是 |
| `cancelled` | 用户取消或安全策略终止。 | 是 |

### 2.2 合法转移

| 现态 | 事件 | 守卫条件 | 次态 | 动作 | 可逆 |
|---|---|---|---|---|---:|
| `submitted` | `task.start` | 输入、权限、合同类型和执行配置通过 | `working` | 创建计划、初始 Checkpoint 和 Trace | 否 |
| `submitted` | `task.input_missing` | 缺少必需输入或输入不可用 | `input_required` | 保存缺失项并通知用户 | 是 |
| `working` | `task.validation_start` | 处理步骤完成且结果可校验 | `validating` | 执行 Validator | 是 |
| `working` | `task.need_confirmation` | 高风险、低置信度、规则冲突或工具需确认 | `waiting_confirmation` | 保存中间结果和待决定项 | 是 |
| `working` | `task.partial_result` | 至少一个步骤成功且存在未完成项 | `partial` | 固化已完成结果和未完成清单 | 是 |
| `working` | `task.execution_failed` | 达到重试上限或出现不可重试错误 | `failed` | 保存错误码、中间 Artifact 和 Checkpoint | 是 |
| `working` | `task.cancel` | actor 有取消权限或命中安全终止策略 | `cancelled` | 停止新副作用并写审计 | 否 |
| `validating` | `task.validation_passed` | 输入、证据、Schema、安全和导出前置校验全部通过 | `completed` | 固化 `ReviewVersion` | 否 |
| `validating` | `task.need_confirmation` | 高风险、重大责任、数据合规或高额金额未完成人工复核 | `waiting_confirmation` | 保存待复核结果 | 是 |
| `validating` | `task.validation_warning` | 可交付但有已声明限制 | `partial` | 固化结果并记录限制 | 是 |
| `validating` | `task.validation_failed` | 结果不能安全交付 | `failed` | 阻止完成并保存失败项 | 是 |
| `input_required` | `task.input_received` | 补充输入已上传、版本和权限正确 | `submitted` | 生成新输入版本并重新排队 | 是 |
| `partial` | `task.resume` | 未完成步骤可执行且 Checkpoint 完整 | `working` | 从游标继续，不重复已完成副作用 | 是 |
| `failed` | `task.retry` | 错误可重试、未超过上限且输入版本未变 | `submitted` | 使用原幂等键规则重新排队 | 是 |
| `waiting_confirmation` | `task.confirm` | 用户完成所有必需确认且权限有效 | `working` | 保存人工决定并继续 | 是 |
| `waiting_confirmation` | `task.cancel` | 用户取消或策略终止 | `cancelled` | 关闭待确认任务并写审计 | 否 |

`completed` 和 `cancelled` 不接受任何原地状态转移；修订已完成审查必须创建新的 `ReviewVersion` 或人工修订版本。实现兼容输入 `running` 时必须映射为规范状态 `working`，不能写入新的任务枚举。

### 2.3 任务恢复规则

恢复前必须同时检查 `task_id`、`state_version`、`plan_version`、`cursor`、输入 Artifact 哈希和 `idempotency_key`。已成功完成的解析、规则、检索、模型和保存步骤不得重复执行；发现 Checkpoint 与当前状态不一致时返回 `TASK_002`，保持原状态并要求人工处理。恢复失败不能覆盖最近一次可用结果、错误码和 Artifact 引用。

## 3. 模型配置状态机

| 状态 | 说明 |
|---|---|
| `draft` | 已创建，尚未完成能力测试。 |
| `testing` | 正在执行连通性、凭据、结构化输出和能力测试。 |
| `test_failed` | 至少一个必测项失败，禁止启用。 |
| `active` | 测试通过，允许被任务选择。 |
| `disabled` | 已停用，不接收新任务。 |
| `unhealthy` | 连续调用失败、超时或能力异常。 |
| `credential_expired` | 凭据过期或已失效。 |
| `revoked` | 凭据或服务权限已撤销。 |
| `rolled_back` | 已切换到已验证旧配置版本。 |

| 现态 | 事件 | 守卫条件 | 次态 | 动作 | 可逆 |
|---|---|---|---|---|---:|
| `draft` | `model.start_test` | 字段完整且凭据可解析，或本地模型明确无需凭据 | `testing` | 创建 `test_run_id` 并执行固定测试套件 | 是 |
| `testing` | `model.test_passed` | 所有必测项通过且数据策略一致 | `active` | 允许绑定和调用 | 是 |
| `testing` | `model.test_failed` | 任一阻断测试失败 | `test_failed` | 保存失败项和错误码，禁止启用 | 是 |
| `test_failed` | `model.retry_test` | 配置或凭据已变更 | `testing` | 创建新的测试运行，不覆盖旧结果 | 是 |
| `active` | `model.health_degraded` | 达到连续失败阈值 | `unhealthy` | 停止新任务选择，保留调用记录 | 是 |
| `active` | `model.disable` | 管理员确认 | `disabled` | 停止新任务选择 | 是 |
| `disabled` | `model.enable` | 最近必测测试仍在有效期内且管理员确认 | `active` | 恢复新任务选择 | 是 |
| `active` | `model.credential_expired` | 凭据已过期 | `credential_expired` | 阻止调用并提示轮换 | 是 |
| `active` | `model.credential_revoked` | 凭据或服务权限已撤销 | `revoked` | 阻止调用并保留撤销记录 | 否 |
| `active` | `model.rollback` | 存在已验证旧版本 | `rolled_back` | 切换绑定并写审计 | 是 |
| `unhealthy` | `model.health_recovered` | 健康测试通过且管理员确认 | `active` | 恢复新任务选择 | 是 |
| `credential_expired` | `model.credential_rotated` | 新凭据已保存 | `testing` | 使用新配置重新测试 | 是 |
| `rolled_back` | `model.start_test` | 回滚版本字段完整 | `testing` | 对回滚版本重新测试 | 是 |

未通过测试的模型不得进入 `active`，模型角色、数据策略或能力声明变化必须创建新 `config_version` 并重新测试。

## 4. Skill 状态机

| 现态 | 事件 | 守卫条件 | 次态 | 动作 | 可逆 |
|---|---|---|---|---|---:|
| `uploaded` | `skill.start_validation` | 包已落盘且 SHA-256 已记录 | `validating` | 在隔离目录执行结构、安全、依赖和 Eval 校验 | 是 |
| `validating` | `skill.validation_passed` | 所有阻断检查通过 | `installed` | 保存校验报告，等待人工启用 | 是 |
| `validating` | `skill.validation_failed` | 任一阻断项失败 | `validation_failed` | 保存失败项，禁止启用 | 是 |
| `validation_failed` | `skill.revalidate` | 已上传新版本或修复包 | `validating` | 创建新的校验运行 | 是 |
| `installed` | `skill.activate` | 管理员确认作用域且无冲突 | `enabled` | 创建版本固定的 Skill 绑定 | 是 |
| `enabled` | `skill.disable` | 管理员确认或策略要求 | `disabled` | 停止新任务使用 | 是 |
| `enabled` | `skill.security_violation` | 发现越权、危险脚本或数据外发 | `isolated` | 立即停止调用，保留现场 Artifact | 否 |
| `enabled` | `skill.rollback` | 存在已验证旧版本 | `rolled_back` | 恢复旧绑定并写审计 | 是 |
| `disabled` | `skill.activate` | 管理员确认作用域且无冲突 | `enabled` | 恢复绑定 | 是 |
| `installed` | `skill.deprecate` | 管理员确认下线 | `deprecated` | 禁止新绑定，保留历史读取 | 否 |

`isolated`、`validation_failed` 和 `deprecated` 不得直接启用；修复或升级必须产生新的 Skill 版本、哈希和校验报告。回滚只改变绑定，不删除被回滚版本或审计记录。

## 5. Tool 执行状态机

| 现态 | 事件 | 守卫条件 | 次态 | 动作 | 可逆 |
|---|---|---|---|---|---:|
| `queued` | `tool.start` | Tool 已登记、输入 Schema 和权限校验通过 | `running` | 创建执行记录和隔离沙箱 | 是 |
| `queued` | `tool.confirmation_required` | 策略为 `confirm` 且动作需要用户确认 | `awaiting_confirmation` | 保存参数摘要，等待确认 | 是 |
| `queued` | `tool.block` | 未注册、未启用、权限拒绝或执行器不可用 | `blocked` | 保存阻断错误码，不调用执行器 | 否 |
| `awaiting_confirmation` | `tool.confirm` | 用户确认仍有效且输入哈希未变 | `running` | 重新校验权限后执行 | 是 |
| `awaiting_confirmation` | `tool.cancel` | 用户取消或确认超时 | `cancelled` | 写取消审计，不产生副作用 | 否 |
| `running` | `tool.succeeded` | 输出 Schema 和安全校验通过 | `completed` | 保存脱敏输出和 Artifact 引用 | 否 |
| `running` | `tool.failed` | 执行器返回失败或输出非法 | `failed` | 保存错误码和中间 Artifact | 是 |
| `running` | `tool.timeout` | 超过默认墙钟时间 | `timed_out` | 终止执行并保存现场信息 | 是 |
| `running` | `tool.cancel` | 用户有权限取消且执行器支持取消 | `cancelled` | 停止新副作用并写审计 | 否 |
| `failed` | `tool.retry` | 错误可重试且使用相同输入哈希 | `queued` | 使用同一幂等键重新排队 | 是 |
| `timed_out` | `tool.retry` | 超时错误可重试且未超过上限 | `queued` | 退避后重新排队 | 是 |

Tool 的 `blocked`、`cancelled`、`completed` 为本次调用终态；重试必须产生新的执行事件，但相同幂等键不得产生重复写入型副作用。

## 6. 记忆和风险生命周期

### 6.1 企业记忆

| 现态 | 事件 | 守卫条件 | 次态 | 动作 |
|---|---|---|---|---|
| `candidate` | `memory.confirm` | 敏感扫描、冲突检查、来源和权限校验通过 | `formal` | 创建正式记忆版本和 `MEMORY_CONFIRMED` 审计 |
| `candidate` | `memory.dismiss` | 当前会话和候选归属校验通过 | `dismissed` | 保留候选和 `MEMORY_DISMISSED` 审计 |
| `formal` | `memory.revoke` | 有作用域写权限且说明原因 | `revoked` | 创建撤销版本，停止默认召回 |
| `formal` | `memory.expire` | `as_of > valid_until` | `expired` | 记录过期事件，停止默认召回 |
| `revoked`/`expired` | `memory.replace` | 新内容重新经过候选和确认流程 | `formal`（新版本） | 不复活旧版本，建立替代关系 |

已撤销、已过期和 `dismissed` 记忆不能通过排序或重排重新进入当前上下文。`memory.retrieve` 的过滤失败不改变记忆自身状态，只在检索证据中记录 `filter_reason`。

### 6.2 风险结果

风险对象的 `conclusion_status`、`evidence_status` 和 `human_status` 可组合但不互相替代：

- 新生成或人工新增风险默认 `candidate + unverified + pending_review`。
- `critical/high` 风险只有在证据 `verified` 且完成必要人工处理后，才允许进入 `confirmed`。
- `false_positive`、`deleted` 或 `rejected` 不得被导出为有效风险，但原始记录和修改审计必须保留。
- 人工修改创建新 `review_version_id`；AI 原始结果保持只读。

## 7. 统一错误码目录

### 7.1 错误码格式和响应

规范错误码格式为 `DOMAIN_NNN`：大写领域前缀、下划线和三位数字。`retryable`、建议次态和用户动作由本目录定义，新增错误码必须同时更新字段字典、RTM 和验收用例。

| 字段 | 类型 | 约束 |
|---|---|---|
| `code` | `string` | 必须为本目录中的规范码。 |
| `message_key` | `string` | 稳定的展示文案键，不直接把内部异常透传给用户。 |
| `retryable` | `boolean` | 是否允许在相同输入版本下重试。 |
| `suggested_state` | `string` | 任务或对象建议次态；无状态变化时为 `保持原态`。 |
| `details` | `object` | 仅含脱敏字段定位、校验项、重试次数和版本信息。 |
| `trace_ref` | `string` | 必须关联 TraceEvent。 |

### 7.2 输入、解析和知识

| 规范码 | 含义 | 可重试 | 建议次态 | 用户动作 |
|---|---|---:|---|---|
| `INPUT_001` | 文件不存在或未关联当前项目 | 否 | `input_required` | 重新上传或关联文件 |
| `INPUT_002` | 格式、大小或页数超出配置 | 否 | `input_required` | 更换文件或调整配置 |
| `PARSE_001` | 文档解析失败 | 是 | `input_required` | 修复文件后重试 |
| `PARSE_002` | OCR 结果低于可用阈值 | 否 | `partial` | 人工核对受影响页面 |
| `KNOWLEDGE_001` | 知识文件无法解析或索引失败 | 是 | `partial` | 修复文件后重新导入 |
| `KNOWLEDGE_002` | 知识来源无结果或版本不可用 | 否 | `partial` | 补充来源或接受待核验 |
| `SNAPSHOT_001` | 指定法律快照不存在或未发布 | 否 | `partial` | 选择已发布快照 |
| `SOURCE_001` | 实时来源超时、不可用或未授权 | 是 | `partial` | 使用离线结果或稍后核验 |
| `RULE_001` | 规则执行缺少必需事实 | 否 | `partial` | 补充资料或接受待核验 |

### 7.3 权限、Schema 和状态

| 规范码 | 含义 | 可重试 | 建议次态 | 用户动作 |
|---|---|---:|---|---|
| `PERMISSION_001` | 当前主体无资源或 Tool 权限 | 否 | `failed` | 联系管理员或更换有权限资源 |
| `SECURITY_001` | 越权、数据出域、提示注入或危险行为被阻断 | 否 | `failed` | 修改权限或数据策略 |
| `SCHEMA_001` | 请求或响应不符合指定 Schema | 否 | `failed` | 修正字段并使用新请求版本 |
| `STATE_001` | 现态与事件组合未定义 | 否 | 保持原态 | 仅执行状态机允许的动作 |
| `CONCURRENCY_001` | 版本冲突或相同幂等键对应不同请求 | 否 | 保持原态 | 重新读取版本并使用新幂等键 |
| `TASK_001` | Checkpoint 不存在或不可恢复 | 否 | `failed` | 从新输入版本重新提交 |
| `TASK_002` | Checkpoint 与当前任务状态/输入不一致 | 否 | 保持原态 | 人工检查并创建新恢复点 |

### 7.4 模型和检索

| 规范码 | 含义 | 可重试 | 建议次态 | 用户动作 |
|---|---|---:|---|---|
| `MODEL_001` | 模型配置、能力或凭据引用无效 | 否 | `failed` | 修复配置并重新测试 |
| `MODEL_002` | 模型请求超时 | 是 | `working` | 按策略退避重试或切换批准的备用模型 |
| `MODEL_003` | 模型服务限流或配额不足 | 是 | `working` | 退避重试或等待配额 |
| `MODEL_004` | 模型服务请求失败 | 是 | `partial` | 保留规则结果并按策略重试 |
| `MODEL_005` | 模型输出不符合结构化 Schema | 是 | `validating` | 结构化修复、重试或人工复核 |
| `MODEL_006` | 凭据过期、撤销或无法读取 | 否 | `failed` | 轮换凭据并重新测试 |
| `MEMORY_001` | 记忆候选不存在 | 否 | 保持原态 | 刷新会话并重新选择候选 |
| `MEMORY_002` | 当前策略禁止写入企业记忆 | 否 | 保持原态 | 修改策略或放弃写入 |
| `MEMORY_003` | 记忆检索路由不可用 | 是 | `partial` | 使用明确降级路径或稍后重试 |
| `RETRIEVAL_001` | 向量索引不存在、损坏或版本不匹配 | 是 | `partial` | 重建索引或使用关键词/图降级 |
| `RERANK_001` | Cross-Encoder 超时或返回非法分数 | 是 | `partial` | 使用 RRF 顺序并保留降级记录 |

### 7.5 Validator、导出、Tool、Skill 和对话

| 规范码 | 含义 | 可重试 | 建议次态 | 用户动作 |
|---|---|---:|---|---|
| `VALIDATION_001` | Validator 阻止结果交付 | 否 | `failed` | 查看失败项并修正后重新分析 |
| `EXPORT_001` | 指定格式无法生成或渲染校验失败 | 是 | `partial` | 下载可用格式或修复模板 |
| `EXPORT_002` | 导出前门禁阻断 | 否 | `waiting_confirmation` | 完成证据或人工复核 |
| `TOOL_001` | Tool 调用缺少名称或参数非法 | 否 | `blocked` | 修正请求 Schema |
| `TOOL_002` | Tool 执行器未注册或不可用 | 否 | `blocked` | 注册批准的执行器或保留阻断记录 |
| `TOOL_003` | Tool 权限被拒绝 | 否 | `blocked` | 修改权限策略并重新确认 |
| `TOOL_004` | Tool 执行需要用户确认 | 否 | `awaiting_confirmation` | 用户确认或取消 |
| `TOOL_005` | Tool 执行失败 | 是 | `failed` | 按 Tool 策略有限重试 |
| `TOOL_006` | Tool 或 Skill 不在允许清单 | 否 | `blocked` | 启用已批准的绑定 |
| `SKILL_001` | Skill 结构、安全、依赖或 Eval 校验失败 | 否 | `validation_failed` | 修复 Skill 后重新校验 |
| `SKILL_002` | Skill 未启用或不属于当前快照 | 否 | `blocked` | 选择已启用且作用域匹配的 Skill |
| `CHAT_001` | 对话会话不存在 | 否 | 保持原态 | 重新打开当前审查会话 |
| `CHAT_002` | 当前主体无权访问会话 | 否 | 保持原态 | 使用有权限的会话 |
| `CHAT_003` | 找不到可重试的失败消息 | 否 | 保持原态 | 选择失败消息或重新提交 |
| `CHAT_004` | 对话请求已结束或不存在 | 否 | 保持原态 | 创建新请求 |

### 7.6 现有代码错误码兼容映射

兼容别名只允许在 IPC/旧状态读取边界使用；新代码、审计和验收报告必须写规范码。

| 现有描述型代码 | 规范码 | 适用模块 |
|---|---|---|
| `INPUT_FILE_MISSING` | `INPUT_001` | 导入/任务 |
| `INPUT_UNSUPPORTED` | `INPUT_002` | 导入/解析 |
| `PARSE_FAILED` | `PARSE_001` | 解析 |
| `OCR_LOW_CONFIDENCE` | `PARSE_002` | OCR/Validator |
| `PERMISSION_DENIED` | `PERMISSION_001` | 权限/来源 |
| `SNAPSHOT_NOT_FOUND` | `SNAPSHOT_001` | 法律快照 |
| `RULE_INPUT_INSUFFICIENT` | `RULE_001` | 规则 |
| `SOURCE_UNAVAILABLE` | `SOURCE_001` | 法律实时来源 |
| `MODEL_CONFIG_INVALID` | `MODEL_001` | 模型网关 |
| `MODEL_TIMEOUT` | `MODEL_002` | 模型网关 |
| `MODEL_RATE_LIMITED` | `MODEL_003` | 模型网关 |
| `MODEL_REQUEST_FAILED` | `MODEL_004` | 模型网关 |
| `MODEL_OUTPUT_INVALID` | `MODEL_005` | 模型网关/对话 |
| `VALIDATION_FAILED` | `VALIDATION_001` | Validator |
| `INVALID_STATE_TRANSITION` | `STATE_001` | 状态机 |
| `IDEMPOTENCY_CONFLICT` | `CONCURRENCY_001` | 持久化/恢复 |
| `EXPORT_RENDER_FAILED` | `EXPORT_001` | 导出 |
| `TOOL_CALL_INVALID` | `TOOL_001` | Tool 协议 |
| `TOOL_EXECUTOR_UNAVAILABLE` | `TOOL_002` | Tool 协议 |
| `TOOL_PERMISSION_DENIED` | `TOOL_003` | Tool 协议 |
| `TOOL_CONFIRMATION_REQUIRED` | `TOOL_004` | Tool 协议 |
| `TOOL_EXECUTION_FAILED` | `TOOL_005` | Tool 协议 |
| `MCP_TOOL_NOT_ALLOWED` | `TOOL_006` | Tool 协议 |
| `SKILL_NOT_ENABLED` | `SKILL_002` | Skill/对话 |
| `SKILL_VALIDATION_FAILED` | `SKILL_001` | Skill |

## 8. 审计和测试要求

每次状态转移至少写入：`event_id`、现态、事件、次态、actor、`expected_version`、新版本、守卫结果、错误码、幂等键、输入/输出 Artifact 哈希和 `trace_ref`。失败和非法转移同样需要审计，不得只在控制台打印。

M3-A 的最低自动化覆盖：

1. 每张状态转移表的合法路径至少一个通过用例；每个终态和未定义组合至少一个阻断用例。
2. 错误码响应包含 `code`、`message_key`、`retryable`、`suggested_state`、脱敏 `details` 和 `trace_ref`。
3. 相同幂等键重复提交返回相同结果；不同请求复用同一幂等键返回 `CONCURRENCY_001`。
4. 任务恢复不重复写入风险、Artifact、导出或审计副作用；状态和 Checkpoint 不一致返回 `TASK_002`。
5. 当前代码的兼容错误码可以被解析为规范码，但新写入记录不得继续增加未登记的描述型错误码。

## 9. M3-A 落地状态

- 任务、模型、Skill、Tool 和记忆的状态、事件、守卫、动作和可逆性已冻结为本文件版本 `M3-A-1.0`。
- 统一错误响应和 `DOMAIN_NNN` 目录已冻结；现有描述型代码已登记兼容映射。
- 代码层的状态归一化、错误码迁移和自动化覆盖属于后续 M3-B/M3-C 实施项；在完成前，阶段文档只能声明“契约已冻结”，不能声明“代码已完全符合”。
