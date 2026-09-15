# 合同审查 Agent 技术实现阶段文档

## 1. 文档说明

本文档基于《合同审查 Agent 需求说明》v0.4，记录当前阶段已经完成的 Vue 3 + Electron 本地桌面端实现、模块职责和调用串联关系。

本文档只描述当前代码真实具备的能力。当前版本已完成 P0“本地真实审查主链路”，并实现 P1 对话审核、上下文快照、聊天风险/局部审查、企业记忆候选闭环以及 P2 的流式取消、长会话摘要、统一工具协议和本地权限策略。模型配置不再使用预置测试模型，必须由用户人工录入、保存、校验并启用，配置保存在 Electron 用户数据目录并在下次启动恢复。OCR 引擎、真实 MCP/Skill 执行器、账号体系、病毒扫描和多用户协作仍属于后续阶段，不在本阶段宣称完成。

| 项目 | 当前值 |
|---|---|
| 需求基线 | 《合同审查 Agent 需求说明》v0.4 |
| 实现阶段 | P0 真实审查主链路 + P1-P2 对话审核与上下文记忆基础 |
| 代码基线 | `306a463` + 模型错误诊断修复（2026-09-15） |
| 前端技术 | Vue 3、Vite、Pinia、lucide-vue-next |
| 桌面技术 | Electron，主进程 CommonJS |
| 运行边界 | 本地文件系统和 Electron 用户数据目录 |
| 交付形态 | Electron 本地桌面端；浏览器预览仅作为无 Node.js 能力的界面预览 |

## 2. 总体架构

当前实现采用 Electron 主进程负责本地能力，Vue 渲染层负责界面和交互状态，Pinia 负责当前审查状态的集中管理。

```text
Vue 3 组件
  -> Pinia review store
  -> electronApi 白名单封装
  -> preload contextBridge
  -> Electron IPC
  -> 主进程能力模块
       ├─ parser.cjs       合同解析
       ├─ storage.cjs      原始文件和状态持久化
       ├─ knowledge.cjs    知识文件解析、条款抽取和本地检索
       ├─ review-engine.cjs 规则三态、模型风险归一化和风险合并
       ├─ review-runner.cjs 审查任务编排
       ├─ model-gateway.cjs OpenAI 兼容模型网关
       ├─ context-assembler.cjs L0-L6 上下文组装、选区扩圈和预算裁剪
       ├─ memory-service.cjs 记忆召回、敏感扫描、冲突和确认治理
       ├─ review-chat.cjs 对话审核、风险/局部审查和会话持久化
       ├─ tool-protocol.cjs MCP/Skill 统一协议、权限和执行记录
       ├─ legal-source.cjs 白名单法律来源核验
       ├─ validator.cjs    结果与导出门禁
       └─ exporter.cjs     DOCX/PDF/XLSX/JSON 导出
  -> Electron userData 目录
```

主要代码入口如下：

- `src/App.vue`：应用视图切换、新建审查、配置弹窗、导出弹窗。
- `src/components/AppShell.vue`：桌面端壳、导航、顶部栏和状态栏。
- `src/components/ReviewWorkspace.vue`：合同阅读器、风险清单、详情气泡、划词/局部审查，以及原文下方的对话、模型切换、上下文开关、引用、风险和记忆候选交互。
- `src/components/KnowledgeView.vue`：法律快照、确定性规则库和企业制度管理。
- `src/components/CapabilityView.vue`：模型和 Skill 配置管理。
- `src/components/SettingsView.vue`：本地保存、导出门禁和安全策略设置。
- `src/stores/review.js`：审查状态、人工操作、配置绑定、持久化和导出调用。
- `electron/main.cjs`：窗口创建、IPC 注册和导入/校验/导出流程编排。
- `electron/credential-store.cjs`：使用 Electron `safeStorage` 按引用加密保存和读取本机 API Key。

### 2.1 Electron 安全边界

Electron 窗口启用了 `contextIsolation`、关闭 `nodeIntegration` 并启用 `sandbox`。渲染层不直接使用 `fs`、`path`、`child_process` 或 Electron 原生对象。

`electron/preload.cjs` 只通过 `contextBridge` 暴露以下业务接口：

- 选择合同文件。
- 导入合同并返回项目状态。
- 选择和导入知识文件。
- 导入法律快照并核验实时法律来源。
- 执行审查任务并订阅任务进度。
- 执行对话审核、流式事件订阅、取消和重试。
- 确认或放弃企业记忆候选。
- 保存 API Key 和查询凭据是否已配置；主进程不向渲染层返回 Key。
- 读取本地状态。
- 保存本地状态。
- 执行导出前 Validator。
- 执行审查结果导出。

`src/services/electronApi.js` 对这些接口做了渲染层封装。非 Electron 浏览器预览只使用 `localStorage` 保存界面状态，并明确阻止本地合同导入和导出能力。

### 2.2 Electron 桌面端启动方式

项目交付和验证应使用 Electron 桌面端，不应直接打开 `dist/index.html` 或只使用浏览器预览。启动方式分为开发模式和生产构建模式。

开发模式在项目目录 `D:\项目\CheckMCP\Doc\合同审批` 执行：

```powershell
npm.cmd run dev:desktop
```

该命令由 `concurrently` 先启动 Vite `127.0.0.1:5173`，再通过 `scripts/launch-electron.cjs` 启动 Electron 窗口。窗口标题为 `contract-review-agent-desktop`。启动器会清除 `ELECTRON_RUN_AS_NODE`，并加入无 GPU 兼容参数。

若 `5173` 已被占用，使用两个 PowerShell 窗口：

