# P0 真实审查主链路设计

## 目标

在现有 Vue 3 + Electron 本地桌面端基础上完成阶段文档 P0，使真实导入的合同可以使用本地知识文件、确定性规则、已配置模型和法律快照生成审查结果。结果必须带来源文件、具体条款和原文摘录；执行失败或证据不足时只能进入待核验/降级状态，不能伪造为已通过。

## 范围

本阶段包含：

1. 确定性规则库和企业制度的 Electron 本地文件上传、校验、复制、哈希和版本记录。
2. 合同导入后的真实审查任务编排，不再使用 `sampleData.js` 为导入合同补风险。
3. 本地确定性规则执行和本地知识检索。
4. 已批准模型配置的 OpenAI 兼容接口调用、结构化输出归一化和失败降级。
5. 法律快照本地导入、哈希校验、版本状态管理和白名单实时核验。

不包含 OCR、PDF 坐标、MCP Tool、Skill 沙箱、多人权限、Word 原生修订和完整记忆召回；这些能力仍属于阶段文档中的 P1/P2。

## 架构

```text
Vue 3 / Pinia
  -> electronApi 白名单封装
  -> preload contextBridge
  -> Electron IPC
  -> 主进程服务
       ├─ knowledge.cjs       知识文件导入、解析、检索
       ├─ review-engine.cjs   规则执行、模型调用编排、风险归一化
       ├─ model-gateway.cjs   OpenAI 兼容模型调用和输出校验
       ├─ legal-source.cjs    法律快照导入和白名单实时核验
       ├─ parser.cjs          合同、制度、快照文本解析
       └─ storage.cjs         原始文件、索引和 state.json 持久化
```

所有文件系统、网络和凭据读取只在 Electron 主进程发生。Vue 只接收脱敏后的元数据、任务状态和风险结果。

## 数据契约

### 知识文件

`state.knowledge.rules` 和 `state.knowledge.policies` 的文件项增加以下字段：

```js
{
  file: "采购规则集.docx",
  kind: "rules",
  summary: "采购金额、付款和验收规则",
  version: "v1",
  selected: true,
  source_path_ref: "knowledge/rules/<version>/采购规则集.docx",
  file_version_id: "knowledge_rules_<hash前16位>",
  size: 1024,
  sha256: "sha256:...",
  parse_status: "parsed",
  clauses: [
    { clause_no: "R-001", title: "预付款比例", text: "...", keywords: ["预付款", "比例"] }
  ]
}
```

原始路径只作为本地文件引用保存，不将外部绝对路径作为渲染层可执行能力。解析失败的文件不得进入规则和检索结果。

### 法律快照

快照导入支持 JSON 和可解析文本文件。JSON 快照可携带 `id`、`name`、`status`、`coverage`、`publishedAt`、`sources`、`hash` 和 `clauses`；普通文本文件由解析器生成条款数组。导入时计算 SHA-256，并保留不可变的快照 ID 和哈希。`published` 快照才可绑定标准审查。

### 审查任务

```js
review.task = {
  task_id,
  status: "queued|running|partial|waiting_confirmation|failed|completed",
  progress: 0,
  current_step: "parse|rules|retrieve|model|validate|persist",
  checkpoint_id,
  idempotency_key,
  errors: [],
  execution: review.config.execution
}
```

审查结果风险必须至少包含现有 Validator 所需字段，并新增 `source_type`、`evidence_origin` 和依据条款信息。模型或检索只返回无法核验结果时，风险使用 `conclusion_status: "needs_verification"` 和 `evidence_status: "unverified"`。

## 执行流程

```text
合同导入
  -> 解析合同文本和页信息
  -> 读取当前审查配置快照
  -> 规则输入事实抽取和确定性规则执行
  -> 从已选规则/制度/法律快照检索依据
  -> 调用已启用 analysis/extraction 模型（可用时）
  -> 统一规则结果、检索结果和模型结果
  -> 校验风险必填字段、定位和证据
  -> 保存 review_version、task、审计记录
  -> Vue 刷新审核工作区
```

规则结果优先保留，模型不可用时仍可形成部分结果；没有证据的模型结论只能作为待核验候选。全流程任何一步失败都保留已有结果、错误码和当前步骤，不覆盖原始合同。

## 文件上传与安全

- 文件选择器只允许规则/制度配置的约定扩展名，默认单文件上限 50 MB。
- 主进程检查普通文件、大小、扩展名和 SHA-256；病毒扫描接口未接入时记录 `virus_scan: "unavailable"`，不能把它描述为已完成病毒检查。
- 文件复制到 `userData/knowledge/<kind>/<file_version_id>/`，原始文件只读保存。
- 知识文件删除只解除配置引用，不删除历史项目已经绑定的版本文件。
- 模型 API 只读取凭据引用对应的环境变量或本地凭据适配器，明文凭据不得进入 state、日志、审计和导出。
- 实时法律请求只允许访问 `settings.legalSourceAllowlist` 中的 URL；未配置白名单时不发起网络请求。

## 失败与错误码

至少提供以下机器可读错误码：

| 错误码 | 含义 | 任务处理 |
|---|---|---|
| `KNOWLEDGE_FILE_INVALID` | 知识文件类型或大小不合法 | 拒绝上传 |
| `KNOWLEDGE_PARSE_FAILED` | 知识文件无法解析 | 文件保留失败状态，不进入检索 |
| `RULE_INPUT_INSUFFICIENT` | 规则缺少必需输入 | 规则结果为无法判断 |
| `MODEL_CONFIG_INVALID` | 模型配置或凭据引用不可用 | 跳过模型，任务进入 partial |
| `MODEL_REQUEST_FAILED` | 模型超时、限流或响应异常 | 保留规则/检索结果，标记待核验 |
| `MODEL_OUTPUT_INVALID` | 模型输出不符合结构化 Schema | 丢弃无效输出，标记待核验 |
| `SNAPSHOT_NOT_FOUND` | 法律快照不存在或未发布 | 阻止标准审查或降级 |
| `SOURCE_UNAVAILABLE` | 实时法律来源不可用或无授权 | 使用离线快照并标记未实时核验 |

## 测试和验收

测试必须覆盖：

- 知识文件上传元数据、哈希、版本路径和非法文件拒绝。
- 制度/规则条款解析和关键词检索，结果包含文件名、条款号、标题和原文。
- 规则命中、未命中、无法判断三类输出。
- 模型结构化 JSON 成功、异常 JSON、超时和无凭据降级。
- 法律快照导入、哈希校验、未发布阻断和白名单实时核验失败降级。
- 真实合同导入后风险来自规则/检索/模型执行，不来自 `sampleData.js`。
- 执行失败仍保存任务错误和已有结果，Validator 能阻止无证据结果导出。

验收条件是：至少使用一份真实可解析合同和一份本地规则/制度文件完成端到端执行；风险详情显示具体依据条款和原文；模型或法律来源不可用时界面明确显示待核验/部分完成。
