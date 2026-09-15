---
name: contract-term-review-revise
version: 1.1.0
description: 代表合同中明确指定的一方，先逐条识别不利条款并做可追溯的修订，再对修订稿进行一轮内部交叉矛盾核查，输出带风险批注的修订文档与独立的冲突审查报告。适用场景：用户说「站在我方立场改合同」「规避风险、保障权益」或「看看这份改过的合同有没有自相矛盾」。
display_name: "合同条款审查与修订"
display_name_en: "Contract Term Review and Revision"
description_zh: "站在指定一方立场修订不利条款，再做交叉矛盾核查并输出修订稿。"
description_en: "Revise adverse contract terms for a named party, then cross-check the draft for internal conflicts."
agent_created: true
visibility: "public"
---

# 合同条款审查与修订

> **一句话**：站在合同里**明确指定的一方**，先把对自己不利的条款逐条改掉（可追溯），再把改完的稿子**独立**过一遍，专找条款之间自相矛盾的地方。
>
> 本文件是**自包含单文件技能包**：工作流、检查清单、修订手法、冲突检出启发式、输出模板、自检清单全部内置，无外部依赖。

---

## 0. 交付物清单

| 交付物 | 内容 | 何时产出 | 默认格式 |
|---|---|---|---|
| **A. 修订稿** | 重大风险提示 + 修改要点汇总表 + 修订后合同正文（改动标黑/批注）+ 核心条款对照表 | 阶段 C | HTML（用户指定路径） |
| **B. 冲突审查报告** | 矛盾 / 逻辑不一致 / 笔误三类问题清单 + 逐条修改建议 + 统计结论 | 阶段 D | HTML（用户指定路径） |
| **C. 立场声明**（可并入 A 首部） | 我方是哪一方、审查范围（只改 / 只查 / 都做） | 阶段 A | 文字 |

> 输出一律落到**用户指定的位置**，不绑定任何个人本地目录。用户未指定时，默认与合同原文同目录，文件名加 `-修订稿` / `-冲突审查报告` 后缀。

---

## 1. 能做什么

本 skill 交付一条「**先改、再查**」的两段式合同处理链路：

1. **第一段（改）**：以明确指定的一方为锚点，逐条挑出对己方不利的条款并改写。
2. **第二段（查）**：把改完的稿子再过一遍，专找条款之间互相打架、逻辑不顺、文字写错的地方。

任何合同文本都适用（代加工、采购、服务、合作、租赁、劳动等）。**具体合同类型只是填充场景，不是流程约束。**

## 2. 什么时候用

- 用户丢来一份合同，要求「按有利于我方（乙方/甲方/某方）的方向修改，把风险降下来、把权益保住」。
- 用户要求「检查这份合同有没有自相矛盾、前后冲突」。
- 用户把**已经改过或定稿**的合同再发回来，想再核一遍内部一致性。

## 3. 什么时候不要用

- 用户只想要**合同内容摘要**或**要素提取**（不是修改/核查诉求）→ 用普通摘要能力，不要套本流程。
- 用户要求**起草一份全新合同**（无底稿）→ 属于起草任务，本 skill 的两段式流程不适用。
- 用户要求**判断合同是否合法有效 / 出具法律意见**→ 本 skill 只做条款层面的风险与一致性处理，须提示其咨询执业律师。

---

## 4. 工作流总览

```
阶段 A 锁定立场与范围
        ↓
阶段 B 通读找风险（六维度扫描 → 风险点清单）
        ↓
阶段 C 逐条改写 → 交付【修订稿 A】
        ↓
阶段 D 对修订稿做冲突核查 → 交付【冲突审查报告 B】
```

**阶段 C 与 D 必须分开做、分开交付。** D 不重复 A/B/C 的风险识别，只回答一个问题：*改完之后这份稿子自己跟自己对不对得上？*

---

## 5. 阶段 A：锁定立场与范围

**先问清两件事，问不清就动手等于白干：**