```powershell
# 窗口一
npm.cmd run dev -- --host 127.0.0.1 --port 5174
```

```powershell
# 窗口二
$env:VITE_DEV_SERVER_URL = 'http://127.0.0.1:5174'
node scripts/launch-electron.cjs .
```

生产模式先构建，再启动 Electron：

```powershell
npm.cmd run build
npm.cmd run electron
```

生产模式不依赖 Vite 服务，Electron 主进程会加载 `dist/index.html`；本地合同导入、凭据加密存储、模型调用、审查和导出仍通过 Electron 主进程执行。

## 3. 本地合同导入和解析

### 3.1 导入流程

新建合同审查页面只保留项目名称、合同类型、合同文件和审查模式。辅助材料不在新建页面中设置，符合当前交互约定；辅助资料后续应在项目级资料管理中实现。

导入流程如下：

```text
用户打开“新建合同审查”
  -> Electron 打开本地文件选择器
  -> 选择 DOCX 或 PDF
  -> 主进程检查文件存在性、普通文件属性、扩展名、大小
  -> parser.cjs 读取并解析
  -> storage.cjs 按项目和文件版本复制原始文件
  -> 计算并保存 SHA-256
  -> 创建 Project、Review、Document 和 Task
  -> 保存 state.json
  -> Vue 切换到审核工作区
```

### 3.2 解析器行为

`electron/parser.cjs` 当前支持：

- DOCX：使用 `mammoth` 提取正文文本，生成页数组和解析消息。
- 可搜索 PDF：使用 `pdfjs-dist` 逐页读取文本层，保留页码和文本。
- 扫描 PDF：如果页面没有文本层，标记为 `scanned_pdf`，并明确记录 OCR 不可用。
- 单文件默认上限为 50 MB，页数默认上限为 300 页。
- 为文档保存文件名、扩展名、MIME、大小、SHA-256、页数、正文和每页 OCR 状态。

当前 DOCX 解析以提取文本为主，不把重排后的文本页面宣称为原始 Word 版式；当前 PDF 阅读同样以解析文本层为主。扫描 PDF 不伪造文本、页码、坐标或风险定位，导出门禁会阻断缺少 OCR 文本的结果。

### 3.3 原始文件与版本

原始合同不会被解析、标注或导出覆盖。`storage.cjs` 将原始文件复制到 Electron 用户数据目录下的项目文件版本目录，并为每次导入生成独立文件名。

当前状态对象至少区分：

- `project_id`：项目标识。
- `file_version_id`：合同文件版本标识。
- `review_version_id`：审查结果版本标识。
- `export_id`：导出记录标识。
- `chat_session_id` / `chat_message_id`：对话会话和消息标识。
- `context_snapshot_id`：本轮模型实际使用的上下文快照标识。
- `memory_candidate_id` / `memory_version_id`：企业记忆候选和正式版本标识。

因此人工处理、局部审查和导出不会覆盖原始合同文件。

## 4. 状态对象和本地持久化

当前持久化根对象为 `state`，主要包含：

| 对象 | 作用 |
|---|---|
| `projects` | 项目名称、合同类型、原始文件路径、文件版本和更新时间 |
| `reviews` | 每个项目对应的审查版本、文档、风险、配置和任务 |
| `knowledge` | 法律快照、确定性规则库、企业制度和企业记忆配置 |
| `capabilities` | Skill 和模型配置 |
| `settings` | 自动保存、默认导出格式、Validator 和安全策略 |
| `auditRecords` | 导入、配置、人工处理、模型配置和导出操作审计 |

`electron/storage.cjs` 将状态写入 `userData/state/state.json`，采用临时文件写入后重命名的方式保存，降低状态文件写入中断导致损坏的风险。合同原始文件保存在 `userData/projects/<project>/file-versions/<version>/` 下。

Pinia store 的主要保存时机包括：

- 合同导入完成后。
- 知识库勾选、新增、编辑和删除后。
- 模型或 Skill 配置变更后。
- 系统设置变更后。
- 风险人工处理后。
- 选区高亮或局部审查提交后。
- 导出成功或导出被阻断后。

## 5. 知识库、规则和审查配置

### 5.1 法律知识快照

界面提供法律快照列表，并区分 `published`、`draft` 和历史状态。当前审查配置只能选择已发布快照，导出 Validator 也会检查审查结果是否绑定已发布快照。

当前已支持：

- 查看快照详情，包括快照 ID、名称、状态、覆盖范围、来源数量、发布时间和哈希。
- 编辑快照名称、状态、覆盖范围、来源数量和发布时间，并将修改保存到本地状态。
- 保留快照 ID 和哈希字段，供审查配置绑定和后续 Validator 使用。

当前已经支持从本地 JSON/Markdown/TXT 导入法律快照，校验快照 ID、名称、状态和条款结构，计算内容哈希并按版本目录保存原始文件。快照详情可查看来源地址、解析条款和最近一次实时核验结果；实时核验仅访问系统设置中配置的 URL 白名单，并在超时、HTTP 错误或未授权时返回 unavailable/unauthorized，不伪造法律来源。编辑时保留快照 ID 和哈希，正式发布流程仍应遵守 published 状态快照不可原地修改、修订生成新版本并保留历史版本的要求。

### 5.2 确定性规则库和企业制度

确定性规则库与企业制度都使用表格展示，面向大量文件保留横向滚动和批量选择能力。表格字段包括：

- 文件名。
- 文件摘要。
- 勾选状态。
- 规则库的状态、类型和优先级。
- 企业制度的版本和发布状态。

已经支持：

