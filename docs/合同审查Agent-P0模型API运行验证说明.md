# 合同审查 Agent P0 模型/API 运行验证说明

## 1. 文档目的

本文档结合本地 `docs/key.md` 中记录的模型服务，指导验证 P0 中必须配置模型/API 才能确认的真实调用链路。

验证主链路：

```text
DeepSeek analysis 模型配置
  -> 能力配置页面保存 Key 引用和明文 Key
  -> 主进程通过 Electron safeStorage 加密保存
  -> 主进程按凭据引用解密
  -> 调用 OpenAI 兼容 /chat/completions
  -> 获取结构化 JSON
  -> 归一化为候选风险
  -> 合并规则和知识依据
  -> 保存审查任务与模型调用摘要
  -> 人工复核
  -> Validator 导出门禁
```

本文档不会复制或展示 `key.md` 中的任何明文密钥。验证人员只在 Electron 的“能力配置”页面临时填写 Key；保存后 Key 进入本机加密凭据文件，业务状态和 Git 不保存明文。

## 2. 当前代码边界

### 2.1 本次可以验证

- DeepSeek 对话模型作为 `analysis` 角色进入审查执行快照。
- Electron 主进程真实请求 DeepSeek Chat Completions 接口。
- 请求要求模型返回 JSON 对象。
- 模型风险进入统一风险 Schema，并与规则、制度依据合并。
- 模型调用记录包含耗时、usage、错误码和有限重试结果。
- 缺少凭据、HTTP 错误、超时或非法 JSON 时安全降级。
- 模型生成的高风险受人工复核和 Validator 门禁限制。
- 明文密钥不进入状态文件、审计记录和导出结果。

### 2.2 本次不能宣称完成

`key.md` 同时记录了 `qwen3-vl-embedding` 向量模型，但当前 P0 代码尚未实现 Embeddings API 调用：

- `electron/model-gateway.cjs` 当前只实现 `/chat/completions`。
- `electron/review-runner.cjs` 当前只调用 `analysis` 模型。
- 规则库、企业制度和法律快照目前使用本地关键词重叠检索。
- `embedding` 模型可以在能力配置和执行快照中展示，但不会参与当前真实检索。

因此本次只能验证向量模型配置是否被保存和显示，不能把“配置成功”作为“向量检索 API 已接入”的证据。真实向量化、向量索引、Top-K 召回、重排和 Embeddings API 失败降级属于后续阶段。

## 3. 安全准备

### 3.1 项目目录

```powershell
Set-Location 'D:\项目\CheckMCP\Doc\合同审批'
```

### 3.2 密钥使用原则

- `docs/key.md` 只作为当前本地验证凭据来源。
- 只在 Electron“能力配置 -> 新增模型/编辑模型”弹窗中填写 Key；不要写入源码、状态 JSON 或命令行参数。
- 不把密钥写入 `package.json`、源码、测试、运行说明或 Git 提交。
- 不在截图中显示设置密钥的 PowerShell 命令历史。
- 编辑已配置模型时不要截图或复制 Key；Key 输入框为空表示沿用本机已有 Key。

建议后续将 `key.md` 的明文密钥迁移到操作系统凭据管理器，并轮换已经以明文文件保存过的密钥。

### 3.3 凭据引用和本机加密存储

DeepSeek 建议使用以下凭据引用：

```text
cred://deepseek/analysis
```

在“能力配置”中，`Key 引用名` 用来区分多组 Key：

```text
cred://deepseek/analysis -> DeepSeek 分析模型
cred://aliyun/embedding -> 阿里云向量模型
```

保存模型时，Key 通过白名单 IPC 发送到 Electron 主进程，由 `safeStorage.encryptString()` 加密后写入 Electron `userData/state/credentials.json`。文件中只有加密后的 Base64 字符串，不是可直接使用的明文 Key。审查或对话调用时，主进程按引用解密并注入请求头，渲染层不会获得 Key。

同一引用可绑定多个模型；需要使用不同服务商或不同账号时，为每个 Key 使用不同引用。编辑模型时输入框不会回显旧 Key，留空保存表示继续使用原 Key，重新填写则覆盖对应引用。

## 4. 启动前验证

```powershell
npm test
npm run build
```

验收标准：

- 自动化测试全部通过，`fail` 为 `0`。
- Vite 生产构建成功。
- `dist/index.html` 和 `dist/assets/` 已更新。

### 4.1 开发模式启动 Electron 桌面端

在项目目录执行：

```powershell
npm.cmd run dev:desktop
```

该命令会自动启动 Vite `127.0.0.1:5173`，再启动 Electron 桌面窗口。验证时应操作 Electron 窗口，不要直接打开浏览器预览地址或 `dist/index.html`。