| 必问项 | 说明 | 缺省处理 |
|---|---|---|
| **① 我方是哪一方？** | 甲方 / 乙方 / 委托方 / 受托方 / 出租方 / 承租方…… | 原文若已明显标注我方身份，可直接确认后继续 |
| **② 要做什么？** | 只改条款 / 只查冲突 / 两样都做 | 默认「两样都做」，先改后查 |

**产出**：一句话立场声明，写在所有输出物的首部，例如：

> 本文以**乙方（受托加工方）**为立场进行审查与修订，所有「有利/不利」判断均相对乙方作出。

> ⚠️ **全程禁用中立视角。** 同一条款对甲方有利即对乙方不利，「公平」不是判断标准，「对己方是否有利」才是。仅当己方明显占优、对方条款显失公平到可能被认定无效时，才回到「对等」作为底线。

---

## 6. 阶段 B：通读找风险（六维度扫描）

把合同从头到尾读一遍，站在指定方立场，标记出「对自己不利、义务被转嫁、责任被加重、保护缺失」的条款。

### 6.1 六维度检查清单

| # | 维度 | 典型症状 | 判断标准（触发即记为风险） | 处置方向 |
|---|---|---|---|---|
| 1 | **费用与罚则** | 违约金日万分之三、年化超标；多项罚则叠加；罚则无累计上限 | 单日比例 > 万分之三 / 年化 > 24% / 多条罚则针对同一违约行为叠加 / 无总额封顶 | 删叠加、降比例、设累计上限 |
| 2 | **管辖与争议** | 管辖法院或仲裁地在对方所在地 | 争议解决地非己方所在地 | 争取改回己方所在地法院，或中立地仲裁 |
| 3 | **义务单方转嫁** | 对方把本应自己承担的合规/审核/证照义务推给己方；保证金收取与退还条件苛刻 | 义务的实施主体与受益主体错位；退还条件含主观判断口径 | 义务回位；退还条件去主观化（改为「无违规即退」） |
| 4 | **责任与赔偿** | 主宾语写反（如「乙方向乙方支付」，本应「甲方向乙方支付」）；赔偿范围无上限、含间接损失 | 款项流向与责任主体不符；赔偿未封顶 | 修正主客体；赔偿上限设为合同金额或已付金额，并排除间接损失 |
| 5 | **保护性条款缺失** | 无保密义务；无对方证照/资质持续有效的保证；己方无单方解约权；无合作结束后物料/资料返还义务 | 己方核心风险敞口无对应条款承接 | 逐项新增条款补缺 |
| 6 | **质量与验收** | 不合格率、损耗率标准不明；检测费用由己方全担；验收期过短 | 标准主观不可量化；费用与责任不匹配；验收期不足以完成检验 | 量化标准、费用按责分担、延长验收期 |

### 6.2 输出格式

对**每一处**风险，记一条三元组：

```
[风险点] 条款号 + 原文摘录（≤50字）
[危害]   对己方会造成什么具体后果（钱 / 责任 / 程序）
[怎么改] 一句话给出修改方向（阶段 C 落地为具体文本）
```

> 宁多勿漏：拿不准是否构成风险的，先记下并标注「存疑」，阶段 C 再判断是否动手。

---

## 7. 阶段 C：逐条改写并出修订稿

### 7.1 八类修订手法库

| 手法 | 适用维度 | 具体动作 |
|---|---|---|
| **降罚则** | 费用与罚则 | 比例下调 + 增设累计上限 + 删除针对同一行为的叠加罚则 |
| **争管辖** | 管辖与争议 | 改为己方所在地人民法院管辖；或改为中立仲裁机构 |
| **义务回位** | 义务转嫁 | 把对方义务的动词主语改回对方，删除「由乙方负责审核甲方资质」类错位表述 |
| **封顶化** | 责任与赔偿 | 赔偿条款加「以合同总金额为限，且不含间接损失、可得利益损失」 |
| **补缺** | 保护缺失 | 新增保密、资质持续有效保证、己方单方解约权、资料返还、不可抗力、通知送达 |
| **对等化** | 全部 | 使双方义务、违约责任、解约条件对称（仅当己方当前处于弱势时使用） |
| **去主观化** | 费用 / 验收 / 保证金 | 把「考核合格后」「双方另行商定」改成客观标准或明确期限 |
| **修笔误** | 责任与赔偿 | 修正主客体倒置、错别字（如「有」应为「由」） |