- 单项勾选和全选。
- 新增文件上传（通过 Electron 本地文件选择器导入；编辑窗口只维护已上传文件的引用元数据）。
- 编辑文件名、摘要和元数据。
- 单个删除和批量删除。
- 删除确认。
- 删除后从已有审查配置中解除文件引用。
- 变更写入审计记录。

当前勾选动作会更新 review.config.rules 和 review.config.policies，从而形成“本次审查引用了哪些规则和制度”的配置记录。Electron 上传会校验扩展名和 50 MB 大小限制，复制原始文件到 userData/knowledge/<kind>/<file_version_id>/，计算 SHA-256，并解析 DOCX/PDF/Markdown/TXT/JSON 中的条款编号、标题、正文和关键词。规则文件与企业制度分别进入规则执行和依据检索链路；权限过滤、有效期过滤和跨文件一致性比对仍待后续接入。

### 5.3 企业记忆

知识库页面继续提供企业记忆查看和编辑入口；对话审核增加了受治理的召回和写入闭环：

- 只召回正式/已确认、在有效期内、作用域匹配当前项目/合同类型/用户且通过敏感策略的记忆。
- 外部模型默认只接收公开记忆；内部或本地模型可按本地策略接收内部记忆，受限记忆默认不出域。
- 模型输出不能直接写入 `knowledge.memory`，只能形成 `memory_candidate`，并记录来源消息、引用和冲突键。
- 写入前执行凭据、手机号、邮箱、身份证、银行卡、合同具体金额和未核验结论扫描；发现阻断项时必须先编辑或脱敏。
- 同一 `conflict_key` 存在正式记忆时，界面展示冲突，用户必须选择替换、合并、保留现有或放弃。
- 确认后生成正式记忆版本、`MEMORY_CONFIRMED` 审计记录；放弃生成 `MEMORY_DISMISSED` 审计记录。

对话消息、上下文快照和记忆候选只属于当前审查会话，不会自动变成长期企业记忆。当前实现的 L0-L6 组织方式由 `context-assembler.cjs` 固定优先级实现：本轮请求/选区/风险、审查快照、会话摘要、知识依据和已验证记忆；L6 元治理信息只参与过滤和排序，不伪装成事实依据。

### 5.4 新建审查的配置确认

审核工作区可以通过配置按钮打开“本次审查配置”气泡/弹窗，确认以下内容：

- 合同类型。
- 标准审查或实时核查模式。
- 已发布法律快照。
- 确定性规则库。
- 企业制度。
- 当前启用模型和 Skill 的执行快照。

配置保存后写回当前 Review，并更新时间。标准审查使用已发布法律快照和本地知识条款；实时核查模式仍需通过法律快照页面手动触发白名单来源核验，核验失败只产生降级状态，不影响本地证据链的真实性。

## 6. 模型与 Skill 配置如何进入审查工作

### 6.1 模型配置

能力配置页面支持多个模型记录，每个模型包含：

- 配置名称和模型标识。
- 服务商和 API 地址。
- `analysis`、`extraction`、`embedding`、`rerank`、`vision` 角色。
- 配置版本、上下文长度、最大输出 Token。
- 超时、重试次数和数据策略。
- Key 引用名和本机加密凭据状态；明文 API Key 不进入模型对象。
- 启用/停用状态和本地字段校验状态。

保存模型前会检查名称、模型标识和 API 地址。用户可在同一弹窗直接填写明文 API Key 和 Key 引用名；Key 只通过白名单 IPC 进入主进程，由 Electron `safeStorage` 加密到 `userData/state/credentials.json`。模型对象、Pinia 状态、执行快照、审计和日志只保存引用名，不保存明文 Key。编辑时不回显 Key，留空保存沿用旧凭据，填写新 Key 则覆盖对应引用，因此多个模型可以绑定不同 Key，应用重启后继续使用。保存后模型默认停用并清除旧校验状态；“校验配置”会检查非敏感字段和引用对应的本机凭据状态（不发送合同内容），通过后用户才能手动启用，未校验模型不会进入审查执行快照。审查执行时，model-gateway.cjs 通过主进程 resolver 读取对应 Key，调用 OpenAI 兼容的 /chat/completions 接口，要求 JSON 输出，并记录调用耗时、usage、错误码和有限重试结果；返回对象不包含凭据。模型未配置、凭据不可用、请求超时、HTTP 失败或 JSON 无法解析时，审查保留规则结果并进入 partial/needs_verification 状态。

### 6.2 Skill 配置

能力配置页面支持查看内置 Skill 的版本、作用域和状态，并支持启用/停用。`isolated` 和 `validating` 状态的 Skill 不能被启用。

当前 Skill 配置没有实现外部包上传、`SKILL.md` 结构检查、脚本沙箱、依赖校验、签名校验或实际 Skill 运行时。对话输出的 Skill 意图会进入统一工具协议，由权限策略和执行器可用性共同决定；当前没有注册真实执行器时只生成 `blocked` 执行记录，不会假装完成。

### 6.3 对话审核与上下文组装

合同原文阅读器下方新增对话审核区，渲染层可选择当前已启用且通过本地字段校验的 `analysis` 模型。每次发送只提交项目/审查标识、用户输入、选区锚点、当前页、当前风险和上下文开关，主进程重新读取本地状态后组装上下文。

`context-assembler.cjs` 的调用顺序是：

```text
当前 Review / 会话 / 用户输入
  -> 解析当前页和选区
  -> 选区默认扩展到所在条款及前后同级条款
  -> 检索已选规则、企业制度和已发布法律快照
  -> 召回通过权限、状态和有效期过滤的企业记忆
  -> 按 system、用户指令、选区、风险、依据、当前页、记忆、近期消息、摘要排序
  -> 估算 Token 并裁剪低优先级内容
  -> 生成 context_snapshot 和模型 messages
  -> 调用 analysis 模型并校验结构化结果
```