如果窗口没有自动出现，可检查任务栏中标题为 `contract-review-agent-desktop` 的窗口。启动器会自动清除 `ELECTRON_RUN_AS_NODE`，并添加无 GPU 兼容参数。

预期：Electron 窗口自动打开，不出现以下错误：

```text
Cannot read properties of undefined (reading 'whenReady')
An object could not be cloned
```

### 4.2 5173 端口已经被占用时

`vite.config.js` 使用严格端口模式，若 `5173` 已被其他 Vite 服务占用，`npm.cmd run dev:desktop` 会因为端口冲突退出。此时使用两个 PowerShell 窗口手动启动备用端口：

窗口一：

```powershell
Set-Location 'D:\项目\CheckMCP\Doc\合同审批'
npm.cmd run dev -- --host 127.0.0.1 --port 5174
```

窗口二：

```powershell
Set-Location 'D:\项目\CheckMCP\Doc\合同审批'
$env:VITE_DEV_SERVER_URL = 'http://127.0.0.1:5174'
node scripts/launch-electron.cjs .
```

关闭开发服务时，只结束本次启动的 Vite 和 Electron 进程，不要误结束其他项目正在使用的端口。

### 4.3 使用生产构建启动 Electron

不需要 Vite 开发服务时，先构建再启动桌面端：

```powershell
Set-Location 'D:\项目\CheckMCP\Doc\合同审批'
npm.cmd run build
npm.cmd run electron
```

此模式会加载 `dist/index.html`，仍然保留 Electron 的本地文件选择器、模型 Key 加密存储、审查执行和 Validator 导出能力。

## 5. DeepSeek Analysis 配置

进入“能力配置”，点击“新增模型”，按下表填写：

| 字段 | 建议值 | 说明 |
|---|---|---|
| 配置名称 | `deepseek-analysis` | 用于工作区和审计识别 |
| 模型标识 | `deepseek-chat` | DeepSeek 对话模型标识 |
| 服务商 | `DeepSeek` | 展示字段 |
| API 地址 | `https://api.deepseek.com` | 来自 `key.md`；系统会补齐 `/chat/completions` |
| 模型角色 | `analysis` | P0 真实调用只使用该角色 |
| 配置版本 | `deepseek-cfg-v1` | 用于执行快照 |
| 上下文长度 | 按当前服务能力填写 | 当前用于配置记录 |
| 最大输出 Token | 例如 `4096` | 当前网关尚未发送该字段 |
| 超时 | `60000` | 单位毫秒，外部服务建议不低于 30 秒 |
| 重试次数 | `1` | 避免验证期间重复消耗过多 Token |
| 数据策略 | `approved_external` | 合同内容会发送到外部模型时应明确标记 |
| Key 引用名 | `cred://deepseek/analysis` | 用于区分多组 Key；同一引用可绑定多个模型 |
| API Key | 从本地安全来源复制到页面输入框 | 页面中可见，保存后不回显；不要写入本文档 |

保存后执行：

1. 点击“校验配置”。
2. 确认页面显示“配置已校验”。
3. 点击启用按钮，使状态变为“运行中”。

注意：“校验配置”会检查模型标识、API 地址和本机 Key 是否已配置，但不会向 DeepSeek 发送请求。只有导入合同并执行审查，才能验证真实连通性。

## 6. Qwen 向量模型配置说明

`key.md` 中的 `qwen3-vl-embedding` 可按以下方式登记，用于验证配置承载和执行快照展示：

| 字段 | 建议值 |
|---|---|
| 配置名称 | `qwen3-vl-embedding` |
| 模型标识 | `qwen3-vl-embedding` |
| 服务商 | `阿里云百炼` |
| API 地址 | `https://ws-ppprfnb8819dlxt6.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |
| 模型角色 | `embedding` |
| 配置版本 | `qwen-embedding-cfg-v1` |
| 数据策略 | `approved_external` |
| Key 引用名 | `cred://aliyun/qwen3-vl-embedding` |
| API Key | 在页面中填写对应向量模型 Key | 保存后只显示“本机已配置” |

本阶段不需要调用向量端点来验证 P0 主链路，因为当前代码不会调用向量端点。保存并启用后只检查：

- 能力配置列表中角色显示为“向量化”。
- 审核工作区执行配置中可以显示该向量模型。
- 审查日志中不应虚假出现 Embeddings API 已调用或向量召回已完成。

如果需要验证真实向量 API，必须先实现独立的 Embeddings 网关和向量检索链路，不能复用当前 `/chat/completions` 网关冒充。

## 7. 准备模型审查样例

### 7.1 合同样例

使用可解析的 DOCX 或可搜索 PDF，内容至少包含：