### 7.2 标注规范（不可省）

- **改动处**：标黑 / 加粗（保留原文删除线可选）。
- **重大风险处**：挂批注框，写明「原文风险 → 修改理由」。
- **新增条款**：显式标注「【新增】」。
- **删除条款**：显式标注「【删除】」，不得静默消失。

### 7.3 修订稿（交付物 A）四块结构

1. **重大风险提示** —— 每条风险对应一条修改措施。
2. **修改要点汇总表** —— 条款号 / 风险类型 / 修改要点 / 严重度。
3. **修订后的合同正文** —— 改动处标黑，风险处批注。
4. **核心条款修改对照表** —— 原条款 vs 修订后条款，逐条左右对照。

> 第 4 块是「可追溯」的落点：**每处改动都要让用户一眼看出改了什么、为什么改。** 没有对照表 = 交付不合格。

---

## 8. 阶段 D：对修订稿做冲突核查

对改完的稿子（或用户新提供的版本）再做一遍，专门找三类毛病。

### 8.1 三类问题与检出启发式

| 类别 | 定义 | 典型形态 | **检出启发式（怎么找）** |
|---|---|---|---|
| **① 互相矛盾** | 不同条款对**同一件事**给了冲突规则 | 违约金上限被后文追加罚则顶破；同一段前后两句责任方打架；同一事项（物料处置、解约权）散落多个条款但规则不一致 | 把全部**金额/比例**抽出来做数学核对：单项上限 vs 累计上限 vs 合同总额，看是否互相顶破 |
| **② 逻辑不一致** | 规则本身能自洽，但整体逻辑错位 | 时间单位混用（工作日 vs 自然日）；角色错位（照抄对方模板导致甲乙颠倒）；违约金双方不对等（显失公平） | 把全部**时间**抽出、统一换算为自然日比较；把全部**责任主体**抽出、按同一义务横向核对 |
| **③ 文字笔误** | 字面错误，但**影响法律后果** | 主宾语写反（影响款项流向）；错别字（「有」应为「由」） | 逐条检查**款项流向**与**义务主体**的动词主客；对照「有/由」「甲方/乙方」等高频错字 |

**补充核对项**：把全部**程序性事项**（解约、返还、验收、通知送达）抽出，核对不同条款下的程序是否一致。

### 8.2 冲突审查报告（交付物 B）结构

1. **统计仪表盘** —— N 处矛盾 / M 处逻辑不一致 / K 处文字笔误。
2. **分类清单** —— 每项含：位置（条款号）× 问题描述 × 证据（条款 A 原文 ↔ 条款 B 原文）× 修改建议 × 严重度。
3. **结论与优先处置建议**。

**严重度分级**：

| 等级 | 判据 |
|---|---|
| 🔴 **致命** | 影响款项流向、责任归属、合同效力 |
| 🟠 **重要** | 影响程序、期限、权利义务范围 |
| 🟡 **轻微** | 不影响法律后果的文字瑕疵 |

> 统计口径固定为三项：**矛盾数 / 逻辑不一致数 / 文字笔误数**，末行给出合计。不得含糊表述为「存在若干问题」。

---

## 9. 操作要点

