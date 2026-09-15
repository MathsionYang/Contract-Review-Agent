# 合同审查 Agent 技术文档规划与写作路线图

> 文档类型：项目技术文档规划
>
> 对应项目：`合同审批`
>
> 对应知识体系：`ai-capability-engineering/cn/articles`
>
> 编写日期：2026-09-15
>
> 当前基线：P0 真实审查主链路、P1-P2 对话审核与上下文记忆基础

## 1. 文档目的

本文档用于规划合同审查 Agent 后续的技术文章和项目复盘文档。文章不重复解释通用 Agent 概念，而是以合同审查项目为真实案例，记录从需求、架构、编码、测试到验证的完整工程过程。

后续新增文章统一保存到：

```text
D:\项目\CheckMCP\Doc\合同审批\paper
```

文章应能够回答以下问题：

- 一个真实的合同审查任务如何拆解成可执行的 Agent 工作流？
- 模型、规则、知识库、记忆、Validator 和人工复核如何协同？
- 文件、风险、证据、配置和任务状态如何形成稳定契约？
- 模型失败、证据缺失、定位失败、权限拒绝和导出阻断时系统如何降级？
- 哪些能力已经由代码和测试证明，哪些仍然只是设计或协议基础？

## 2. 项目能力画像

### 2.1 产品定位

合同审查 Agent 是面向中国大陆企业内部的单人合同审查工作台，目标是帮助采购、销售、业务和法务人员发现法律、商业、制度和文本质量风险，输出可追溯的审查意见与修改建议，但不替代法务人员的最终判断。

第一版重点覆盖采购合同、供应商服务合同、销售或客户服务合同、房屋租赁合同和软件开发合同。系统不包含自动签署、自动付款、正式会签、自动修改外部业务系统和未经批准的模型或 Skill 自主注册。

### 2.2 当前已具备的能力

| 能力 | 主要实现位置 | 当前状态 |
|---|---|---|
| Electron 桌面端与 Vue 3 界面 | `electron/main.cjs`、`src/App.vue`、`src/components/` | 已实现 |
| 渲染层与主进程隔离 | `electron/preload.cjs`、`src/services/electronApi.js` | 已实现 |
| DOCX 和可搜索 PDF 解析 | `electron/parser.cjs` | 已实现基础能力 |
| 原始文件版本化与 SHA-256 | `electron/storage.cjs`、`electron/parser.cjs` | 已实现 |
| 法律快照、规则库和企业制度导入 | `electron/knowledge.cjs`、`electron/main.cjs` | P0 已实现 |
| 确定性规则执行与关键词检索 | `electron/review-engine.cjs`、`electron/knowledge.cjs` | 已实现基础能力 |
| OpenAI 兼容模型网关 | `electron/model-gateway.cjs` | 已实现基础能力 |
| 风险归一化与证据约束 | `electron/review-engine.cjs` | 已实现 |
| 对话审核和流式响应 | `electron/review-chat.cjs`、`electron/context-assembler.cjs` | P1 基础链路已实现 |
| 企业记忆召回、候选和冲突处理 | `electron/memory-service.cjs` | P1 基础链路已实现 |
| Validator 和多格式报告导出 | `electron/validator.cjs`、`electron/exporter.cjs` | 已实现 |
| 自动化测试 | `合同审批/test/*.test.cjs` | 当前 49 项通过 |

### 2.3 必须明确的未完成能力

后续文章必须将以下内容标记为“未实现”“部分实现”或“后续阶段”，不能写成当前系统已经完成：

- 扫描 PDF 的 OCR、版面坐标和可靠字符定位；
- Embeddings API、向量索引、Top-K 召回和重排序；
- 真实 MCP Tool 或 Skill 执行器、沙箱和依赖隔离；
- Word 原生修订、Word 批注和 PDF 批注层合同副本；
- 多用户协作、完整权限矩阵和跨账号数据隔离；
- 跨文档金额、数量、验收和责任的一致性比对；
- 成本预算、限流、备用模型和完整生产级 Checkpoint 恢复；
- 记忆来源和有效期在聊天界面的完整展示；
- 独立的“重新审查此选区”快捷操作。

## 3. 与 AI 能力工程文章体系的对应关系

`ai-capability-engineering/cn/articles/README.md` 将文章分为总纲、基础层、执行层、可靠性层、协作层、安全层和生产治理层。合同审查项目可以作为一条独立的“项目案例线”，与这些通用文章互相引用。

