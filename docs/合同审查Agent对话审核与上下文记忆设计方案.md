# 合同审查 Agent 对话审核与上下文记忆设计方案

## 1. 文档定位

本文档定义审核工作区新增“合同原文下方聊天对话框”后的产品交互、上下文管理、模型调用、局部审查和企业记忆设计。

本文档最初作为 P1-P2 设计基线，现同时记录设计约束和实际实施状态。截至 2026-09-11，P1 对话审核、上下文组装、待核验风险/局部审查和企业记忆闭环基础已经落地，P2 的流式取消、会话摘要以及 MCP/Skill 协议与审计基础已经落地；真实 MCP/Skill 执行器和多用户权限仍未实现。详细模块串联与测试记录见《合同审查 Agent 技术实现阶段文档》。

设计基线为《合同审查 Agent 需求说明》v0.4，重点遵循以下约束：

- 企业记忆按 L0-L6 分层管理。
- 合同正文不全部注入每次模型上下文，只发送当前问题所需的条款和证据。
- 选区审查默认读取所在条款、前后各一个同级条款以及明确引用的定义条款。
- 模型无法充分验证时只能生成 `needs_verification`，不能直接形成已确认结论。
- 聊天记录不自动等同于企业长期记忆，企业记忆必须经过用户明确确认后写入。

## 2. 目标与非目标

### 2.1 目标

1. 在合同原文下方提供连续对话入口，让用户可以使用自然语言提出审查问题。
2. 支持用户选择当前已配置且可用的 `analysis` 模型。
3. 将合同、当前页、选中文本、当前风险、知识库依据和企业记忆组织成可审计的上下文快照。
4. 支持三类结果：普通审查建议、待核验风险候选、局部审查任务。
5. 让聊天生成的结果复用现有风险结构、人工处理、审查版本和 Validator 门禁。
6. 让企业记忆可以被安全召回，并支持“候选记忆 -> 用户确认 -> 正式写入”的闭环。

### 2.2 非目标

- 不允许聊天直接修改原始合同文件。
- 不允许聊天直接确认高风险、签署合同、发送合同或绕过 Validator 导出。
- 不把每轮聊天自动写入企业长期记忆。
- 不在渲染层直接读取文件系统、网络、凭据或模型 API。
- P1 首版以结构化结果、状态和可追溯性为前提；当前 P2 基础已补充 SSE 流式输出和取消能力。
- 不建立独立于现有 `review.risks` 的第二套风险数据结构。

## 3. 核心交互

### 3.1 页面位置

聊天区放置在审核工作区左侧“合同原文”面板下方，与原文阅读器属于同一工作上下文；右侧风险清单和风险详情气泡保持现有职责。

页面结构：

```text
审核工作区
  ├─ 合同原文阅读器
  │    ├─ 页码、搜索、缩放、风险定位和人工高亮
  │    └─ 选区操作气泡：高亮 / 局部审查
  ├─ 对话审核区
  │    ├─ 会话工具栏：会话、模型、上下文范围、清空当前草稿
  │    ├─ 上下文标签：合同、当前页、选区、当前风险、知识库、记忆
  │    ├─ 消息列表：用户消息、助手答复、引用和结果卡片
  │    └─ 输入框：自然语言问题、发送、停止、重试
  └─ 风险清单
       └─ 风险详情气泡
```

聊天区不使用右侧抽屉，也不覆盖风险详情气泡。风险详情仍通过现有气泡查看；聊天生成风险后，用户点击“查看风险”定位到风险卡和合同原文。

### 3.2 模型选择

聊天工具栏提供模型选择下拉框，只展示满足以下条件的模型：

- 模型状态为 `active`。
- 模型具备 `analysis` 角色。
- 配置已通过本地字段校验。
- 模型声明支持结构化输出，或系统具备兼容的 JSON 解析降级策略。

默认选择顺序：

1. 当前审查执行快照中的 `analysis` 模型。
2. 当前能力配置中第一个可用的 `analysis` 模型。
3. 没有可用模型时显示“未配置可用审查模型”，禁止发送需要模型判断的请求。