`ContextSnapshot` 保留文件版本、页码哈希、选区哈希、引用 ID、记忆 ID、会话消息引用、保留/省略区段、预算和估算 Token。模型不会获得 API Key、凭据引用值或本地绝对路径。

### 6.4 对话结果与现有审查链路

模型结果统一归一化为 `answer`、`create_risk`、`local_review`、`clarify` 四种意图。`create_risk` 结果复用现有 `review.risks`，强制设置 `source_type=chat_model`、`conclusion_status=needs_verification`、`human_status=pending_review`，引用只能从当前上下文快照的具体条款中选择。定位或依据不足时保持 `unverified`，不自动形成确认结论。

`local_review` 复用已保存选区标记；尚未点击高亮但刚刚划出的临时选区也可以直接提交，系统仍会绑定文件版本、页码、条款号、字符范围和文本哈希。结果进入风险清单和人工复核版本，保留已有 Validator 门禁。

对话会话持久化在 `review.chat_sessions`，其中保存消息、上下文快照、模型配置脱敏快照、记忆候选、工具执行记录和请求状态。超过 12 条消息时生成确定性的近期消息摘要和恢复检查点，失败消息保留相同用户输入和上下文引用，支持重试；模型网关支持 SSE 增量回调，用户取消后记录 `MODEL_REQUEST_CANCELLED`。

### 6.3 审查执行快照

`src/services/managementState.mjs` 中的 `buildReviewExecutionConfig` 将能力配置压缩为一次审查可追溯的快照：

1. 只纳入状态为 `enabled` 的 Skill，并保存名称、版本和作用域。
2. 只从状态为 `active` 的模型中为五种角色选择模型。
3. 只保存模型名称、模型标识、服务商、配置版本和数据策略。
4. 不把 API 地址、明文密钥或凭据内容写入审查执行快照。

该快照同时写入：

```text
review.config.execution
review.task.execution
```

审核工作区顶部的“本次审查执行配置”区域会展示语义分析、条款抽取、向量检索、结果重排模型和已启用 Skill 数量。模型或 Skill 状态变化后，当前审查的执行快照会重新同步并写入审计记录。

需要特别区分：当前已完成配置选择、快照绑定、工作区展示、本地持久化、OpenAI 兼容模型调用、结构化输出解析、usage/耗时记录和有限重试；成本换算、备用模型降级、限流和 Skill 实际执行尚未实现。

## 7. 审核工作区

### 7.1 主布局

审核工作区采用“合同原文 + 风险清单”为主的双栏布局。风险详情不是固定的第三栏，而是点击风险卡或原文风险高亮后才出现的右侧浮层气泡：

- 默认没有详情时，不预留最右侧空白栏。
- 桌面端详情浮层覆盖在工作区右侧，并通过箭头指向风险清单区域。
- 关闭按钮会清除当前风险，不再显示详情层。
- 窄屏下仍使用独立浮层气泡，避免底部抽屉造成内容遮挡和两侧留白；内容过长时只在气泡内部滚动。
- 详情中保留合同定位、风险分析、修改建议、法律依据和企业制度依据；每条风险依据同时显示依据文件名、具体条款编号/标题和条款原文摘录。
- 页面级操作结果使用从上方居中位置弹出的通知气泡展示，不再占用右上角固定布局区域。

### 7.2 审查任务状态

合同导入完成后，Pinia 调用 review:run，主进程通过 review-runner.cjs 按以下顺序推进任务：

```text
rules -> retrieve -> model -> validate -> persist
```

主进程通过 review:progress IPC 事件发送项目 ID、当前步骤、进度和运行状态；渲染层只更新当前 Review.task，不接收模型原文或凭据。工作区顶部任务卡展示排队、执行中、等待人工复核、部分完成、失败和完成状态，以及当前步骤、百分比和错误码。部分完成或失败时保留已生成的规则/检索结果，并显示重试按钮。

### 7.3 合同阅读器

阅读器当前支持：

- 按页显示解析文本。
- 上一页、下一页和页码选择。
- 缩放、缩小和适应宽度。
- 当前页搜索和命中数量显示。
- 根据风险定位页码切换页面。
- 根据风险原文片段对正文做高亮。
- 显示文件 SHA-256、文件版本和 OCR 状态。

无法在当前页找到风险原文片段时，不会强行插入高亮。真实导入合同会由 review-runner.cjs 执行规则判断、知识依据检索和可选模型分析，风险清单只使用本次 Review 的真实结果，不从 src/data/sampleData.js 复制风险。

### 7.4 风险清单和人工处理

风险清单支持按风险等级筛选，风险卡显示风险等级、类别、页码、条款号、证据状态和人工处理状态。点击风险卡会：

1. 设置当前风险。
2. 按风险的 `contract_location.page` 跳转到对应页面。
3. 打开右侧风险详情气泡。
4. 在原文中高亮对应引用片段。

详情气泡提供接受、误报、人工修改、延期和删除操作。操作结果会：

- 修改风险的人工状态和必要的结论状态。
- 生成新的人工修订记录。
- 保存修改前后状态、操作人、时间、原因和基础审查版本。
- 更新当前审查版本号和任务状态。
- 写入本地状态和审计记录。

风险依据不只显示文件名：法律依据和企业制度依据均展示来源文件名、具体条款编号/标题及对应条款原文摘录，帮助审核人员直接判断依据是否支持当前结论。详情气泡不再单独展示追踪/审计区块，定位、版本和依据内容只作为风险详情和 Validator 所需的数据处理，不在页面重复展开。

