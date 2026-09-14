// 示例合同用于展示工作台结构；模型配置必须由用户人工录入并保存。
export const contractTypes = {
  procurement: "采购合同",
  supplier_service: "供应商服务",
  sales: "销售 / 客户服务",
  property_lease: "房屋租赁",
  software: "软件开发",
  other: "其他"
};

export const riskLevels = {
  critical: { label: "严重", className: "badge-critical" },
  high: { label: "高", className: "badge-high" },
  medium: { label: "中", className: "badge-medium" },
  low: { label: "低", className: "badge-low" },
  info: { label: "提示", className: "badge-info" }
};

export const riskCategories = {
  legal: "法律风险",
  commercial: "商业风险",
  company_policy: "企业制度",
  text_quality: "文本质量",
  evidence: "证据问题"
};

export const riskCategoryColors = {
  legal: "#7c5cff",
  commercial: "#e8590c",
  company_policy: "#2b6cb0",
  text_quality: "#0e8a52",
  evidence: "#64748b"
};

export const statusLabels = {
  waiting_confirmation: "待复核",
  working: "进行中",
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
  submitted: "已提交",
  validating: "校验中"
};

export const contractPages = [
  { page: 1, text: "第一条 定义与合同文件\n1.1 甲方（采购方）：华东供应链有限公司。\n1.2 乙方（供货方）：YY 信息技术有限公司。\n1.3 本合同、采购订单、报价单和设备清单均为合同组成部分。" },
  { page: 2, text: "1.4 本合同中“设备”“货物”“产品”具有相同含义，但附件一仍使用“服务产品”表述。\n双方确认，附件与正文存在不一致时，应以双方最终书面确认的版本为准。" },
  { page: 3, text: "第二条 合同价款\n2.1 合同总价为人民币 2,680,000 元（含税）。\n设备清单中各项金额应与合同总价保持一致。" },
  { page: 4, text: "第三条 交付\n3.2 乙方应于 2026 年 10 月 15 日前完成全部设备交付；采购订单 PO-2026-088 载明交付日期为 2026 年 09 月 30 日。\n双方应按项目现场进度完成安装。" },
  { page: 5, text: "第四条 付款\n4.1 付款按照合同约定的里程碑执行。\n4.2 付款申请应附验收记录及合法有效的发票。" },
  { page: 6, text: "第五条 验收\n5.3 甲方应在设备到货后三日内完成验收，逾期未提出书面异议的，视为全部设备验收合格。\n验收完成后甲方支付到货验收款。" },
  { page: 7, text: "第六条 质量保证\n6.1 乙方提供十二个月质量保证服务。\n6.2 质量问题应在收到通知后五个工作日内响应。" },
  { page: 8, text: "第七条 违约责任\n7.2 违约方应赔偿守约方因此遭受的全部损失，包括但不限于间接损失、可得利益损失、律师费、调查费等，且赔偿责任不受合同总价限制。" },
  { page: 9, text: "第八条 知识产权与交付物\n8.1 项目相关方案、接口文档、配置脚本及二次开发成果归乙方所有，甲方仅在合同期内享有使用权。\n乙方既有技术成果仍由乙方保留。" },
  { page: 10, text: "第十条 争议解决\n10.1 因本合同引起的争议，双方协商不成的，提交____仲裁委员会仲裁。\n仲裁裁决为终局，对双方均有约束力。" },
  { page: 11, text: "第十一条 其他\n11.1 本合同自双方授权代表签字并加盖公章之日起生效，一式肆份，双方各执贰份。" },
  { page: 12, text: "签署页\n甲方：华东供应链有限公司\n乙方：YY 信息技术有限公司\n（以下无正文）" }
];