模型选择只改变当前会话后续请求，不修改已经保存的审查执行快照。用户切换模型后，下一条消息必须记录新的模型名称、配置版本和数据策略。

### 3.3 上下文标签

发送前显示当前会话将使用的上下文范围，用户可以移除非必要上下文：

- `合同文件`：当前合同文件版本和合同类型。
- `当前页`：当前阅读页文本和页码。
- `选中文本`：选区文本、页码、条款号和文本哈希。
- `当前风险`：当前风险 ID、结论、定位和依据。
- `已选知识库`：已勾选规则库、企业制度和已发布法律快照。
- `相关企业记忆`：按当前问题召回并通过权限、状态和有效期过滤的记忆。
- `会话摘要`：当前会话的压缩摘要，不默认携带全部历史消息。

用户可以取消“当前页”或“相关企业记忆”，但合同文件版本和用户明确选择的选区不能被静默替换。上下文标签显示的是范围和数量，不在页面上展示 API 地址、凭据或本地绝对路径。

## 4. 上下文分层模型

### 4.1 L0-L6 与聊天的对应关系

| 层级 | 名称 | 聊天中的内容 | 生命周期 | 是否默认发送 |
|---|---|---|---|---|
| L0 | 当前请求上下文 | 用户指令、当前选区、当前页、当前风险、最近一次工具结果 | 单次请求 | 是，按需 |
| L1 | 当前审查任务 | 合同文件版本、合同类型、审查模式、当前任务状态、执行快照 | 当前 Review | 是，发送摘要和引用 |
| L2 | 会话上下文 | 消息、会话摘要、已选上下文范围、已使用模型 | 当前 ChatSession | 是，优先摘要和最近消息 |
| L3 | 项目/组织上下文 | 项目约束、组织规则、项目级资料引用和权限范围 | 项目或组织 | 仅命中后发送 |
| L4 | 合同类型上下文 | 合同类型模板、该类型审查重点、默认风险阈值 | 合同类型 | 仅命中后发送 |
| L5 | 已验证历史经验 | 用户确认并发布的企业记忆、已验证案例和稳定规则 | 长期 | 仅检索命中后发送 |
| L6 | 元记忆 | 记忆召回策略、来源可信度、版本和治理状态 | 系统治理 | 不直接作为事实发送 |

L6 只用于决定“哪些记忆可以被召回、如何排序和如何解释来源”，不应把 L6 的内部治理字段直接伪装成合同事实提供给模型。

### 4.2 上下文组装顺序

每次发送消息由 Electron 主进程组装上下文，渲染层只提交引用和用户输入：

```text
用户输入
  -> 校验当前 Review、用户可用模型和权限
  -> 固定合同文件版本、审查版本和执行配置快照
  -> 获取当前页、选区、风险和会话摘要
  -> 从已选知识库检索相关条款
  -> 从企业记忆召回已确认且有效的候选
  -> 按上下文预算排序、截断和生成引用
  -> 生成 context_snapshot
  -> 调用 analysis 模型
  -> 校验结构化输出
  -> 写入消息、风险候选、任务或记忆候选
```

上下文组装必须发生在主进程，原因是主进程可以读取本地解析结果、知识文件、权限配置和凭据引用，同时能阻止渲染层伪造模型使用过的依据。

## 5. 上下文内容与裁剪策略

### 5.1 发送内容优先级

当模型上下文接近上限时，按以下顺序保留：

1. 系统约束和输出 Schema。
2. 用户本轮自然语言指令。
3. 当前选中文本及其默认扩圈条款。
4. 当前风险和风险定位原文。
5. 与问题命中的法律、规则和制度条款。
6. 当前页相关文本。
7. 已确认企业记忆。
8. 当前会话最近消息。
9. 更早的会话摘要。

任何裁剪都必须在 `context_snapshot` 中记录：被保留的引用、被裁剪的范围、裁剪原因和模型上下文预算。

### 5.2 默认局部上下文

当聊天由选区触发，或者用户明确要求“审核选中内容”时，默认上下文为：

- 选区所在条款。
- 前一个同级条款。
- 后一个同级条款。
- 选区条款中明确引用的定义条款。
- 与当前问题相关的已选规则、制度和法律快照条款。