当前人工修改按钮已经能够保存“人工修改”状态，但还没有增加风险等级、分析正文和依据表单；后续需要把 FR-044 的人工新增字段补充到工作区表单。

## 8. 人工划词、标记和局部审查

### 8.1 选区捕获

用户可以在解析文本层中通过鼠标或触控选择连续文本。组件在选区结束时记录：

- 选区文本快照 `text_snapshot`。
- 当前合同文件版本 `file_version_id`。
- 当前页码 `page`。
- 从当前解析页 DOM 文本计算出的 `char_range`。
- 当前页推断出的条款号 `clause_no`。
- 文本哈希 `text_hash`。
- 创建时间和选区标识 `annotation_id`。

这里的字符范围是当前阶段基于解析页文本层计算的范围，已经具备页码、文件版本和文本哈希三类回溯信息；后续接入真实文档 Artifact 时，需要将其统一为原始解析 Artifact 的全局字符偏移或 PDF 坐标范围。

### 8.2 选区操作气泡

选择文本后，原文附近显示操作气泡，提供图标按钮：

- 高亮标记。
- 审核选中内容。
- 关闭选区操作。

点击“高亮标记”会调用 `store.saveSelectionAnnotation`，将选区写入当前 `review.annotations`。阅读器重新渲染后，已保存选区会以独立的人工标记样式持续显示，并显示当前页已标记数量。

### 8.3 局部审查

点击“审核选中内容”后，气泡切换为局部审查表单，当前支持选择：

- 审核类型：法律风险、条款合理性、模板对比、修改建议、条款解释、专项审核。
- 专项方向：付款、违约责任、责任限制、知识产权、保密、数据保护、解除终止、争议解决和通用条款。
- 上下文范围：选区所在条款、所在条款及前后同级条款、条款及显式引用关系。

提交后执行以下本地状态流程：

```text
保存选区标记
  -> 创建 manual_selection_review 风险候选
  -> 绑定选区文本、页码、条款号、字符范围、文件版本和文本哈希
  -> 结论状态 = needs_verification
  -> 证据状态 = unverified
  -> 人工状态 = pending_review
  -> 追加 humanRevisions 记录
  -> 生成新的 review_version_id
  -> 将任务置为 waiting_confirmation
  -> 打开风险详情气泡
```

局部审查候选不会直接生成 `confirmed` 结论，也不会自动改写、签署、发送合同。直接点击选区气泡中的局部审查按钮会先生成可追溯的人工候选；通过下方对话发送局部审查请求时，`context-assembler.cjs` 会实际扩展所在条款及前后同级条款、检索制度/规则/法律快照和召回允许的企业记忆，再调用当前 analysis 模型。两条路径都进入同一待核验风险、人工复核和 Validator 流程。

## 9. Validator 与导出门禁

### 9.1 Validator 检查内容

`electron/validator.cjs` 在导出前检查：

- 审查结果、项目、合同文档和文件版本是否存在。
- 合同类型是否存在。
- 扫描 PDF 是否缺少 OCR 文本。
- 法律快照是否存在且为 `published`。
- 导出格式是否属于 DOCX、PDF、XLSX、JSON。
- 结果中是否出现疑似 API Key、Bearer Token 或私钥。
- 风险清单是否为合法数组。
- 风险必填字段、风险等级、类别、结论、证据和人工状态是否符合枚举。
- 风险定位是否绑定当前文件版本、合法页码和原文锚点。
- 定位置信度是否达到 0.7。
- 高风险是否已经完成人工复核。
- 高风险证据是否为 `verified`。
- 已确认结论是否绑定无效证据。
- 法律依据是否具备来源标识、标题、有效状态并绑定当前快照。

Validator 返回 `canExport`、机器可读的校验项、阻断错误码和处理建议。当前已经覆盖需求说明中的“无法验证不能当作通过”原则，并对高风险待人工复核执行阻断。

### 9.2 导出流程

```text
用户选择导出格式
  -> renderer 调用 validateExport
  -> preload 转发 review:validate-export
  -> 主进程执行 Validator
  -> 存在阻断项：写入 EXPORT_BLOCKED 审计，不生成 completed 记录
  -> 校验通过：选择本地目录
  -> exporter.cjs 生成各格式文件
  -> 每种格式生成独立 ExportRecord
  -> 保存审查版本、文件版本、模板版本和生成时间
```

当前 `exporter.cjs` 支持：

- DOCX：生成合同审查报告和风险清单。
- PDF：生成可打开的审查报告。
- XLSX：生成带筛选、冻结行和结构化字段的风险清单。
- JSON：保存审查版本、合同文档、配置、风险和人工修订。

当前导出的是审查报告，不是带原生 Word 修订/批注或 PDF 批注层的合同副本；需求说明中的带批注合同副本能力仍属于后续阶段。

## 10. 模块串联的完整路径

### 10.1 新建合同审查路径

```text
新建审查页面
  -> 选择项目名称、合同类型、审查模式和本地文件
  -> Electron 主进程解析文件
  -> 原始文件按文件版本复制保存
  -> 创建 Project/Review/Document/Task
  -> Pinia 接收新状态
  -> 绑定当前启用模型与 Skill 快照
  -> 调用 review:run 执行 P0 审查编排
  -> 进入审核工作区
```

### 10.2 审查工作路径

```text
审核工作区
  -> 阅读解析文本并翻页/搜索
  -> 查看任务卡中的当前步骤、进度和错误
  -> 风险清单点击联动页码和原文
  -> 详情气泡查看依据、分析和建议
  -> 人工接受、误报、修改、延期或删除
  -> 生成新的人工修订版本
  -> 本地持久化并写审计记录
```