```text
第四条 付款
合同总价为 100 万元。合同签订后五个工作日内，甲方向乙方支付合同总价的 40% 作为预付款。
```

### 7.2 企业制度样例

在“知识库与规则 -> 企业制度”上传并勾选：

```text
第 4.2 节 预付款
预付款比例不得超过合同金额的 30%；超过 30% 时应完成专项审批并取得履约保障。
```

### 7.3 法律快照

绑定一个状态为 `published` 的法律快照。快照应至少包含条款编号、标题和原文。这样可以同时验证模型风险、企业制度依据和 Validator 的法律快照约束。

## 8. 执行真实审查

1. 回到“工作台”。
2. 点击“新建审查”。
3. 填写项目名称并选择合同类型。
4. 上传准备好的合同。
5. 提交审查并进入审核工作区。
6. 查看顶部“本次审查执行配置”。

执行配置必须显示：

- 语义分析：`deepseek-analysis`。
- 模型标识：`deepseek-chat` 或对应配置标识。
- 当前启用的规则和制度配置。
- 如已登记向量模型，可以显示 `qwen3-vl-embedding`，但这不代表已调用。

任务步骤应依次经过：

```text
执行确定性规则
  -> 检索知识依据
  -> 调用审查模型
  -> 校验审查结果
  -> 保存审查版本
```

## 9. DeepSeek 请求检查

当前模型网关实际发送：

```http
POST https://api.deepseek.com/chat/completions
Content-Type: application/json
Accept: application/json
Authorization: Bearer <从凭据引用解析，不写入状态>
```

请求体的核心字段：

```json
{
  "model": "deepseek-chat",
  "messages": [
    {
      "role": "system",
      "content": "要求只返回包含 risks 的 JSON 对象，并对无依据结论使用待核验状态"
    },
    {
      "role": "user",
      "content": "合同类型、合同文本和已检索依据的结构化内容"
    }
  ],
  "temperature": 0.1,
  "response_format": {
    "type": "json_object"
  }
}
```

当前 P0 会将合同解析文本和已检索证据发送给外部模型。验证真实业务合同前，必须确认组织的数据出域政策允许使用 DeepSeek，并优先使用脱敏测试合同。

## 10. 成功结果验收

### 10.1 任务状态

模型调用成功后，检查：

- 任务经过“调用审查模型”步骤。
- 模型错误列表中没有 `MODEL_CONFIG_INVALID`、`MODEL_REQUEST_FAILED` 或 `MODEL_OUTPUT_INVALID`。
- 任务最终为 `completed`、`waiting_confirmation`，或因待人工处理进入符合当前状态机的状态。
- 任务没有因为模型返回空数组就显示误导性的“合同已通过”。

### 10.2 风险结构

模型输出必须归一化为当前风险结构。至少检查：

- `source_type=model_analysis`，或界面显示等价来源。
- `risk_level` 属于允许枚举。
- `risk_category`、标题、分析和修改建议存在。
- `conclusion_status` 不会因为模型声称确定而绕过人工确认。
- `human_status=pending_review`。
- 合同定位包含当前文件版本、页码和原文片段。

### 10.3 依据显示

打开风险详情气泡，依据不能只显示文件名。每条依据至少需要显示：

- 依据文件名。
- 具体条款编号或标题。
- 条款原文摘录。
- 法律依据绑定的法律快照版本。

模型没有给出可核验定位或依据时，风险必须保持 `needs_verification` 或 `unverified`。

### 10.4 模型调用摘要

当前模型网关返回并供审查任务记录：

- `latencyMs`。
- `usage`。
- `errorCode`。
- 重试后的最终结果。

不得记录 DeepSeek KEY、完整 `Authorization` 请求头或本机凭据文件内容。

## 11. 失败降级验证

### 11.1 缺少 DeepSeek 凭据

1. 关闭 Electron。
2. 在“能力配置”中编辑 `deepseek-analysis`，将 Key 引用改为一个从未保存过的引用，或使用新引用但不填写 API Key。
3. 重新启动并执行审查。

预期：

- 返回 `MODEL_CONFIG_INVALID`。
- 提示模型凭据引用不可用。
- 已有规则和知识检索结果仍保留。
- 不生成模型已确认结论。

### 11.2 DeepSeek KEY 无效

在“能力配置”中为 DeepSeek 引用重新保存一个专门的无效测试值，再执行审查；验证完成后应立即覆盖或删除该凭据文件中的对应引用。

预期：

- DeepSeek 返回 401 或 403。
- 系统归一化为 `MODEL_REQUEST_FAILED`。
- 页面和审计记录不显示请求头或无效测试值。
- 已有规则结果不丢失。

### 11.3 非法 JSON

DeepSeek 正常情况下应遵循 JSON 输出要求。若兼容代理或测试服务返回非 JSON，预期：