用户在发送前可以切换为：仅选区、默认条款范围、扩展到当前章节、扩展到显式引用链。扩圈结果必须在聊天区上下文标签和助手引用中可见。

### 5.3 证据引用结构

模型不得只返回“依据文件名”。每一条引用至少保存：

```js
{
  citation_id: "citation_xxx",
  source_type: "contract|legal_snapshot|rule|enterprise_policy|enterprise_memory",
  source_id: "source-or-memory-id",
  file_name: "采购制度.docx",
  file_version_id: "knowledge_policies_xxx",
  clause_no: "4.2",
  clause_title: "预付款",
  excerpt: "预付款比例不得超过合同金额的 30%",
  contract_location: { page: 3, clause_no: "4.2" },
  confidence: 0.92
}
```

引用必须来自当前文件版本或当前执行快照绑定的知识版本。找不到原文、条款或版本绑定时，引用状态为 `unverified`，不能支持确认结论。

## 6. 聊天结果协议

### 6.1 统一响应结构

模型输出必须经过主进程 Schema 校验，不接受任意自然语言直接改变审查状态：

```js
{
  response_id: "chat_response_xxx",
  intent: "answer|create_risk|local_review|clarify",
  answer: "面向用户的自然语言回答",
  citations: [],
  risk_candidates: [],
  review_action: null,
  memory_candidates: [],
  needs_clarification: false,
  clarification_question: ""
}
```

### 6.2 普通审查建议

`intent=answer` 只返回解释、比较、修改建议或风险分析，不写入风险清单。回答仍需展示引用和上下文范围；如果依据不足，明确显示“无法充分核验”。

### 6.3 待核验风险候选

`intent=create_risk` 允许模型生成风险候选，但必须强制覆盖以下字段：

```js
{
  source_type: "chat_model",
  conclusion_status: "needs_verification",
  evidence_status: "unverified|verified",
  human_status: "pending_review",
  risk_level: "low|medium|high|critical",
  risk_category: "...",
  title: "...",
  analysis: "...",
  recommendation: "...",
  contract_location: {},
  evidence: [],
  chat_ref: "chat_message_xxx"
}
```

即使模型声称“确定无风险”，也不能直接写入 `confirmed`。只有后续满足现有人工复核、证据和定位要求，才允许由人工操作变更结论状态。

风险候选进入当前 `review.risks` 后：

1. 在聊天消息下显示“已加入待核验风险”。
2. 在右侧风险清单显示来源为“对话审查”。
3. 点击后打开现有风险详情气泡并跳转原文定位。
4. 复用接受、误报、修改、延期和删除流程。
5. 生成新的审查版本和人工修订记录。

### 6.4 局部审查任务

当用户输入“审核当前选中条款”“重点检查付款责任”等指令，或者模型判定需要围绕选区执行专项审查时，使用 `intent=local_review`：

```js
{
  review_action: {
    type: "local_review",
    review_type: "legal_risk|reasonableness|template_compare|suggestion|explanation|special",
    topic: "payment|breach|liability|ip|confidentiality|data|termination|dispute|general",
    context_scope: "selected_clause|adjacent_clauses|linked_references",
    selection_ref: "annotation_xxx"
  }
}
```

局部审查任务复用当前选区标记、条款扩圈和风险候选流程，默认进入 `waiting_confirmation` 或 `needs_verification`，不会自动确认为正式风险结论。

### 6.5 需要澄清

当用户没有提供合同、选区、审查方向或必要上下文时，模型返回 `intent=clarify`。系统应优先提供结构化选择，例如“是否审查当前选区”“是否扩大到前后条款”“请选择付款/违约/知识产权方向”，而不是猜测用户意图。

## 7. 企业记忆设计

### 7.1 记忆召回

聊天可以使用企业记忆，但只召回满足以下条件的记录：

- 状态为正式、已确认或系统允许的有效状态。
- 未超过有效期。
- 当前用户、组织、项目和合同类型权限匹配。
- 敏感等级允许进入当前模型的数据策略。
- 与当前合同类型、问题关键词、条款主题或风险类别相关。