### 10.3 局部审查路径

```text
原文选中文本
  -> 选区操作气泡
  -> 高亮保存，或选择局部审查类型
  -> 保存文本快照和定位锚点
  -> 创建 needs_verification 风险候选
  -> 加入当前风险清单
  -> 打开风险详情气泡进行人工处理
  -> 进入 Validator 和导出流程
```

### 10.4 配置与审查的连接点

```text
能力配置 / 知识库配置
  -> Pinia 保存配置
  -> buildReviewExecutionConfig 生成执行快照
  -> review.config.execution / review.task.execution
  -> 审核工作区顶部展示当前实际绑定配置
  -> review-runner 使用规则、制度、法律快照和 analysis 模型执行审查
  -> 导出报告记录审查配置和法律快照
```

当前连接点解决了“模型以及 Skill 配置后，需要在审核工作中使用到”的界面、快照和执行绑定问题；P0 已接入规则执行、知识检索、模型网关调用和结果归一化，P1 对话审核继续复用同一模型执行快照和风险 Schema。`tool-protocol.cjs` 已统一 MCP/Skill 调用的输入、权限决定、沙箱要求、错误码和执行记录；当前没有真实执行器时只记录阻断，不宣称 MCP Tool 或 Skill 已实际运行。

### 10.5 对话审核模块串联

```text
ReviewWorkspace.vue
  -> review store.chatReview
  -> electronApi / preload contextBridge
  -> review:chat IPC
  -> review-chat.cjs
       ├─ resolve active analysis model
       ├─ context-assembler.cjs 生成 L0-L6 快照
       ├─ memory-service.cjs 召回已验证记忆
       ├─ model-gateway.cjs 调用 JSON / SSE 模型接口
       ├─ review-chat.cjs 校验意图、引用和风险候选
       ├─ tool-protocol.cjs 记录或执行 MCP / Skill 意图
       ├─ review.risks / chat_sessions / memory_candidates 持久化
       └─ auditRecords 记录请求、取消、候选和确认动作
```

记忆确认和放弃分别通过 `review:memory-confirm`、`review:memory-dismiss` IPC 进入主进程，主进程再次校验会话归属、敏感信息、冲突和当前正式记忆后才写入 `knowledge.memory`。因此 UI 的“确认写入”不是直接修改 Pinia 数组。

## 11. 与需求说明的覆盖情况

| 需求范围 | 当前实现 | 阶段状态 |
|---|---|---|
| FR-004、FR-005 原始文件和版本 | 原始文件只读复制，区分文件/审查/导出标识 | 已实现基础能力 |
| FR-010、FR-016 合同导入解析 | 支持 DOCX、可搜索 PDF、扫描 PDF 状态识别和 SHA-256 | 已实现基础能力 |
| FR-020、FR-023、FR-024 阅读和风险联动 | 翻页、搜索、缩放、风险页码和原文高亮 | 已实现 |
| FR-025 定位失败保护 | 找不到原文不强行高亮，Validator 检查定位 | 已实现 |
| FR-030 至 FR-040 划词和局部审核 | 鼠标/触控选区、人工高亮、局部审核表单、对话触发局部审查、待核验风险和版本记录 | P1 已实现基础链路；复杂 Artifact 坐标映射待接入 |
| FR-041 至 FR-046 人工纠正 | 接受、误报、修改、延期、删除和人工修订记录 | 已实现基础能力；人工新增字段待补全 |
| KB-001、RULE-001 法律快照和规则库 | 快照本地导入/查看/编辑/条款解析/白名单核验，规则库和企业制度文件上传、解析、勾选、增删改和审查引用绑定 | P0 已实现；发布工作流、权限和一致性比对待接入 |
| FR-063、FR-064 审查前配置 | 合同类型、审查模式、法律快照、规则、制度和执行快照 | 已实现配置承载 |
| FR-070 至 FR-078 模型配置 | 多模型、角色、字段校验、启停、执行快照和 OpenAI 兼容网关调用 | P0 已实现调用基础；成本、限流和备用模型待接入 |
| FR-080 至 FR-086 Skill 管理 | 内置 Skill 展示、启停、版本和作用域 | 已实现配置层；安装校验和运行待接入 |
| FR-090 至 FR-094 MCP Tool | 有统一 Tool 调用协议、权限判断、沙箱要求、阻断/失败/完成记录；未注册真实执行器时明确阻断 | P2 协议和审计基础已实现；真实 MCP 执行器待接入 |
| FR-100 至 FR-106 记忆系统 | L0-L6 上下文组织、正式记忆召回、有效期/作用域/敏感过滤、候选确认、冲突处理、版本和审计 | P1 已实现本地闭环基础；多用户权限和向量召回待接入 |
| FR-120 至 FR-124 Validator | 输入、定位、证据状态、风险枚举、人工复核和敏感信息检查 | 已实现导出门禁基础能力 |
| FR-140 至 FR-146 通用任务和审计 | 本地任务字段、阶段进度事件、审计记录、通知、失败/部分完成状态、对话取消/重试、会话摘要检查点和工具执行记录 | P1-P2 已实现本地基础；分布式追踪和多人协作待接入 |
| SEC-002、SEC-003、SEC-005 | Electron 隔离、白名单 API、原始文件只读、凭据只保存引用名 | 已实现基础边界 |
| SEC-001、SEC-006 至 SEC-010 | 用户权限、数据出域、病毒扫描、Skill 沙箱和安全回归 | 未实现完整能力 |
| FR-047 至 FR-050 结果导出 | DOCX/PDF/XLSX/JSON、独立记录和导出前门禁 | 已实现报告导出；带批注合同副本待接入 |