- **立场先行**：先确认用户是哪一方，所有判断都相对这一方做，别用中立视角。
- **改动可追溯**：每处改动都要配对照表，让用户看出「改了什么、为什么改」。
- **二次审查独立**：冲突核查是「改完之后是否自洽」的独立一遍，不重复第一遍的风险识别，聚焦条款之间的交叉矛盾。
- **明示而非静默**：删掉或新增的条款要显式说明，别让用户以为原文本来就是那样。
- **示例不锁死**：正文里的具体合同类型（如化妆品 OEM/ODM 代加工）、具体违约比例、具体条款号都只是示例，换合同类型时替换即可，不构成流程约束。
- **原文为准**：引用条款必须逐字摘录原文，不得改写后当作原文引用；条款号以原文件为准，原文无编号时自行编号并说明。

---

## 10. 质量自检清单（交付前逐条过）

- [ ] 立场声明已写在输出首部，且全文判断口径一致。
- [ ] 六维度扫描全部走过一遍，存疑项已给出结论。
- [ ] 每个风险点都有「风险 + 危害 + 怎么改」三元组，无孤立结论。
- [ ] 修订稿四块结构齐全，**对照表存在**。
- [ ] 所有改动均有醒目标注；新增标「【新增】」、删除标「【删除】」。
- [ ] 冲突核查三类问题均给出**具体证据（原文摘录）**，不是空泛描述。
- [ ] 报告末尾给出 N/M/K 三项统计与合计。
- [ ] 已提示：本输出为商务条款处理建议，不构成法律意见。

---

## 附录 A：修订稿 HTML 模板