召回结果按“相关性、置信度、来源验证状态、时间有效性和作用域优先级”排序。召回的记忆必须作为独立来源显示，不能伪装成法律条款或合同原文。

### 7.2 记忆候选

模型认为某条经验值得沉淀时，只返回 `memory_candidate`，不直接写入 `knowledge.memory`：

```js
{
  candidate_id: "memory_candidate_xxx",
  content: "对于软件采购合同，付款前应要求验收结论和发票齐备。",
  scope: "contract_type:software_purchase",
  memory_type: "review_practice|risk_pattern|negotiation_preference|template_guidance",
  confidence: 0.82,
  sensitivity: "internal",
  valid_from: "2026-09-11",
  valid_until: null,
  source_refs: ["chat_message_xxx", "risk_xxx", "citation_xxx"],
  conflict_keys: ["payment.acceptance.before_payment"],
  status: "candidate"
}
```

### 7.3 记忆确认与冲突

用户点击“保存为企业记忆”后，系统执行：

```text
记忆候选
  -> 检查敏感信息和权限
  -> 查找相同 conflict_keys 的已有记忆
  -> 无冲突：进入待确认编辑表单
  -> 有冲突：展示旧记忆、新候选和差异，要求用户选择保留、合并或放弃
  -> 用户确认
  -> 写入 knowledge.memory
  -> 生成记忆版本和 MEMORY_CONFIRMED 审计记录
```

当前合同的交易事实、客户名称、金额、联系人、临时判断和未核验结论默认不允许成为企业长期记忆。只有经过脱敏、抽象和用户确认，才能保存为可复用经验。

### 7.4 聊天记录与企业记忆的边界

| 数据 | 保存位置 | 默认是否长期复用 | 写入方式 |
|---|---|---|---|
| 用户消息 | `review.chat_sessions.messages` | 否，仅当前审查可见 | 自动保存会话记录 |
| 助手回答 | `review.chat_sessions.messages` | 否 | 自动保存脱敏响应 |
| 上下文快照 | `review.chat_sessions.context_snapshots` | 仅用于复核 | 自动生成，不作为记忆召回 |
| 风险候选 | `review.risks` | 随审查版本保留 | 模型生成后待人工复核 |
| 记忆候选 | `review.chat_sessions.memory_candidates` | 否 | 用户确认前保持候选 |
| 正式企业记忆 | `knowledge.memory` | 是，受治理规则控制 | 用户明确确认后写入 |

## 8. 数据结构建议

### 8.1 ChatSession

```js
{
  chat_session_id: "chat_session_xxx",
  project_id: "project_xxx",
  review_version_id: "RV-xxx",
  status: "active|archived|failed",
  selected_model: {
    name: "analysis-model",
    model_id: "model-id",
    config_version: "cfg-v1",
    policy: "internal_only"
  },
  context_preferences: {
    include_current_page: true,
    include_selection: true,
    include_current_risk: true,
    include_memory: true,
    context_scope: "default_clause_window"
  },
  summary: "当前会话摘要",
  created_at: "...",
  updated_at: "..."
}
```

### 8.2 ChatMessage

```js
{
  message_id: "chat_message_xxx",
  session_id: "chat_session_xxx",
  role: "user|assistant|system",
  content: "展示用内容",
  intent: "answer|create_risk|local_review|clarify",
  context_snapshot_id: "context_snapshot_xxx",
  model_call_ref: "model_call_xxx",
  risk_refs: ["risk_xxx"],
  memory_candidate_refs: ["memory_candidate_xxx"],
  created_at: "..."
}
```

### 8.3 ContextSnapshot

```js
{
  context_snapshot_id: "context_snapshot_xxx",
  project_id: "project_xxx",
  file_version_id: "contract_v1",
  review_version_id: "RV-xxx",
  page_refs: [{ page: 3, text_hash: "sha256:..." }],
  selection_refs: [{ annotation_id: "annotation_xxx", text_hash: "sha256:..." }],
  risk_refs: ["risk_xxx"],
  citation_refs: ["citation_xxx"],
  memory_refs: ["memory_xxx"],
  session_message_refs: ["chat_message_xxx"],
  included_sections: ["system", "user_request", "selection", "citations"],
  omitted_sections: ["older_messages"],
  omission_reason: "context_budget",
  token_budget: 12000,
  estimated_tokens: 8750,
  created_at: "..."
}
```