## 12. 下一阶段 ToDoList

以下工作项是基于当前代码和《合同审查 Agent 需求说明》v0.4 整理的阶段清单。`[x]` 表示本阶段已经通过代码或测试验证，`[ ]` 表示尚未完成；P0 影响真实审查主链路，P1 影响生产可用性和核心扩展能力，P2 影响协同、治理和规模化验收。未实现的能力不得以示例数据或静态配置冒充完成。

### P0：本阶段已完成

- [x] **知识文件本地上传**：确定性规则库和企业制度通过 Electron 多文件选择器导入，校验扩展名和 50 MB 大小限制，复制到 userData/knowledge 分版本目录，保存文件名、路径引用、大小、SHA-256、条款和解析状态；上传文件默认不勾选，避免未经确认进入审查。
- [x] **合同导入后自动审查**：导入并解析合同后创建 Project/Review/Document/Task，绑定当前配置快照并调用 review-runner 执行真实规则、检索和模型链路；真实合同风险不从 sampleData.js 复制。
- [x] **确定性规则执行**：支持金额比例、必需条款、日期顺序和关键词规则，输出命中、未命中、无法判断三类结论，并保留合同页码、条款号和原文锚点。
- [x] **知识检索和依据生成**：支持法律快照、企业制度和规则文件的条款解析与本地关键词检索；风险依据返回文件名、条款编号/标题、条款原文、来源类型和版本。
- [x] **模型网关真实调用**：支持已配置 analysis 模型的 OpenAI 兼容 chat/completions 调用、结构化 JSON 解析、usage/耗时记录、有限重试和错误降级；Key 可由页面一次性配置，主进程使用 Electron safeStorage 加密保存并按引用注入。
- [x] **法律快照导入和实时核验**：支持本地快照 JSON/Markdown/TXT 导入、哈希和条款解析、已发布快照绑定、白名单来源核验，以及不可用/未授权降级，不伪造外部法律来源。

### P1：对话审核、解析和执行扩展

- [x] **对话审核基础链路**：合同原文下方提供会话、已启用 analysis 模型选择、上下文开关、消息列表、失败重试和本地持久化；每轮生成可审计 `ContextSnapshot`。
- [x] **对话风险与局部审查**：支持 `answer/create_risk/local_review/clarify` 结构化结果；对话风险和局部审查均进入既有 `review.risks`、人工复核和 Validator 流程，不能自动确认。
- [x] **企业记忆闭环基础**：按正式状态、有效期、作用域、敏感等级和模型策略召回；候选经敏感扫描、冲突比较、人工确认/放弃后才写入正式记忆并生成版本和审计。

- [ ] **对话交互收尾**：增加独立的“重新审查此选区”快捷操作，并在聊天结果中补充企业记忆来源和有效期展示；当前可通过自然语言复用选区，候选卡已展示作用域、类型和置信度。
- [ ] **复杂文档解析**：接入 OCR，支持扫描 PDF 文本和置信度；补充 PDF 坐标映射、Word 原始版式、表格、脚注、附件和引用关系解析。
- [ ] **Agent 执行编排**：实现 Plan-and-Execute、Trace/Span/Event、Artifact、Checkpoint、幂等键和断点恢复，完善 `queued/running/waiting_confirmation/partial/failed/completed` 状态机。
- [ ] **MCP Tool 执行器**：统一输入输出 Schema、权限上下文、错误码和执行记录已经具备；仍需注册真实 Tool、超时/重试/幂等策略和 Artifact 引用，并接入规则、检索、模型和实时核验工具。
- [ ] **Skill 包生命周期**：支持 Skill 包上传、`SKILL.md` 结构校验、依赖检查、签名校验、隔离目录、沙箱运行、权限声明、升级和回滚。
- [ ] **人工风险编辑补全**：完善人工修改表单，允许修改风险等级、分析正文、结论、依据和定位；支持人工新增风险，并让所有字段变化进入新审查版本和 Validator 校验。
- [ ] **带批注合同副本导出**：支持 Word 原生修订/批注、PDF 批注层或可回写合同副本，并将副本与审查版本、原始文件版本和导出记录绑定。
- [ ] **辅助资料管理**：实现项目级资料上传、版本关联、权限和有效期过滤，以及金额、数量、日期、验收等跨文件一致性检查。

### P2：治理、协同和验收

- [x] **流式、取消和会话恢复基础**：模型网关支持 SSE 增量回调；对话支持取消、失败重试和长会话确定性摘要检查点。
- [x] **统一 MCP / Skill 协议基础**：模型 Tool 意图统一记录名称、参数、权限决定、必需沙箱、状态、错误码和输出脱敏结果；无真实执行器时强制阻断。
- [x] **本地会话/记忆策略基础**：系统设置可控制会话访问范围、记忆人工确认、MCP/Skill 执行确认和外部模型敏感记忆策略。
- [ ] **账号和权限**：实现账号登录、组织隔离、项目级访问控制、知识库写入权限和正式审批/会签/签署流程。
- [ ] **项目与版本管理**：补齐项目 CRUD、项目搜索、合同版本历史、资料版本历史和删除确认的完整覆盖。
- [ ] **企业记忆规模化**：接入多用户权限、向量召回/重排、可配置保留期、记忆治理审批、撤回和 Golden Set 回归评测。
- [ ] **安全与质量验收**：接入病毒扫描、数据出域策略、Skill 沙箱安全回归、敏感信息扫描、Golden Set、性能压测、异常场景和导出门禁验收。
- [ ] **可观测性和运营**：补齐任务列表、失败重试入口、健康状态、运行耗时/成本统计、审计查询和导出历史查询。