const sampleRisks = [
  {
    risk_id: "risk_001",
    risk_level: "critical",
    risk_category: "commercial",
    risk_topic: "prepayment_ratio",
    title: "预付款比例 60% 超出公司制度上限",
    conclusion_status: "candidate",
    evidence_status: "verified",
    human_status: "pending_review",
    location_confidence: 0.96,
    contract_location: { file_version_id: "contract_v1", page: 4, clause_no: "3.2", char_range: [1204, 1298], quote: "乙方应于 2026 年 10 月 15 日前完成全部设备交付；采购订单 PO-2026-088 载明交付日期为 2026 年 09 月 30 日" },
    analysis: "合同交付日期与采购订单不一致，可能影响项目排期、验收和付款节点。",
    suggestion: "建议统一合同正文与采购订单的交付日期，并明确冲突时的优先适用文件。",
    legal_basis: [{ source_id: "law-1", source_level: "l1", file_name: "《中华人民共和国民法典》", clause_no: "第五百零九条", clause_title: "全面履行义务", title: "《中华人民共和国民法典》第五百零九条", status: "published", snapshot_id: "CN-2026-09", excerpt: "当事人应当按照约定全面履行自己的义务。" }],
    company_basis: [{ source_id: "policy-1", source_level: "l3", file_name: "公司采购管理制度 v3.2", clause_no: "第 4.3 节", clause_title: "交付与验收一致性", title: "公司采购管理制度 v3.2", status: "published", excerpt: "交付日期和验收节点应保持一致。" }]
  },
  {
    risk_id: "risk_002",
    risk_level: "high",
    risk_category: "text_quality",
    risk_topic: "amount_consistency",
    title: "合同总价与设备清单金额可能不一致",
    conclusion_status: "candidate",
    evidence_status: "partially_verified",
    human_status: "pending_review",
    location_confidence: 0.88,
    contract_location: { file_version_id: "contract_v1", page: 3, clause_no: "2.1", char_range: [980, 1060], quote: "合同总价为人民币 2,680,000 元（含税）" },
    analysis: "正文总价与设备清单汇总金额需要交叉核对，当前结果尚未取得附件的完整解析证据。",
    suggestion: "建议补充附件一的金额核对结果，并约定正文与附件金额不一致时的处理规则。",
    legal_basis: [{ source_id: "law-2", source_level: "l1", file_name: "《中华人民共和国民法典》", clause_no: "第五百一十条", clause_title: "合同内容补充", title: "《中华人民共和国民法典》第五百一十条", status: "published", snapshot_id: "CN-2026-09", excerpt: "合同生效后，当事人就质量、价款等内容没有约定的，可以协议补充。" }],
    company_basis: []
  },
  {
    risk_id: "risk_003",
    risk_level: "critical",
    risk_category: "legal",
    risk_topic: "breach_liability",
    title: "违约责任范围过宽且未设置责任上限",
    conclusion_status: "candidate",
    evidence_status: "verified",
    human_status: "pending_review",
    location_confidence: 0.97,
    contract_location: { file_version_id: "contract_v1", page: 8, clause_no: "7.2", char_range: [2100, 2180], quote: "违约方应赔偿守约方因此遭受的全部损失，包括但不限于间接损失、可得利益损失、律师费、调查费等，且赔偿责任不受合同总价限制" },
    analysis: "赔偿范围包含间接损失和可得利益损失，且未设置责任上限，可能扩大重大责任敞口。",
    suggestion: "建议区分直接损失与间接损失，并根据合同金额设置责任上限和例外情形。",
    legal_basis: [{ source_id: "law-3", source_level: "l1", file_name: "《中华人民共和国民法典》", clause_no: "第五百八十五条", clause_title: "违约金", title: "《中华人民共和国民法典》第五百八十五条", status: "published", snapshot_id: "CN-2026-09", excerpt: "约定的违约金过分高于造成的损失的，当事人可以请求人民法院或者仲裁机构予以适当减少。" }],
    company_basis: [{ source_id: "policy-2", source_level: "l3", file_name: "合同授权与用印管理办法 v2.0", clause_no: "第 5.2 节", clause_title: "重大责任条款审批", title: "合同授权与用印管理办法 v2.0", status: "published", excerpt: "重大责任条款应经过法务复核并明确审批依据。" }]
  },
  {
    risk_id: "risk_004",
    risk_level: "high",
    risk_category: "legal",
    risk_topic: "ip_ownership",
    title: "项目交付物知识产权归属偏向乙方",
    conclusion_status: "needs_verification",
    evidence_status: "verified",
    human_status: "pending_review",
    location_confidence: 0.95,
    contract_location: { file_version_id: "contract_v1", page: 9, clause_no: "8.1", char_range: [2450, 2525], quote: "项目相关方案、接口文档、配置脚本及二次开发成果归乙方所有，甲方仅在合同期内享有使用权" },
    analysis: "项目成果全部归乙方且甲方仅享有期限内使用权，可能影响后续运维、迁移和二次开发。",
    suggestion: "建议明确项目定制成果归属甲方，或至少授予甲方永久、不可撤销的使用和修改权。",
    legal_basis: [],
    company_basis: [{ source_id: "policy-3", source_level: "l3", file_name: "信息系统交付物管理规范 v1.6", clause_no: "第 6.1 节", clause_title: "交付物与知识转移", title: "信息系统交付物管理规范 v1.6", status: "published", excerpt: "项目交付物应满足持续运维和知识转移要求。" }]
  },
  {
    risk_id: "risk_005",
    risk_level: "medium",
    risk_category: "legal",
    risk_topic: "dispute_resolution",
    title: "争议解决机构为空",
    conclusion_status: "needs_verification",
    evidence_status: "unverified",
    human_status: "pending_review",
    location_confidence: 0.96,
    contract_location: { file_version_id: "contract_v1", page: 10, clause_no: "10.1", char_range: [5030, 5098], quote: "因本合同引起的争议，双方协商不成的，提交____仲裁委员会仲裁" },
    analysis: "争议解决机构为空，条款无法直接执行，需要人工确认仲裁机构或法院管辖。",
    suggestion: "建议补全明确且存在的仲裁委员会名称；如选择诉讼，应删除仲裁表述并约定管辖法院。",
    legal_basis: [{ source_id: "law-4", source_level: "l1", file_name: "《中华人民共和国仲裁法》", clause_no: "第十六条", clause_title: "仲裁协议形式与内容", title: "《中华人民共和国仲裁法》第十六条", status: "published", snapshot_id: "CN-2026-09", excerpt: "仲裁协议应当具有请求仲裁的意思表示、仲裁事项和选定的仲裁委员会。" }],
    company_basis: []
  },
  {
    risk_id: "risk_006",
    risk_level: "low",
    risk_category: "text_quality",
    risk_topic: "definition_consistency",
    title: "术语定义与附件表述不一致",
    conclusion_status: "candidate",
    evidence_status: "verified",
    human_status: "pending_review",
    location_confidence: 0.89,
    contract_location: { file_version_id: "contract_v1", page: 2, clause_no: "1.4", char_range: [1260, 1338], quote: "本合同中“设备”“货物”“产品”具有相同含义，但附件一仍使用“服务产品”表述" },
    analysis: "正文将多个术语约定为同义，但附件仍出现未定义的“服务产品”，会影响抽取和后续解释一致性。",
    suggestion: "建议统一使用“设备”，并在定义条款中删除未使用或未定义术语。",
    legal_basis: [],
    company_basis: [{ source_id: "policy-4", source_level: "l3", file_name: "合同模板文本规范 v5.0", clause_no: "第 3.2 节", clause_title: "术语与编号一致性", title: "合同模板文本规范 v5.0", status: "published", excerpt: "同一合同内应保持主体、标的、日期、金额和关键术语一致。" }]
  }
];