| 通用层级 | 合同审查案例对应主题 |
|---|---|
| 总纲 | 项目全景、产品边界、能力分期和完整闭环 |
| 基础层 | Electron 安全边界、文件解析、模型配置、知识文件契约 |
| 执行层 | 混合审查编排、局部审查、对话上下文、企业记忆 |
| 可靠性层 | 风险 Schema、Validator、错误码、状态机、Checkpoint、测试 |
| 协作层 | MCP/Skill 协议、工具权限和未来执行器接入 |
| 安全层 | 凭据引用、数据出域、提示注入、人工确认和导出门禁 |
| 生产治理层 | 需求追踪、指标门禁、Golden Set、版本、审计和发布流程 |

写作时应优先引用通用文章的概念和模板，再展示合同审查项目中的具体实现，避免在新文档中复制整段基础理论。

## 4. 核心文章目录

### 4.1 项目与基础设施

#### 01 合同审查 Agent 工程全景：从需求边界到 P0 最小闭环

说明产品定位、用户角色、合同范围、不包含的能力、M0/M1/M2 分期，以及从文件导入到风险导出的完整路径。重点展示“模型只负责候选分析，规则、证据、Validator 和人工负责约束”的总体原则。

主要依据：`合同审查Agent需求说明.md`、`合同审查Agent技术实现阶段文档.md`。

#### 02 Electron 桌面 Agent 安全边界：从 Vue 渲染层到主进程能力隔离

介绍 `Vue/Pinia -> electronApi -> preload -> IPC -> Electron 主进程` 的调用链，解释 `contextIsolation`、`nodeIntegration=false`、`sandbox`、白名单 API、结构化克隆和主进程事件脱敏。

主要依据：`electron/main.cjs`、`electron/preload.cjs`、`src/services/electronApi.js`、`test/electron-api-contract.test.cjs`、`test/clone-payload.test.cjs`。

#### 03 合同文件导入工程：DOCX/PDF 解析、页级定位与版本哈希

说明扩展名和大小校验、DOCX 文本提取、PDF 文本层解析、页数组、文件 SHA-256、原始文件复制和版本标识。单独讨论扫描 PDF 在 OCR 未接入时如何进入不可验证状态。

主要依据：`electron/parser.cjs`、`electron/storage.cjs`、`test/parser.test.cjs`、`test/storage.test.cjs`。

### 4.2 审查智能链路

#### 04 混合审查引擎：确定性规则、知识检索与大模型的协同边界

以付款比例或关键条款缺失为例，展示合同解析、事实抽取、规则判断、知识检索、模型分析、风险合并和结果校验的顺序。明确规则、检索和模型各自负责什么，避免把规则库和 Skill 逻辑混成一层。

主要依据：`electron/review-engine.cjs`、`electron/knowledge.cjs`、`electron/review-runner.cjs`、`test/p0-engine.test.cjs`。

#### 05 可追溯法律知识库：企业制度、规则库与法律快照的版本化检索

介绍知识文件上传、条款编号和标题抽取、来源类型、内容哈希、文件版本、法律快照状态、`published` 约束、离线审查和实时法律来源白名单。重点说明搜索摘要不能单独作为法律依据。

主要依据：`electron/knowledge.cjs`、`electron/legal-source.cjs`、`合同审查Agent需求说明.md` 第 7.7 节。

#### 06 让模型只能提出候选：风险 Schema、证据链与结论降级

说明风险等级、风险类别、风险主题、分析、建议、合同定位、证据状态、结论状态和人工状态的关系。展示模型输出如何归一化，为什么没有原文定位或具体依据时必须进入 `needs_verification`，不能直接变成确认结论。

主要依据：`electron/review-engine.cjs`、`electron/validator.cjs`、`test/p0-engine.test.cjs`、`test/validator.test.cjs`。

#### 07 OpenAI 兼容模型网关实战：凭据引用、结构化输出与故障降级

介绍模型角色、模型标识、服务商、API 地址、配置版本、Token 限制、超时、重试和数据策略。重点展示凭据引用如何在主进程解析，如何使用 `safeStorage` 加密保存，如何将 HTTP 错误、超时和非法 JSON 归一化为机器可读错误码。

主要依据：`electron/model-gateway.cjs`、`electron/credential-store.cjs`、`electron/main.cjs`、`test/credential-store.test.cjs`、`test/p0-engine.test.cjs`。

#### 08 真实模型 API 验证：从配置承载到可证明的调用链

以 DeepSeek `analysis` 模型为验证案例，说明配置保存、真实 `/chat/completions` 请求、结构化响应、`usage`、延迟、失败降级、风险归一化和 Validator 联动。必须单独说明 Qwen 向量模型目前只完成配置展示，不能据此宣称向量检索已经接入。

主要依据：`合同审查Agent-P0模型API运行验证说明.md`、`electron/model-gateway.cjs`。

### 4.3 对话、局部审查与记忆

#### 09 对话式合同审查上下文工程：L0-L6、预算裁剪与上下文快照

