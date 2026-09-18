# 合同审查 Agent

本项目是一个基于 Vue 3、Vite、Pinia 和 Electron 的本地合同风险审查桌面应用。它把合同解析、事实抽取、确定性规则、通用审查清单、知识检索、可选模型分析、人工复核和受控导出串成一条可追溯流程。

## 能力范围

- 导入 DOCX 和可搜索 PDF，并保留段落、表格单元格、页码/逻辑页和字符范围。
- 抽取金额、比例、期限、主体、义务、违约金和交叉引用等合同事实。
- 执行金额一致性、付款计划、验收、时序、责任主体、违约金、责任上限、争议管辖和通用清单检查。
- 使用本地知识库、法律快照和已启用模型补充语义审查；模型不可用时保留确定性结果并记录降级原因。
- 对每条风险保留合同原文证据、条款号、`block_id`、`char_range`、引用文本和证据状态。
- 支持风险按 canonical issue 聚合，同时保留规则级兼容索引，便于审查、追踪和导出。
- JSON、XLSX、PDF 导出受草稿/正式模式、人工复核、证据定位和清单覆盖率门禁约束。

## 环境要求

- Node.js 20 或更高版本
- npm 10 或更高版本
- Windows 桌面端运行需要 Electron 依赖；模型和法律实时核验按需配置

## 安装与运行

```powershell
npm install

# 浏览器开发模式
npm run dev

# Electron 桌面开发模式
npm run dev:desktop

# 直接启动 Electron（需要已有 Vite 服务或生产构建）
npm run electron
```

常用验证命令：

```powershell
npm test
npm run build
git diff --check
```

## 目录结构

| 目录 | 内容 |
| --- | --- |
| `src/` | Vue 页面、Pinia 状态和渲染层服务 |
| `electron/` | 解析、事实抽取、规则、模型网关、检索、审查编排、校验和导出 |
| `test/` | 单元、集成、回归、模型协议和 UI 状态测试 |
| `docs/` | 需求、字段契约、技术实现、评估报告和验收记录 |
| `data/` | 本地回归合同及测试材料，不作为通用规则运行时依赖 |
| `dist/` | `npm run build` 生成的前端产物 |

## 审查链路

1. 解析器生成 `document.blocks`，每个块带 `block_id`、`char_range`、`text_hash`，表格单元格额外带 `table_ref`。
2. `contract-facts.cjs` 抽取结构化事实，并为事实绑定唯一原文证据。
3. `contract-checks.cjs` 执行确定性检查；无法定位或输入不足时输出 `unverifiable`/`missing_candidate`，不伪造确定结论。
4. `general-checklist.cjs` 执行通用审查清单，并记录适用性、扫描证据和外部材料要求。
5. 可选的 extraction/embedding/analysis 模型按执行快照调用；模型风险必须通过本地 `block_id + char_range + quote` 校验。
6. `review-engine.cjs` 分离 `risk_level` 与 `decision_confidence`，按 canonical issue 聚合风险并保留全部条款证据。
7. `validator.cjs` 在导出前校验证据、版本、覆盖率、人工复核和任务终态。

## 证据约定

风险和事实的原文定位至少应能回放到当前合同版本：

```json
{
  "block_id": "docx_block_42",
  "clause_no": "2.1",
  "char_range": [10, 22],
  "quote": "合同原文片段"
}
```

`source_refs_status`/证据状态的含义如下：

- `verified`：唯一且可回放的原文证据，可参与确定性判断。
- `ambiguous`：保留候选证据，但存在多个可能位置，不得当作已验证证据。
- `unresolved`：当前无法绑定原文，需要人工核验或补充材料。

模型只返回条款号不能直接形成已定位风险；引用无效、越界或无法回放时会记录 `MODEL_EVIDENCE_INVALID`。

## 模型与知识库

模型按 `configId` 独立保存，允许同一角色配置多个模型，不以名称覆盖已有记录。常用角色为 `extraction`、`analysis`、`embedding`、`rerank` 和 `vision`。只有已测试、已启用且符合执行快照的模型才会被审查任务使用。

知识库和法律快照支持独立导入、发布、绑定和删除；删除不会复活历史记录，也不会把草稿快照伪装成已生效法律依据。

## 导出规则

- 草稿导出可以保留待核验、待人工复核和未定位项，但必须带明确警告。
- 正式导出要求任务完成、关键检查已执行、风险证据有效、高风险已人工处理、清单覆盖率有效。
- 取消任务、模型失败、扫描 PDF 无文本层或高风险证据未解析时，正式导出会被阻断。
- 导出结果保留 `risk_level`、`decision_confidence`、`canonical_issue_id`、规则关联和原文证据。

## 文档索引

- [合同审查 Agent 字段与枚举字典](docs/合同审查Agent字段与枚举字典.md)
- [合同审查 Agent 技术实现阶段文档](docs/合同审查Agent技术实现阶段文档.md)
- [合同审查内容体系与通用审查清单](docs/合同审查内容体系与通用审查清单.md)
- [通用合同风险证据与规则准确性实施计划](docs/superpowers/plans/2026-09-18-contract-risk-evidence-and-rule-accuracy.md)
- [合同风险规则与证据回归验收记录](docs/合同风险规则与证据回归验收记录.md)
- [设备采购合同风险评估与代码加强报告](docs/设备采购合同-HLXQ-CG-2026-0917-修改后风险评估与代码加强报告.md)

## 当前验证基线

本次交付前已验证：`npm test` 通过 292 项，`npm run build` 成功，`git diff --check` 无代码空白错误。测试材料中的合同仅用于离线回归，不替代正式法律审查或人工复核。

## 安全注意事项

不要把 API Key、Bearer Token、私钥或外部绝对路径写入提交、日志、导出结果或文档。模型凭据应通过应用的本地安全存储和凭据引用配置；提交前请检查 `git diff` 和 `git status`。