export const knowledgeData = {
  legalSnapshots: [
    { id: "CN-2026-09", name: "法律快照 CN-2026-09", status: "published", sources: 128, hash: "sha256:9f3a8c2e1", publishedAt: "2026-09-05 18:30", coverage: "采购、服务、销售、租赁、软件开发" },
    { id: "CN-2026-10-draft", name: "法律快照 CN-2026-10-draft", status: "draft", sources: 132, hash: "sha256:7b1d88aa", publishedAt: "校验中", coverage: "新增建工解释二校验样本" },
    { id: "CN-2026-07", name: "法律快照 CN-2026-07", status: "historical", sources: 120, hash: "sha256:41c207fe", publishedAt: "2026-07-20 09:00", coverage: "历史归档" }
  ],
  rules: [
    { file: "procurement-rules@2.1", summary: "采购合同通用规则集。覆盖预付款、验收、交付、质保、付款节点和来源优先级。", selected: true, status: "active", type: "采购专项", priority: "blocker" },
    { file: "contract-common@1.0", summary: "通用合同结构和文本规则。覆盖主体、金额、日期、争议解决、责任边界和条款缺失。", selected: true, status: "active", type: "通用规则", priority: "blocker" },
    { file: "consistency-rules@0.9", summary: "跨文件一致性规则草稿。比较采购订单、报价单、设备清单与合同正文的金额和日期。", selected: false, status: "draft", type: "跨文件", priority: "high" },
    { file: "date-logic-rules@1.4", summary: "日期逻辑规则。校验签署、生效、交付、验收、付款、质保和终止日期顺序。", selected: false, status: "active", type: "日期逻辑", priority: "high" },
    { file: "amount-arithmetic-rules@1.2", summary: "金额和比例计算规则。校验税率、大小写金额、付款比例合计和质保金比例。", selected: false, status: "active", type: "金额计算", priority: "blocker" }
  ],
  policies: [
    { file: "公司采购管理制度_v3.2.pdf", summary: "L3 企业制度。约束采购立项、预付款比例、验收流程、供应商评价和例外审批。", selected: true, status: "published", version: "v3.2" },
    { file: "合同授权与用印管理办法_v2.0.pdf", summary: "L3 企业制度。约束合同权限、责任上限、用印流程、重大条款复核和归档要求。", selected: true, status: "published", version: "v2.0" },
    { file: "供应商准入与评估制度_v1.8.pdf", summary: "L3 企业制度。约束供应商资质、黑名单、履约评分和风险供应商审批。", selected: false, status: "draft", version: "v1.8" },
    { file: "信息系统交付物管理规范_v1.6.pdf", summary: "L3 企业制度。约束技术文档、脚本、配置清单和知识转移交付。", selected: false, status: "published", version: "v1.6" },
    { file: "合同模板文本规范_v5.0.docx", summary: "企业模板。约束术语一致性、条款顺序、附件引用、空白项和编号规范。", selected: false, status: "published", version: "v5.0" }
  ],
  memory: [
    { content: "采购合同预付款比例超过 30% 时，需标记为高风险并检查审批依据。", scope: "组织级", type: "企业偏好", status: "正式", confidence: "0.95" },
    { content: "YY 信息技术历史交付延迟样本需在验收和违约责任中提高关注权重。", scope: "合同类型级", type: "历史经验", status: "候选", confidence: "0.72" },
    { content: "房屋租赁合同需额外检查装修恢复原状与提前解约条款。", scope: "合同类型级", type: "审查经验", status: "正式", confidence: "0.90" }
  ]
};