介绍当前请求、审查任务、会话、项目、合同类型、企业记忆和元记忆的分层。说明当前页、选区、风险、知识依据、记忆、近期消息和会话摘要的优先级，以及 Token 超预算时如何裁剪并记录省略范围。

主要依据：`electron/context-assembler.cjs`、`合同审查Agent对话审核与上下文记忆设计方案.md`、`test/chat-context-memory.test.cjs`。

#### 10 局部条款审查：选区锚点、上下文扩圈与风险候选

从用户划选一句付款或违约条款开始，说明选区文本快照、页码、字符范围、条款号、文件版本和文本哈希如何形成稳定锚点。进一步说明前后同级条款扩圈、局部审查类型、待核验风险和人工处理的连接方式。

主要依据：`electron/context-assembler.cjs`、`electron/review-chat.cjs`、`src/components/ReviewWorkspace.vue`、`test/chat-context-memory.test.cjs`。

#### 11 企业记忆治理：召回过滤、敏感扫描与冲突确认

区分聊天记录、上下文快照、记忆候选和正式企业记忆。介绍作用域、有效期、状态、敏感等级、模型数据策略、敏感信息扫描、冲突键、替换/合并/保留和记忆版本审计。

主要依据：`electron/memory-service.cjs`、`electron/review-chat.cjs`、`test/chat-context-memory.test.cjs`。

### 4.4 可靠性、安全与治理

#### 12 Validator 导出门禁：从人工复核到 DOCX/PDF/XLSX/JSON 报告

说明 Validator 对项目、合同、OCR、快照、风险字段、风险定位、证据、人工状态和敏感信息的检查。展示高风险未复核、证据无效、定位缺失时如何阻断导出，以及通过后如何分别生成四种格式和导出记录。

主要依据：`electron/validator.cjs`、`electron/exporter.cjs`、`test/validator.test.cjs`、`test/exporter.test.cjs`。

#### 13 合同审查 Agent 的可靠执行：状态机、Checkpoint、幂等与取消

整理任务状态、当前步骤、进度、检查点、幂等键、错误列表、重试和取消行为。文章必须区分“当前已有基础字段和测试”与“完整跨进程恢复、Artifact 引用和生产级重放”之间的差异。

主要依据：`electron/review-runner.cjs`、`electron/review-chat.cjs`、P0 设计文档和需求说明第 11 节。

#### 14 MCP 与 Skill 的受控扩展：协议先行、阻断可观测与执行器接入

介绍统一工具协议、输入输出结构、权限决策、数据脱敏、沙箱要求、执行记录和阻断状态。明确当前没有真实 MCP Tool 或 Skill 执行器，协议完成不等于工具已经运行。

主要依据：`electron/tool-protocol.cjs`、`electron/review-chat.cjs`、`合同审查Agent技术实现阶段文档.md` 第 6.2 节。

#### 15 合同审查 Agent 测试与 Evals：从 49 个单测到 Golden Set

按解析器、存储、规则、知识检索、模型网关、记忆、对话、Validator 和导出拆解当前测试。进一步说明如何设计合同夹具、标注规范、风险粒度、Golden Set、回归报告和发布门禁，避免只用“页面能运行”证明质量。

主要依据：`合同审批/test/`、需求说明第 17 章、`ai-capability-engineering` 的 Evals 和回归报告模板。

#### 16 从需求评审到可验收契约：指标、状态机、RTM 与里程碑拆分

以需求审查报告为案例，解释量化阈值、可判定验收用例、需求追踪矩阵、法律快照交付定义、规则目录、错误码和状态转移表为什么是开发前置条件。文章应保留报告中的 5 项阻断问题和整改路线图，但不把建议阈值误写成正式业务标准。

主要依据：`合同审查Agent需求说明-审查报告.md` 第 3、8、9、10 章。

#### 17 合同审查 Agent 项目复盘：已落地能力、技术取舍与未完成边界

作为系列收束文章，汇总已完成能力、暂未实现能力、关键设计取舍、失败案例、测试结果、数据安全问题和下一阶段路线。重点讨论如何保持“诚实的能力声明”，避免把配置、协议或演示数据当成真实能力。

主要依据：技术实现阶段文档的“覆盖情况”“下一阶段 ToDoList”和 P0 模型验证说明。

## 5. 推荐写作顺序

```text
01 项目全景
  -> 02 Electron 安全边界
  -> 03 文件解析与版本化
  -> 04 混合审查引擎
  -> 05 知识库与法律快照
  -> 06 风险 Schema 与证据链
  -> 07 模型网关
  -> 08 API 验证
  -> 09 对话上下文
  -> 10 局部审查
  -> 11 企业记忆
  -> 12 Validator 与导出
  -> 13 可靠执行
  -> 14 MCP/Skill
  -> 15 测试与 Evals
  -> 16 需求可验收性
  -> 17 项目复盘
```