> 打印友好（浅色纸面），A4 纵向。改动处 `.chg` 标黑加粗，风险批注 `.note`。

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>合同修订稿（我方立场）</title>
<style>
  :root{--ink:#1a1a1a;--sub:#666;--line:#ddd;--risk:#c0392b;--paper:#fff;}
  *{box-sizing:border-box;}
  body{margin:0;padding:48px 56px;background:#f5f5f3;color:var(--ink);
       font-family:"Source Han Serif SC","Songti SC",serif;line-height:1.9;font-size:15px;}
  .wrap{max-width:820px;margin:0 auto;background:var(--paper);padding:56px 60px;
        box-shadow:0 2px 18px rgba(0,0,0,.08);}
  h1{font-size:24px;text-align:center;letter-spacing:2px;margin:0 0 6px;}
  .stance{text-align:center;color:var(--sub);font-size:13px;border-bottom:1px solid var(--line);
          padding-bottom:18px;margin-bottom:32px;}
  h2{font-size:17px;border-left:3px solid var(--ink);padding-left:10px;margin:36px 0 14px;}
  table{width:100%;border-collapse:collapse;font-size:13.5px;margin:12px 0;}
  th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top;}
  th{background:#fafafa;font-weight:600;}
  .chg{font-weight:700;}
  .del{color:var(--sub);text-decoration:line-through;}
  .note{border-left:3px solid var(--risk);background:#fdf5f4;padding:8px 12px;margin:10px 0;
        font-size:13px;font-family:system-ui,sans-serif;color:#7a241b;}
  .note b{color:var(--risk);}
  .tag{display:inline-block;font-size:11px;padding:1px 6px;border-radius:3px;
       background:#eee;color:#444;margin-left:6px;font-family:system-ui,sans-serif;}
  .art{font-family:system-ui,"PingFang SC",sans-serif;font-size:14px;}
  .art p{margin:10px 0;text-indent:2em;}
  .art h3{font-size:15px;margin:22px 0 8px;}
  .sev{font-family:system-ui,sans-serif;font-size:12px;font-weight:600;}
  .s1{color:#c0392b;}.s2{color:#d68910;}.s3{color:#7f8c8d;}
</style>
</head>
<body>
<div class="wrap">

  <h1>××合同（修订稿）</h1>
  <div class="stance">本文以【乙方】为立场修订　|　修订日期：YYYY-MM-DD</div>

  <h2>一、重大风险提示</h2>
  <!-- 每条风险对应一条修改措施 -->
  <table>
    <tr><th style="width:14%">条款</th><th style="width:22%">原文风险</th>
        <th style="width:44%">修改措施</th><th style="width:10%">严重度</th></tr>
    <tr><td>第 6.2 条</td><td>违约金日万分之五，且与第 9.1 条叠加</td>
        <td>下调至日万分之二，删除与第 9.1 条的叠加适用，增设累计上限为合同总金额 10%</td>
        <td class="sev s1">致命</td></tr>
  </table>

  <h2>二、修改要点汇总表</h2>
  <table>
    <tr><th style="width:14%">条款号</th><th style="width:18%">风险类型</th>
        <th style="width:56%">修改要点</th><th style="width:12%">严重度</th></tr>
    <tr><td>第 6.2 条</td><td>费用与罚则</td><td>降低违约金比例并封顶</td>
        <td class="sev s1">致命</td></tr>
  </table>

  <h2>三、修订后的合同正文</h2>
  <div class="art">
    <h3>第 6 条　违约责任</h3>
    <p>6.2　乙方逾期交付的，每逾期一日按<span class="del">合同总金额的万分之五</span>
       <span class="chg">合同总金额的万分之二</span>向甲方支付违约金，
       <span class="chg">累计不超过合同总金额的 10%，且不再适用第 9.1 条项下罚则</span>。</p>
    <div class="note"><b>批注：</b>原比例（年化约 18.25%）叠加第 9.1 条后实际罚则无上限，
      对乙方风险敞口不可控；修改后单倍封顶，风险可测算。</div>

    <p><span class="tag">【新增】</span>6.4　甲方应在收到乙方交付成果后
       <span class="chg">15 个自然日</span>内完成验收，
       逾期未提出书面异议的视为验收合格。</p>
    <div class="note"><b>批注（新增）：</b>原合同无验收期限，甲方可无限拖延并据此拒付，
      新增验收期与默示验收规则。</div>
  </div>

  <h2>四、核心条款修改对照表</h2>
  <table>
    <tr><th style="width:14%">条款</th><th style="width:43%">原条款</th><th style="width:43%">修订后条款</th></tr>
    <tr><td>6.2</td>
        <td>每逾期一日按合同总金额的万分之五支付违约金。</td>
        <td>每逾期一日按合同总金额的万分之二支付违约金，累计不超过合同总金额的 10%，且不再适用第 9.1 条项下罚则。</td></tr>
  </table>

</div>
</body>
</html>
```

---

## 附录 B：冲突审查报告 HTML 模板

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>合同内部冲突审查报告</title>
<style>
  :root{--ink:#1a1a1a;--sub:#666;--line:#e2e2e2;--red:#c0392b;--amber:#d68910;--grey:#7f8c8d;}
  *{box-sizing:border-box;}
  body{margin:0;padding:48px 56px;background:#f5f5f3;color:var(--ink);
       font-family:system-ui,"PingFang SC",sans-serif;line-height:1.8;font-size:14.5px;}
  .wrap{max-width:860px;margin:0 auto;background:#fff;padding:52px 56px;
        box-shadow:0 2px 18px rgba(0,0,0,.08);}
  h1{font-size:22px;margin:0 0 6px;}
  .meta{color:var(--sub);font-size:13px;border-bottom:1px solid var(--line);
        padding-bottom:16px;margin-bottom:28px;}
  h2{font-size:16px;margin:34px 0 12px;padding-left:10px;border-left:3px solid var(--ink);}
  .kpi{display:flex;gap:14px;margin:18px 0 8px;flex-wrap:wrap;}
  .kpi div{flex:1;min-width:140px;border:1px solid var(--line);border-radius:8px;
           padding:14px 16px;text-align:center;}
  .kpi b{display:block;font-size:26px;line-height:1.3;}
  .k1 b{color:var(--red);}.k2 b{color:var(--amber);}.k3 b{color:var(--grey);}
  .kpi span{font-size:12.5px;color:var(--sub);}
  .item{border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:12px 0;}
  .item .hd{display:flex;justify-content:space-between;align-items:baseline;gap:12px;
            font-weight:600;margin-bottom:6px;}
  .sev{font-size:11.5px;font-weight:700;padding:2px 8px;border-radius:10px;white-space:nowrap;}
  .s1{background:#fdecea;color:var(--red);}
  .s2{background:#fef5e7;color:var(--amber);}
  .s3{background:#f0f2f3;color:var(--grey);}
  .ev{background:#fafafa;border-left:3px solid var(--line);padding:8px 12px;margin:8px 0;
      font-size:13px;color:#333;}
  .ev code{font-family:Consolas,monospace;background:#eef0f2;padding:1px 4px;border-radius:3px;}
  .fix{font-size:13.5px;}
  .fix b{color:var(--red);}
  .total{margin-top:26px;padding:14px 16px;background:#1a1a1a;color:#fff;
         border-radius:8px;text-align:center;font-weight:600;}
</style>
</head>
<body>
<div class="wrap">

  <h1>合同内部冲突审查报告</h1>
  <div class="meta">审查对象：××合同（修订稿）　|　审查日期：YYYY-MM-DD　|　范围：仅内部一致性，不含商业风险重评</div>

  <div class="kpi">
    <div class="k1"><b>3</b><span>互相矛盾</span></div>
    <div class="k2"><b>2</b><span>逻辑不一致</span></div>
    <div class="k3"><b>1</b><span>文字笔误</span></div>
  </div>

  <h2>一、互相矛盾（3 处）</h2>

  <div class="item">
    <div class="hd"><span>矛盾 1：违约金上限被追加罚则顶破</span>
      <span class="sev s1">致命</span></div>
    <div class="ev">
      第 6.2 条：<code>累计不超过合同总金额的 10%</code><br>
      第 9.1 条：<code>乙方逾期交付的，另按合同总金额的 5% 支付违约金</code>
    </div>
    <div class="fix"><b>修改建议：</b>在第 9.1 条起首增加「除第 6.2 条已计违约金外」，
      或将第 9.1 条罚则整体并入第 6.2 条的累计上限之内，二者不得并行计取。</div>
  </div>

  <h2>二、逻辑不一致（2 处）</h2>

  <div class="item">
    <div class="hd"><span>不一致 1：时间单位混用（工作日 / 自然日）</span>
      <span class="sev s2">重要</span></div>
    <div class="ev">
      第 4.1 条：<code>甲方应在 10 个工作日内付款</code><br>
      第 6.4 条：<code>验收期为 15 个自然日</code>
    </div>
    <div class="fix"><b>修改建议：</b>全文统一为「自然日」，或在第 1 条定义「工作日」并全篇援引，
      避免起算口径分歧。</div>
  </div>

  <h2>三、文字笔误（1 处）</h2>

  <div class="item">
    <div class="hd"><span>笔误 1：由 / 有</span><span class="sev s3">轻微</span></div>
    <div class="ev">第 5.3 条：<code>该批物料的有乙方负责回收</code></div>
    <div class="fix"><b>修改建议：</b>「有」改为「由」。</div>
  </div>

  <div class="total">合计：3 处矛盾　·　2 处逻辑不一致　·　1 处文字笔误，共 6 处</div>

</div>
</body>
</html>
```

---

## 附录 C：本包结构

```
contract-term-review-revise/
└── SKILL.md          # 单文件技能包（全部内容内置于此，无外部依赖）
```

从 v1.0.0 → v1.1.0 的变更：新增六维度检查清单表、八类修订手法库、冲突检出启发式（金额/时间/主体/程序四类抽取法）、严重度分级、质量自检清单、修订稿与冲突报告两套 HTML 模板、边界（不适用场景）。原 v1.0.0 的方法论正文全部保留。

---

## Prerequisites（前置依赖）

**无外部依赖。** 本 skill 是纯方法论工作流，仅需用户提供：**合同文本** + **我方立场**。产出为 HTML 文档，无需联网、无需额外工具。

> **免责提示**：本 skill 输出为商务条款处理与文本一致性检查建议，**不构成法律意见**。涉及合同效力认定、诉讼策略等，应咨询执业律师。