export const capabilityData = {
  skills: [
    { name: "contract-common-review", version: "1.3.0", scope: "全部合同", description: "合同通用结构、一致性、争议解决和责任边界审查。", status: "enabled", icon: "shield" },
    { name: "procurement-contract-review", version: "1.2.0", scope: "采购合同", description: "采购专项审查，覆盖付款、交付、验收、质保和供应商义务。", status: "enabled", icon: "cart" },
    { name: "selected-text-review", version: "1.0.0", scope: "全部合同", description: "人工划词、划句和划段局部审查。", status: "enabled", icon: "cursor" },
    { name: "legal-source-verification", version: "1.0.0", scope: "全部合同", description: "法律来源版本、状态、原文和快照核验。", status: "validating", icon: "book" },
    { name: "external-skill-upload-demo", version: "0.8.0", scope: "隔离区", description: "待校验 Skill 包，尚未允许进入审查任务。", status: "isolated", icon: "file" }
  ],
  // 首次启动不提供测试模型，用户必须在能力配置中人工新增。
  models: []
};

export const defaultSettings = {
  autoSave: true,
  autoSaveInterval: 5,
  defaultExportFormats: ["DOCX", "PDF", "JSON"],
  forceValidator: true,
  blockScannedPdfWithoutOcr: true,
  checkSensitiveInfo: true,
  legalSourceAllowlist: [],
  chatPermissions: {
    sessionAccess: "local_user",
    memoryWrite: "confirm_only",
    toolExecution: "confirm",
    allowExternalModelSensitiveData: false,
    allowRestrictedLocalMemory: false
  },
  compactMode: false,
  showStatusBar: true
};

export function createSampleState() {
  const project = {
    project_id: "sample-project",
    project_name: "华东供应链设备采购合同",
    file_name: "华东供应链设备采购合同.docx",
    stored_path: "本地示例数据",
    file_version_id: "contract_v1",
    contract_type: "procurement",
    review_mode: "standard",
    created_at: "2026-09-10T07:42:18.000Z",
    updated_at: "2026-09-10T07:42:18.000Z"
  };
  const document = {
    fileName: project.file_name,
    extension: ".docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sha256: "9f3a8c2e1d6bb6f72a5db0d6cbf0b9a5f2f4b8a0a2d7cc1b7af1b5f7d3a1c2e4",
    sizeBytes: 284 * 1024,
    pageCount: contractPages.length,
    documentType: "docx",
    pages: contractPages,
    text: contractPages.map((page) => page.text).join("\n\n"),
    ocr: { status: "not_required" }
  };
  const review = {
    review_version_id: "RV-20260910-01",
    project,
    document,
    risks: sampleRisks,
    annotations: [],
    humanRevisions: [],
    exportRecords: [],
    config: {
      snapshot: { id: "CN-2026-09", status: "published" },
      rules: knowledgeData.rules.filter((item) => item.selected).map((item) => item.file),
      policies: knowledgeData.policies.filter((item) => item.selected).map((item) => item.file)
    },
    task: { task_id: "task_sample", status: "waiting_confirmation", progress: 86, checkpoint_id: "ckpt-20260910-01", idempotency_key: "idem-9f3a8c2e1d6b" }
  };
  return {
    activeProjectId: project.project_id,
    projects: [project],
    reviews: { [project.project_id]: review },
    knowledge: JSON.parse(JSON.stringify(knowledgeData)),
    capabilities: JSON.parse(JSON.stringify(capabilityData)),
    settings: JSON.parse(JSON.stringify(defaultSettings)),
    auditRecords: [
      { audit_id: "audit_sample_1", created_at: "2026-09-10T07:58:41.000Z", actor: "法务用户", action: "导入合同", resource: project.file_name, result: "成功", detail: "DOCX · 12 页" },
      { audit_id: "audit_sample_2", created_at: "2026-09-10T08:12:18.000Z", actor: "法务用户", action: "生成初审结果", resource: project.project_id, result: "待复核", detail: "6 条风险" }
    ]
  };
}