### 下一阶段完成判定

- [ ] 使用固定 Golden Set 完成至少一类合同的端到端自动审查，风险结果、依据和定位可复核。
- [x] 真实导入合同不再依赖 `sampleData.js` 生成风险；模型、规则、检索和人工结果均能区分来源并写入版本记录。
- [x] 自动审查失败、证据不足、OCR 不可用或实时来源不可用时，任务能进入明确的降级/待核验状态，不能输出“已通过”的误导性结论。
- [x] 通过 Validator 的结果才能导出；导出文件、审查版本、合同文件版本、配置快照和审计记录可以相互关联。

## 13. 验证记录

当前阶段已执行：

```text
npm test
49 tests
49 pass
0 fail

npm run build
Vite production build passed

node --check electron/main.cjs
node --check electron/preload.cjs
node --check electron/credential-store.cjs
node --check electron/storage.cjs
node --check electron/parser.cjs
node --check electron/validator.cjs
node --check electron/exporter.cjs
node --check electron/knowledge.cjs
node --check electron/review-engine.cjs
node --check electron/model-gateway.cjs
node --check electron/legal-source.cjs
node --check electron/review-runner.cjs
node --check electron/context-assembler.cjs
node --check electron/memory-service.cjs
node --check electron/review-chat.cjs
node --check electron/tool-protocol.cjs
node --check scripts/launch-electron.cjs
```

测试覆盖了本地状态读写、原始文件版本复制、DOCX/PDF 解析、导出门禁、四种格式导出、模型和 Skill 执行快照、知识文件版本和条款解析、规则三态、知识检索、模型网关、本机多 Key 加密存储、服务商错误脱敏和 DeepSeek 模型标识校验、法律快照导入、白名单核验、真实审查编排、选区文本快照、局部审查风险候选、上下文预算和选区扩圈、记忆召回/敏感扫描/冲突确认、SSE 增量与取消、Tool 协议阻断、对话风险/局部审查持久化、Vue 响应式 IPC 克隆转换和 Electron 启动环境隔离。

## 14. 本次 P0-P2 阶段交付与同步

- 源码交付目录：`D:\项目\CheckMCP\Doc\合同审批`。
- Electron 主进程、预加载白名单、知识文件服务、规则引擎、模型网关、法律来源核验和审查编排代码已纳入同一版本。
- `context-assembler.cjs`、`memory-service.cjs`、`review-chat.cjs` 和 `tool-protocol.cjs` 已分别承载上下文组装、企业记忆闭环、对话审核及 MCP/Skill 协议与审计边界。
- `scripts/launch-electron.cjs` 统一 Electron 启动入口，启动前清除宿主环境中的 `ELECTRON_RUN_AS_NODE`，避免桌面端误以 Node 模式运行。
- `src/services/clonePayload.mjs` 统一处理 Vue/Pinia 响应式对象到 Electron IPC 的可克隆数据转换，覆盖状态保存、审查执行、知识导入、Validator 和导出调用。
- `npm run build` 生成的 `dist/` 已与当前 Vue 3 源码同步，作为生产构建产物一并交付。
- 阶段文档、P0 设计说明和实施计划均保存在 `docs/` 下；原型文件未被覆盖。
- 同步目标为 Git 远端 `origin/master`；提交前重新执行测试、生产构建、Electron 模块语法检查和 Git 差异检查。
- 当前未将 API Key、Bearer Token、私钥或外部绝对路径写入状态文件、日志、审计记录、导出结果或提交内容；API Key 仅以 Electron safeStorage 加密形式保存于本机凭据文件。

对话审核、上下文组装和企业记忆闭环的设计基线位于 `docs/合同审查Agent对话审核与上下文记忆设计方案.md`；本文档已同步标注其中落地的 P1-P2 范围，以及仍未完成的真实执行器和协同治理范围。

P0 中需要配置模型/API 的专项运行与验收步骤已整理在 `docs/合同审查Agent-P0模型API运行验证说明.md`。该说明结合本地 `key.md` 的 DeepSeek 和向量模型配置，但不复制明文密钥；当前只将 DeepSeek `analysis` 调用列为 P0 真实 API 验收项，`qwen3-vl-embedding` 仅验证配置承载，不宣称已接入向量检索。

## 15. 阶段结论

当前版本已经形成可运行的 Electron 本地桌面端 P0-P2 基础闭环：用户可以导入本地合同和知识文件，获得真实解析文本，按已选规则和知识条款执行审查，并可调用已配置模型网关生成结构化候选风险；用户也可以在合同原文下方选择模型，通过自然语言获得建议、生成待核验风险或触发局部审查。对话上下文、引用、会话摘要、记忆候选、确认和审计均本地保存，风险仍需经过人工处理和 Validator 门禁。

这一阶段的核心交付是“文档、规则、知识依据、模型、风险、对话、上下文、企业记忆、人工操作、版本和导出之间的数据连接”。当前仍不是完整生产版：OCR、真实 MCP Tool/Skill 执行器、成本统计、账号权限、病毒扫描、完整任务恢复和带批注合同副本仍未接入。

下一阶段应以当前 `review.config.execution`、`review.task.execution`、`review.chat_sessions`、`ContextSnapshot`、文档解析结果和风险 Schema 为接口，优先推进 OCR、真实 MCP Tool/Skill 执行器、人工风险编辑、完整任务恢复和多用户治理。任何缺少原文、条款或模型结构化依据的结果仍必须保持待核验状态。
