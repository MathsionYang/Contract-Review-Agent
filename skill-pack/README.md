# 腾讯电子签合同技能 · 三条路线产出包

本目录把专家会话挂载的技能 `tencent-esign-contract` 以三种独立形态落地，各取所需。

## 产出清单

| 路线 | 目录 | 形态 | 用途 |
|---|---|---|---|
| 一 · 原文全文 | `01-原文全文版/tencent-esign-contract/` | 完整原始技能副本（SKILL.md + 7 份 references + 主脚本 + config + 图标 + LICENSE + README） | 原样留存、逐行研读、搬到其他工具（Cursor / Claude Code / Codex）直接用 |
| 二 · 精简教学版 | `02-精简教学版/SKILL.md` | 约 150 行结构提炼，保留骨架并附 8 条设计要点 + 可迁移清单 | 理解"生产级 Skill 为什么这么写"，作为写自己技能时的对照模板、书稿案例 |
| 三 · 独立技能 | 已安装至 `~/.workbuddy/skills/tencent-esign-contract/`（说明见 `03-独立技能/安装说明.md`） | 用户级技能，脱离专家会话可调用 | 日常直接在任意会话里说"帮我起草/审查合同"即可触发 |

## 三份产出的差别

- **路线一是"实物"**：字节级复制，未改一字，可直接 `git` 化或打包分发。
- **路线二是"图纸"**：不追求功能完整，只保留决策结构——frontmatter 契约、调度器边界、意图路由表、鉴权无感设计、Hub-and-Spoke 资产分层。
- **路线三是"装好的机器"**：位于用户级技能目录，WorkBuddy 全局可见。

## 源头信息

- 上游仓库：`https://github.com/tencentess/tencent-esign-contract`
- 许可证：MIT，Copyright © 2026 Tencent Technology (Shenzhen) Co., Ltd.
- 技能版本：`1.3.0`（宿主专家插件 `contract-legal-expert` v1.4.0）
- 依赖：Python 3.x、可访问 `appgw.ess.tencent.cn`、SIGN-TOKEN（`https://qian.tencent.com`）

## 使用前必读

1. 三条路线产出的技能**共用同一个 `~/.esign-token`**，鉴权只需配置一次。
2. 路线三与原专家插件内的同名技能存在**同名并存**，调用时可能出现重复识别；如遇异常，删除 `~/.workbuddy/skills/tencent-esign-contract/` 即可回滚（删除后专家会话内的技能不受影响）。
3. 涉及外部专业结论（合同风险、法条引用）时，仍以云端返回结果为准，参考输出不构成法律意见。