## 9. IPC 与模块边界

建议新增以下主进程接口：

| IPC | 作用 | 渲染层提交 | 主进程返回 |
|---|---|---|---|
| `review:chat` | 发送一次聊天审查请求 | 项目/审查 ID、会话 ID、用户输入、上下文引用、模型 ID | 脱敏消息、引用、风险候选、局部审查动作、状态 |
| `review:chat-cancel` | 取消模型请求 | 请求 ID | 取消状态 |
| `review:chat-retry` | 使用同一上下文重试 | 消息 ID或上下文快照 ID | 新消息和新模型调用记录 |
| `review:memory-confirm` | 确认记忆候选 | 候选 ID、编辑后字段 | 新记忆版本和审计记录 |
| `review:memory-dismiss` | 放弃记忆候选 | 候选 ID、原因 | 候选状态和审计记录 |

模块职责：

```text
ReviewWorkspace.vue
  -> review store
  -> electronApi
  -> preload contextBridge
  -> Electron IPC
  -> review-chat.cjs
       ├─ context-assembler.cjs  上下文分层、检索、预算和快照
       ├─ model-gateway.cjs      已配置 analysis 模型调用
       ├─ review-engine.cjs      风险结构归一化和候选生成
       ├─ knowledge.cjs          规则/制度/法律条款检索
       ├─ memory-service.cjs      记忆召回、冲突和候选确认
       └─ validator.cjs           结果和导出门禁
```

`review-chat.cjs` 不直接让模型写入任意状态；所有风险、局部任务和记忆都通过明确的领域函数生成，并由主进程持久化。

## 10. 状态、版本和审计

每次聊天请求至少记录：

- `request_id`、`chat_session_id`、`message_id`。
- 项目 ID、审查版本 ID、合同文件版本 ID。
- 选用模型名称、模型 ID、配置版本和数据策略。
- 上下文快照 ID、保留引用、裁剪信息和估算 Token。
- 模型调用耗时、usage、重试次数和脱敏错误码。
- 输出意图、风险候选引用、局部审查任务引用和记忆候选引用。

以下内容禁止保存到消息、上下文快照、审计或导出：

- API Key、Bearer Token、私钥和完整认证头。
- 未经必要性判断的合同全文副本。
- 模型服务商内部绝对路径和本地凭据路径。

聊天生成风险候选后，当前 Review 的 `review_version_id` 不立即覆盖原结果；建议保存为新的审查版本或候选变更记录，用户人工处理后再生成正式人工修订版本。

## 11. 失败与降级

| 场景 | 页面表现 | 数据状态 |
|---|---|---|
| 没有可用模型 | 禁用发送并提示配置模型 | 不创建模型调用记录 |
| 模型超时/限流 | 消息显示调用失败，可重试 | 保留上下文快照，任务为 `partial` 或 `failed` |
| 模型返回非法 JSON | 显示无法解析，不生成风险 | 写入 `MODEL_OUTPUT_INVALID` |
| 找不到合同原文 | 显示无法定位 | 不生成可确认风险，候选为 `needs_verification` |
| 没有足够依据 | 返回待核验建议 | `evidence_status=unverified` |
| 记忆已过期或无权限 | 不展示该记忆 | 不进入上下文快照的 `memory_refs` |
| 记忆候选存在冲突 | 显示冲突比较 | 保持 `candidate`，不覆盖旧记忆 |
| 上下文超预算 | 显示已裁剪范围 | 快照记录省略部分和原因 |

## 12. 分阶段实施 ToDoList

状态同步日期：2026-09-11。代码基线：`ed7133a`。`[x]` 表示已有代码和自动化测试支撑，`[ ]` 表示仍需补齐；协议、权限判断和阻断记录完成，不等同于真实 MCP Tool 或 Skill 已经执行。

### P1-A：聊天基础链路