- 返回 `MODEL_OUTPUT_INVALID`。
- 该输出不能生成已确认风险。
- 任务保留已有部分结果并显示可重试状态。

### 11.4 超时或网络不可用

将 API 地址临时改为不可达测试地址，或把超时时间设置为较短值后执行审查。

预期：

- 请求在超时后终止。
- 按配置执行有限重试。
- 返回 `MODEL_REQUEST_FAILED`。
- 任务为 `partial` 或 `failed`，已有规则/检索结果仍保留。

验证完成后恢复正确 DeepSeek 地址，避免错误配置留在工作区。

## 12. Validator 联动

1. 保留 DeepSeek 生成的高风险，且不做人工处理。
2. 点击导出并运行 Validator。
3. 确认高风险 `pending_review` 被阻断。
4. 确认缺少定位或依据的模型风险被阻断。
5. 对风险执行人工接受、误报、修改、延期或删除。
6. 补足合法证据和定位后重新运行 Validator。

通过标准：

- 模型输出只能形成候选或待核验结果。
- 未人工复核的高风险不能导出。
- 无证据、无原文定位或证据无效的风险不能导出。
- Validator 通过后才允许生成 DOCX、PDF、XLSX 或 JSON 报告。
- 导出报告中不包含任何模型密钥。

## 13. 验收记录模板

```text
验证日期：
代码提交：
测试合同：仅记录脱敏文件名
合同文件版本：
法律快照版本：
企业制度版本：

Analysis 配置名称：deepseek-analysis
模型标识：deepseek-chat
配置版本：deepseek-cfg-v1
API 地址：https://api.deepseek.com
凭据引用：cred://deepseek/analysis
本机凭据存储：已配置 / 未配置（禁止记录 Key）

向量模型配置：已登记 / 未登记
向量 API 实际调用：未实现，不作为 P0 通过项

审查任务 ID：
最终任务状态：
模型调用状态：
模型错误码：
模型调用耗时：
usage：
模型风险数量：
规则风险数量：
依据是否包含文件名、条款和原文：
高风险人工处理状态：
Validator 首次结果：
Validator 复核后结果：
导出记录：
```

## 14. 专项验收清单

| 编号 | 验证项 | 通过标准 | 结果 |
|---|---|---|---|
| DS-01 | DeepSeek 配置保存 | 地址、模型标识、角色和版本保存成功 | [ ] |
| DS-02 | Key 配置保存 | 页面保存 `cred://deepseek/analysis` 和对应 Key，模型对象只保留引用名 | [ ] |
| DS-03 | 本机凭据解析 | 主进程能按引用从 Electron 加密凭据文件取到 Key 并发起请求 | [ ] |
| DS-04 | 执行快照 | 工作区显示 `deepseek-analysis` | [ ] |
| DS-05 | 真实 API 调用 | 请求到达 DeepSeek `/chat/completions` | [ ] |
| DS-06 | JSON 输出 | 响应可解析为 `{ risks: [...] }` | [ ] |
| DS-07 | usage/耗时 | 调用摘要包含 usage 和 latency | [ ] |
| DS-08 | 风险归一化 | 模型结果进入统一风险 Schema | [ ] |
| DS-09 | 具体依据 | 依据显示文件名、条款和原文 | [ ] |
| DS-10 | 无凭据降级 | 返回 `MODEL_CONFIG_INVALID` 且保留规则结果 | [ ] |
| DS-11 | 请求失败降级 | 返回脱敏错误且不生成确认结论 | [ ] |
| DS-12 | Validator 门禁 | 未复核高风险和无效依据被阻断 | [ ] |
| DS-13 | 凭据泄漏检查 | 状态、日志、审计、导出均无明文密钥 | [ ] |
| VEC-01 | 向量配置展示 | `qwen3-vl-embedding` 可保存并显示 | [ ] |
| VEC-02 | 向量能力边界 | 验收记录明确“API 调用未实现” | [ ] |

## 15. 验收结论规则

只有同时满足以下条件，才能判定 P0 模型/API 主链路通过：

1. `deepseek-analysis` 以 `analysis` 角色进入当前审查执行快照。
2. Electron 主进程使用凭据引用成功请求 DeepSeek。
3. DeepSeek 返回的结构化风险被正确归一化和展示。
4. 风险依据能够追溯到文件名、具体条款和原文。
5. 模型失败时系统保留部分结果并进入明确降级状态。
6. 模型风险不能绕过人工复核和 Validator。
7. 密钥未进入状态、日志、审计、导出和 Git。

`qwen3-vl-embedding` 配置展示成功不属于上述通过条件。只有后续实现并验证 Embeddings API、向量索引和召回后，才能声明向量检索链路完成。