第一批建议优先完成 01、04、06、07、12、15 六篇。这六篇能够组成从产品目标、核心推理、模型输出、导出门禁到测试证据的最小案例闭环。

## 6. 统一文章结构

每篇文章建议采用以下结构：

1. **真实场景**：先描述合同审查人员遇到的具体问题。
2. **问题边界**：说明目标、非目标、输入和输出。
3. **架构或流程**：用 Mermaid 或文本流程图展示数据流。
4. **数据契约**：给出字段、枚举、状态、错误码或引用结构。
5. **实现拆解**：对应到实际代码模块，展示关键函数和调用边界。
6. **失败与降级**：说明超时、缺失、非法输出、权限拒绝和人工接管。
7. **测试证据**：列出测试文件、测试场景和可观察结果。
8. **当前边界**：明确哪些能力未实现或只能作为协议基础。
9. **复用清单**：提炼可以迁移到其他 Agent 项目的设计原则。
10. **参考资料**：链接到 `ai-capability-engineering` 的通用文章和项目原始文档。

文章应优先使用“真实问题 -> 工程抽象 -> 代码证据 -> 失败处理 -> 可复用结论”的叙事顺序，而不是先罗列概念。

## 7. 统一术语和状态写法

后续文章中应保持以下术语一致：

| 领域 | 推荐写法 |
|---|---|
| 模型风险 | `source_type=model_analysis` 或 `chat_model`，不能写成已确认法律结论 |
| 证据不足 | `evidence_status=unverified` |
| 需要人工确认 | `conclusion_status=needs_verification`、`human_status=pending_review` |
| 模型错误 | `MODEL_CONFIG_INVALID`、`MODEL_REQUEST_FAILED`、`MODEL_OUTPUT_INVALID` |
| 实时法律来源不可用 | `SOURCE_UNAVAILABLE`，使用离线快照并显示未实时核验 |
| 企业记忆 | 区分 `memory_candidate` 和正式 `knowledge.memory` |
| 任务恢复 | 使用 `checkpoint_id`、`idempotency_key` 和已有 Artifact 说明 |
| 工具未接入 | 写成 `blocked` 或“无真实执行器”，不能写成“调用成功” |

需求说明中存在的状态命名差异、幽灵状态和枚举冲突，应在第 16 篇文章中专门说明，并在后续实现中统一，而不是在不同文章中继续沿用不同口径。

## 8. 安全与隐私写作约束

- 不在文章、示例、截图、测试输出或提交记录中出现 API Key、Bearer Token、私钥和完整认证头。
- `合同审批/docs/key.md` 只作为本地验证凭据来源，不能作为文章素材；其中已有明文凭据时，应优先轮换并迁移到操作系统凭据管理器。
- 文章中的合同正文、客户名称、金额、联系人和账号必须使用脱敏夹具。
- 说明外部模型调用时，必须同时写明数据出域策略和组织授权前置条件。
- 任何“安全”“已加密”“已审计”“已验证”的表述都应绑定代码、测试或运行记录，不能只依据设计文档下结论。

## 9. 文件命名和状态约定

新文章建议使用带顺序号的文件名，以保持阅读顺序：

```text
01-合同审查Agent工程全景：从需求边界到P0最小闭环.md
02-Electron桌面Agent安全边界：从Vue渲染层到主进程能力隔离.md
...
```

每篇文章开头建议增加以下元信息：

```text
文档类型：项目实战 / 工程专题 / 阶段复盘
对应阶段：M0 / M1 / M2 / P0 / P1 / P2
对应代码模块：
对应测试：
当前状态：已实现 / 部分实现 / 设计中
```

文章中的代码引用应尽量指向当前仓库中的真实文件和测试；如果示例是伪代码或未来方案，必须显式标注“示意代码”或“计划能力”。

## 10. 完成判定

一篇文章达到可交付状态，至少应满足：

- 标题和主题只覆盖一个主要工程问题；
- 有明确的输入、输出、模块边界和失败路径；
- 至少引用一个真实代码模块和一个测试或验证记录；
- 不把设计目标、配置展示或演示数据写成已经完成的生产能力；
- 能够与 `ai-capability-engineering` 的一篇通用文章建立明确关系；
- 读者可以根据文章复现最小流程，或准确知道复现所需的未完成前置条件。

本路线图本身只负责规划后续写作，不替代需求说明、技术设计、测试报告和正式验收记录。后续每次实现阶段结束后，应同步更新本路线图中的“当前状态”和“未完成能力”部分。