- [x] 在合同原文下方增加聊天区和消息列表。
- [x] 增加已启用 `analysis` 模型选择，并显示当前执行模型。
- [x] 新增 `review:chat` IPC 和 `review-chat.cjs`。
- [x] 实现 ChatSession、ChatMessage 和 ContextSnapshot 本地持久化。
- [x] 实现普通审查建议和结构化 JSON 输出校验。
- [x] 处理超时、重试、模型不可用和上下文超限。

### P1-B：风险与局部审查

- [x] 支持聊天结果生成 `needs_verification` 风险候选。
- [x] 将风险候选自动加入当前风险清单，并联动原文和风险详情气泡。
- [x] 支持聊天触发局部审查，复用已保存或临时选区锚点并实际扩圈上下文。
- [x] 增加“查看风险”和局部审查“定位结果”操作，风险候选生成后自动加入清单。
- [ ] 增加独立的“重新审查此选区”快捷操作；当前可保留选区并通过自然语言再次触发，但尚无专用按钮。
- [x] 确保聊天生成结果经过现有人工复核和 Validator 门禁。

### P1-C：企业记忆闭环

- [x] 实现 L0-L6 上下文组装，以及正式记忆的状态、作用域、有效期、敏感等级和模型策略过滤与排序。
- [ ] 在聊天结果中完整显示记忆来源、作用域、置信度和有效期；当前候选卡已显示作用域、类型和置信度，来源及有效期仍需补充界面展示。
- [x] 增加 `memory_candidate` 展示、编辑、确认、冲突处理和放弃。
- [x] 增加敏感信息扫描、冲突检测和记忆版本。
- [x] 写入 `MEMORY_CANDIDATE_CREATED`、`MEMORY_CONFIRMED`、`MEMORY_DISMISSED` 审计记录。

### P2：增强能力

- [x] 流式回复和可取消模型请求。
- [x] 会话摘要自动压缩、摘要检查点和本地长会话恢复基础。
- [x] MCP Tool 与聊天意图的统一工具调用协议、权限决策、输出脱敏和执行记录。
- [x] Skill 调用的权限决策、沙箱要求和执行记录协议；无真实执行器时强制阻断。
- [ ] 注册并接入真实 MCP Tool/Skill 执行器，补齐超时、重试、幂等和 Artifact 引用。
- [ ] 多人协作下的会话权限、记忆权限和敏感数据策略。

## 13. 验收标准

1. 用户可以在合同原文下方选择已配置的 `analysis` 模型并发送自然语言问题。
2. 每条助手回答都能查看使用的上下文范围和具体证据条款。
3. 用户可以要求“审核当前选中条款”，系统能复用选区和默认扩圈上下文。
4. 模型可以生成待核验风险，但不能直接产生已确认结论。
5. 待核验风险可以进入现有风险清单、详情气泡、人工处理和审查版本链路。
6. 企业记忆可以被召回，但聊天消息和模型建议不会自动写入企业记忆。
7. 用户明确确认记忆候选后，系统才写入 `knowledge.memory` 并生成审计记录。
8. 模型失败、依据不足、定位失败和上下文超限时，界面明确显示降级状态，不输出误导性“通过”。
9. 导出前 Validator 能识别聊天生成的未核验风险、缺少定位和无效依据，并按现有规则阻断导出。

## 14. 与当前 P0 的衔接

本方案不改变当前 P0 的核心数据契约：

- 复用 `review.risks`、`review.humanRevisions`、`review.task` 和 `review.config.execution`。
- 复用 `knowledge.rules`、`knowledge.policies`、`knowledge.legalSnapshots` 的文件版本和条款结构。
- 复用 `model-gateway.cjs` 的凭据引用、结构化 JSON、超时和错误脱敏能力。
- 复用 `review-engine.cjs` 的风险归一化、证据状态和合并去重能力。
- 复用 `validator.cjs` 的定位、证据、人工复核和敏感信息门禁。

当前 P1 主链路和 P2 协议基础已经落地，并通过 45 项自动化测试。下一步应补齐“重新审查此选区”快捷操作和记忆来源/有效期展示，再接入真实 MCP Tool/Skill 执行器与多用户权限；在这些能力完成前，工具调用继续保持明确阻断，企业记忆继续限定为本地用户人工确认后写入。
