const catalog = require("./general-checklist-catalog.json");
const { compact, resolveRefs, clauseDefinitions } = require("./contract-evidence.cjs");

const CATALOG = catalog.items;
const MAPPED = {
  "GC-1-08": ["party.obligation_subject_inversion"],
  "GC-2-08": ["amount.schedule_ratio_sum"],
  "GC-2-18": ["acceptance.subjective_standard", "timeline.acceptance_deadline_conflict"],
  "GC-2-22": ["amount.total_vs_uppercase"],
  "GC-2-23": ["amount.item_sum", "amount.schedule_amount_anchor"],
  "GC-2-24": ["timeline.trial_before_final_acceptance", "timeline.license_term_conflict"],
  "GC-3-03": ["obligation.environment_transfer", "acceptance.cost_allocation"],
  "GC-4-02": ["penalty.unlimited_delay_cap", "penalty.daily_rate_excessive"],
  "GC-4-04": ["liability.broad_indirect_loss"],
  "GC-4-16": ["completeness.termination_right"],
  "GC-6-02": ["timeline.calendar_unit_mixing", "acceptance.major_fault_undefined"]
};

const SCOPES = {
  "GC-2-04": [/软件|服务|实施|开发|咨询/, "涉及服务或软件交付"],
  "GC-2-17": [/货物|设备|所有权保留/, "有形货物或所有权保留安排"],
  "GC-3-04": [/独家|排他/, "出现独家或排他安排"],
  "GC-3-05": [/最惠|最优价格/, "出现最惠待遇安排"],
  "GC-3-08": [/软件|源代码|开源/, "涉及软件组件"],
  "GC-3-09": [/商标|品牌许可/, "涉及商标或品牌许可"],
  "GC-3-10": [/个人信息|个人数据|用户数据|客户数据|数据处理/, "涉及数据或个人信息处理"],
  "GC-3-12": [/人员|项目经理|团队|驻场/, "约定人员投入"],
  "GC-3-11": [/软件|运维|技术支持|服务/, "涉及持续服务"],
  "GC-4-07": [/保证人|担保人|连带责任保证|一般保证/, "存在债务保证安排"],
  "GC-4-08": [/保证人|担保人|连带责任保证|一般保证/, "存在债务保证安排"],
  "GC-4-09": [/抵押|质押/, "存在抵押或质押"],
  "GC-4-10": [/保证金|保函/, "存在保证金或保函"],
  "GC-4-20": [/仲裁/, "出现仲裁安排"],
  "GC-6-03": [/专用条款|通用条款/, "采用专用与通用条款"],
  "GC-6-07": [/电子签|电子章/, "采用电子签署"],
};
const EXTERNAL = new Set(["GC-1-01", "GC-1-02", "GC-1-03", "GC-1-04", "GC-1-05", "GC-1-06", "GC-1-07", "GC-1-09", "GC-1-10", "GC-4-09", "GC-4-21", "GC-4-22", "GC-6-04", "GC-6-05", "GC-6-06", "GC-6-07", "GC-6-09", "GC-6-10"]);
const MATERIALS = {
  "GC-1-01": ["营业执照、签署页、开票资料和收款账户证明"],
  "GC-1-02": ["营业执照及统一社会信用代码核验记录"],
  "GC-1-03": ["最新企业登记、失信与破产查询记录"],
  "GC-1-04": ["业务所需许可证及有效期限"],
  "GC-1-05": ["法定代表人登记或授权委托书、授权范围与期限"],
  "GC-1-06": ["盖章原件及印章核验记录"],
  "GC-1-07": ["适用事项的董事会或股东会决议"],
  "GC-1-09": ["注册资本、涉诉、执行与履约能力调查记录"],
  "GC-1-10": ["国资或上市主体身份、审批及披露记录"],
  "GC-4-09": ["抵押或质押登记证明"],
  "GC-4-21": ["管辖法院与争议实际联系的事实材料、现行法律核验记录"],
  "GC-4-22": ["标的性质和所在地证明、专属管辖核验记录"],
  "GC-5-01": ["交易事实、适用法律与监管规定核验记录"],
  "GC-5-02": ["招标适用性意见、招标及中标文件"],
  "GC-5-03": ["分包范围、资质和审批文件"],
  "GC-5-04": ["廉洁承诺、佣金与账外支付核查记录"],
  "GC-5-05": ["数据处理清单、合法性基础和出境合规材料"],
  "GC-5-06": ["定价安排、市场情况与竞争合规评估"],
  "GC-5-07": ["交易主体及物项管制筛查记录"],
  "GC-5-08": ["税目税率确认、真实交易与开票资料"],
  "GC-5-09": ["内部授权制度与审批记录"],
  "GC-5-10": ["关联关系、定价及审批披露资料"],
  "GC-5-11": ["应办备案或登记事项清单及办理凭证"],
  "GC-5-12": ["实际用工管理安排、外包或派遣资质"],
  "GC-6-04": ["完整签署页原件"],
  "GC-6-05": ["多页合同原件及防替换措施记录"],
  "GC-6-06": ["附件签署页、版本与效力约定"],
  "GC-6-07": ["电子签名验证报告与平台存证"],
  "GC-6-09": ["定稿版本确认及流转记录"],
  "GC-6-10": ["修订记录与双方确认凭证"]
};

function runGeneralChecklist({ document = {}, contractType = "", checkResults: existing = [] } = {}) {
  const text = String(document.text || "");
  const normalized = compact(text);
  const definitions = clauseDefinitions(text);
  const statements = text.split(/[。；;]/).map(compact).filter(Boolean);
  const sections = (pattern) => statements.filter((s) => pattern.test(s)).join("。");
  const byCheck = new Map(existing.map((c) => [c.check_id, c]));
  const evaluations = new Map();
  const set = (id, status, message, quotes = [], extra = {}) => evaluations.set(id, {
    status, message, source_refs: quotes.flatMap((q) => resolveRefs(document, q)), ...extra
  });
  const screen = (id, requirements, scope = normalized) => {
    const gaps = requirements.filter(([, pattern]) => !pattern.test(scope)).map(([label]) => label);
    set(id, gaps.length ? "missing" : "unverifiable", gaps.length
      ? `当前文本未检出完整约定：${gaps.join("、")}。需结合附件与业务确认。`
      : "已检出约定要素，仍需核验条款关联、适用性及完整性。", [], { gaps, text_screened: true });
  };

  const payment = sections(/付款|支付|价款|预付|尾款|结算/);
  const delivery = sections(/交付|交货|到货/);
  screen("GC-2-09", [["客观起算事件", /(?:收到.{0,20}(?:发票|款项|单据)|验收合格|签署|签订|生效|到货).{0,20}(?:后|起|之日)/], ["付款期限", /\d+(?:个)?(?:工作日|日|月)|[一二三四五六七八九十]+(?:个)?(?:工作日|日|月)/]], payment);
  screen("GC-2-10", [["付款单据与取得要求", /发票|验收单|进度确认单|保函|付款申请/]], payment);
  const subjectivePayment = statements.filter((s) => /满意|单方认定|自行决定/.test(s) && /付款|支付|尾款|结算/.test(s) && !/不得.{0,20}(?:满意|单方认定|自行决定)/.test(s));
  set("GC-2-11", subjectivePayment.length ? "conflict" : "unverifiable", subjectivePayment.length ? "付款条件出现满意或单方判断措辞，需核验客观标准与确认机制。" : "未检出明确主观付款条件，仍需核对全部前置条件及可达成性。", subjectivePayment);
  screen("GC-2-13", [["逾期付款责任", /(?:逾期|迟延).{0,20}(?:付款|支付).{0,60}(?:利息|违约金)/]], normalized);
  screen("GC-2-14", [["交付期限", /\d+(?:个)?(?:日|工作日|月)|\d{4}年\d{1,2}月\d{1,2}日/], ["起算事件或固定日期", /(?:生效|签订|签署|预付款到账|收到预付款).{0,20}(?:后|起|之日)|\d{4}年\d{1,2}月\d{1,2}日/]], delivery);
  screen("GC-2-15", [["交付地点或接收环境", /地点|地址|指定.{0,10}(?:平台|系统|服务器|仓库)/], ["交付凭证", /签收|交接单|交付清单|物流单|电子确认/]], delivery);

  screen("GC-2-05", [["含税口径", /含税|不含税|包含.{0,8}税/], ["税率", /税率.{0,10}\d+(?:\.\d+)?%/]]);
  screen("GC-2-06", [["税率调整后的价款机制", /税率.{0,40}(?:调整|变化|变动).{0,60}(?:价款|价格|结算)/]]);
  screen("GC-2-07", [["发票类型", /专用发票|普通发票/], ["开票时限", /(?:收款前|付款前|开票.{0,15}日|日内.{0,10}开具)/], ["发票瑕疵补救", /(?:补开|换开|重开|重新开具)/]]);
  screen("GC-2-12", [["户名", /账户名|户名|收款人名称/], ["开户行", /开户行|开户银行/], ["账号", /账号[：:]?\d{8,}/], ["账户变更确认", /账户.{0,30}变更.{0,30}书面/]]);
  screen("GC-2-20", [["不合格的修理或退出救济", /不合格.{0,60}(?:修理|重做|退货|减价|解除)/], ["整改次数上限", /(?:两|二|三|[1-9])次.{0,20}(?:不合格|整改|解除)|整改.{0,15}(?:不得超过|最多)/]]);
  screen("GC-2-21", [["质保期限", /质保.{0,20}(?:年|月|日)/], ["起算点", /(?:验收|交付).{0,20}(?:起|开始)|质保.{0,20}(?:之日|起算)/], ["响应时限", /(?:响应|恢复).{0,20}(?:小时|分钟|日)/]]);
  screen("GC-3-04", [["期限", /期限|年|月/], ["地域", /地域|地区|区域/], ["品类", /品类|产品范围/], ["对价", /最低采购|承诺量|对价/], ["违约后果", /违约|赔偿/]], sections(/独家|排他/));
  screen("GC-3-05", [["对价", /承诺量|最低采购|对价/], ["验证机制", /验证|审计|核查|核验/]], sections(/最惠|最优价格/));
  screen("GC-3-06", [["背景知识产权", /背景.{0,10}(?:IP|知识产权)|既有知识产权/], ["成果归属", /(?:成果|前景).{0,30}(?:归属|所有|归甲方|归乙方)/], ["通用工具许可", /(?:通用|组件).{0,40}许可/]]);
  screen("GC-3-07", [["不侵权保证", /不侵权|无侵犯|不存在.{0,10}侵权/], ["侵权抗辩", /侵权.{0,60}抗辩/], ["侵权费用与赔偿", /侵权.{0,80}(?:赔偿|费用承担|承担费用)/]]);
  screen("GC-3-08", [["开源组件披露", /开源.{0,30}(?:清单|披露|列表)/]]);
  screen("GC-3-09", [["许可类型", /独占|排他|普通许可/], ["许可范围", /范围|地域/], ["许可期限", /期限/], ["终止清理", /终止.{0,50}(?:停止使用|清理|撤除)/]], sections(/商标|品牌|许可|终止/));
  screen("GC-3-10", [["处理角色", /控制者|处理者|受托|委托处理/], ["处理目的", /处理目的|用于|仅限/], ["保存期限", /保存期限|保留期限|删除|销毁/], ["安全措施", /脱敏|加密|访问控制|安全措施/], ["跨境安排", /跨境|出境|境内存储/]], sections(/数据|个人信息|处理|保存|安全|出境/));
  screen("GC-3-12", [["关键人员", /关键人员|项目经理|核心团队/], ["替换确认", /(?:替换|更换).{0,30}(?:同意|批准|书面确认)/]], sections(/人员|项目经理|团队|替换|更换/));
  screen("GC-3-11", [["服务指标", /可用率|响应.{0,12}(?:小时|分钟)|恢复.{0,12}(?:小时|分钟)/], ["服务扣款救济", /(?:SLA|服务|响应).{0,70}(?:扣款|减免|赔偿)/], ["服务不达标退出", /(?:服务|SLA|故障).{0,80}(?:解除|退出)/]]);
  screen("GC-4-03", [["违约金与损失赔偿关系", /违约金.{0,35}(?:不足|另行|不影响).{0,35}(?:损失|赔偿)|赔偿.{0,35}(?:抵扣|扣除).{0,15}违约金/]]);
  screen("GC-4-05", [["赔偿累计上限", /(?:赔偿|责任).{0,20}(?:上限|累计不超过|总额不超过)/]]);
  screen("GC-4-08", [["保证期间及起算", /保证期间.{0,50}(?:届满|到期|起).{0,25}(?:年|月|日)/]]);
  screen("GC-4-10", [["退还条件", /(?:保证金|保函).{0,80}(?:验收|期满|届满).{0,30}(?:退还|返还|解除)/], ["退还时限", /(?:日内|月内).{0,10}(?:退还|返还)|(?:退还|返还).{0,15}(?:日内|月内)/]]);
  screen("GC-4-12", [["不可抗力通知", /不可抗力.{0,100}(?:日|小时)内.{0,20}通知/], ["不可抗力举证", /不可抗力.{0,180}(?:提供.{0,15}证明|举证)/]]);
  screen("GC-4-13", [["不可抗力长期影响退出", /不可抗力.{0,150}(?:超过|持续).{0,20}(?:日|月).{0,50}(?:解除|终止)/], ["结算安排", /不可抗力.{0,200}结算/]]);
  screen("GC-4-18", [["解除后结算", /(?:解除|终止).{0,100}结算/], ["返还与移交", /(?:解除|终止).{0,130}(?:返还|退还).{0,70}(?:移交|交还)/]]);
  const notice = statements.filter((s) => /送达|地址|收件人|邮箱|电话/.test(s)).join("。");
  screen("GC-4-23", [["送达地址", /送达地址/], ["收件人", /收件人|联系人/], ["联系电话", /电话|手机/], ["电子邮箱", /邮箱|[\w.+-]+@[\w.-]+/], ["地址变更通知", /地址变更.{0,20}(?:书面通知|书面告知)/]], notice);
  screen("GC-4-24", [["律师费承担", /律师费.{0,35}(?:违约方承担|败诉方承担)|(?:违约方|败诉方).{0,35}律师费/], ["保全费承担", /保全费/]]);
  screen("GC-4-25", [["正文附件或多语言优先顺序", /(?:正文|附件|文本).{0,40}(?:为准|优先)/]]);
  screen("GC-6-01", [["违约救济", /违约责任|违约金|赔偿/], ["解除退出", /解除|终止/], ["通知送达", /送达/], ["争议解决", /争议|纠纷/]]);
  screen("GC-6-03", [["专用与通用条款优先顺序", /专用条款.{0,40}(?:优先|为准)|(?:优先|为准).{0,40}专用条款/]]);

  const change = statements.filter((s) => /单方.{0,15}(?:变更|调整|修改)/.test(s));
  if (change.length) {
    const bounded = /双方.{0,10}书面.{0,10}(?:确认|同意)/.test(normalized) && /计价|费用调整/.test(normalized) && /范围|上限/.test(normalized);
    set("GC-3-02", bounded ? "unverifiable" : "conflict", bounded ? "已发现变更约束，需核对是否约束该单方权利。" : "单方变更安排未检出完整的双方书面确认、计价和范围约束。", change);
  } else set("GC-3-02", "unverifiable", "未检出明确的无约束单方变更措辞，仍需审查整体变更流程。");

  const arbitration = statements.filter((s) => /(?:提交|申请|提请|通过|进行).{0,30}仲裁|仲裁委员会/.test(s) && !/不(?:得|再).{0,10}仲裁/.test(s));
  const litigation = statements.filter((s) => /(?:起诉|提起诉讼|诉至|诉讼解决|法院诉讼)/.test(s) && !/不得.{0,10}(?:起诉|诉讼)/.test(s));
  const conditionalFallback = /仲裁(?:协议|条款).{0,20}(?:无效|不成立).{0,35}(?:起诉|诉讼)/.test(normalized);
  const forumStatus = arbitration.length && litigation.length ? (conditionalFallback ? "unverifiable" : "conflict") : arbitration.length || litigation.length ? "pass" : "missing";
  set("GC-4-19", forumStatus, forumStatus === "conflict" ? "同一合同同时提供诉讼与仲裁路径，需核对是否针对同一争议并统一约定。" : forumStatus === "pass" ? "当前文本仅检出一种实体争议解决路径。" : "争议解决路径缺失或存在条件分支，需要核验。", [...arbitration, ...litigation]);
  const vagueArbitration = arbitration.filter((s) => /当地仲裁|当地.{0,5}仲裁机构|(?:提交|向|由)仲裁委员会/.test(s));
  set("GC-4-20", vagueArbitration.length ? "conflict" : "unverifiable", vagueArbitration.length ? "仲裁机构采用泛称，未明确唯一机构全称。" : "机构名称仍需核验官方名称、真实性和唯一性。", vagueArbitration);
  set("GC-4-07", "unverifiable", /一般保证/.test(normalized) ? "已约定一般保证；需评估先诉抗辩和增信需求，保证方式属于业务选择。" : "需核验保证方式、保证人授权与我方增信需求。", statements.filter((s) => /一般保证|连带责任保证/.test(s)));

  const exclusions = statements.filter((s) => /(?:人身损害|故意|重大过失)/.test(s) && /(?:免除|不承担).{0,15}(?:责任|赔偿)/.test(s) && !/不得免除|不予免除|不适用免责|不受.{0,10}(?:上限|限制)/.test(s));
  set("GC-4-14", exclusions.length ? "conflict" : "unverifiable", exclusions.length ? "检出涉及人身损害或故意、重大过失的免责措辞，需核对效力及例外。" : "未发现该类明确免责措辞，仍需法律与上下文核验。", exclusions);
  const cap = /(?:责任|赔偿).{0,20}(?:上限|不超过)/.test(normalized);
  if (cap) screen("GC-4-06", [["保密与侵权例外", /(?:保密|侵权).{0,60}(?:不受|不适用).{0,15}(?:上限|限制)/], ["故意重大过失例外", /(?:故意|重大过失).{0,60}(?:不受|不适用).{0,15}(?:上限|限制)/]]);
  else set("GC-4-06", "not_applicable", "未检出责任上限，例外清单暂不适用；责任上限另项检查。");

  const declared = new Set(definitions.map((c) => c.clause_no));
  const references = [...text.matchAll(/第\s*(\d+(?:\.\d+)+)\s*条/g)];
  const allReferences = [...text.matchAll(/第\s*[一二三四五六七八九十百千\d.]+\s*条/g)];
  const broken = references.filter((m) => !declared.has(m[1]));
  set("GC-2-25", broken.length ? "conflict" : allReferences.length > references.length ? "unverifiable" : references.length ? "pass" : "unverifiable", broken.length ? `内部引用未找到条款定义：${[...new Set(broken.map((m) => m[1]))].join("、")}；须区分合同内部引用与外部法律引用。` : "已核对可解析的数字条款引用；其他引用形式仍需核验。", broken.map((m) => m[0]));
  const duplicate = definitions.filter((c, i) => definitions.findIndex((d) => d.clause_no === c.clause_no) !== i);
  const typo = statements.filter((s) => /有乙方负责|有甲方负责|XXX|待填写|【待补充】/.test(s));
  set("GC-6-08", duplicate.length || typo.length ? "conflict" : "unverifiable", duplicate.length || typo.length ? `发现重复条款或文本残留：${duplicate.map((d) => d.clause_no).join("、") || "疑似错字/占位符"}。` : "基础重复编号和占位符扫描完成，账户与名称准确性需资料核验。", [...duplicate.map((d) => d.text), ...typo]);
  // Referencing an appendix is not proof it is attached. Headings with following content are required.
  const appendices = [...normalized.matchAll(/附件([一二三四五六七八九十\d]+)/g)].map((m) => m[1]);
  const headings = [...text.matchAll(/(?:^|\n)\s*附件\s*([一二三四五六七八九十\d]+)[^\n]*\n(?=\s*\S)/g)].map((m) => m[1]);
  const missingAppendices = [...new Set(appendices)].filter((id) => !headings.includes(id));
  set("GC-2-26", !appendices.length ? "not_applicable" : missingAppendices.length ? "unverifiable" : "unverifiable", missingAppendices.length ? `待核实附件实物与版本：${missingAppendices.join("、")}；目录或正文引用不证明已附齐。` : "已发现附件线索，仍须核验完整内容、版本与签署。", [], { required_materials: ["附件原件及清单"] });

  const checkResults = CATALOG.map((entry) => {
    const scope = SCOPES[entry.check_id];
    const external = EXTERNAL.has(entry.check_id) || entry.layer === "L5";
    let result = evaluations.get(entry.check_id);
    const related = (MAPPED[entry.check_id] || []).map((id) => byCheck.get(id)).filter(Boolean);
    if (related.length) {
      // A narrow detector can establish a defect, but cannot certify the full GC criterion.
      const adverse = related.find((c) => c.status === "conflict") || related.find((c) => c.status === "missing");
      result = { status: adverse?.status || "unverifiable", message: adverse?.message || "专项子检查已执行，完整通用判据仍需核验。",
        source_refs: related.flatMap((c) => c.source_refs || []), related_checks: related.map((c) => c.check_id), mapped: true };
    }
    if (!result) result = { status: "unverifiable", message: external ? "需要有效外部材料或官方记录核验，合同自述不足以确认。" : "需要结合业务立场、条款上下文和附件进行语义复核。", source_refs: [] };
    if (scope && !scope[0].test(normalized)) result = { status: "not_applicable", message: `当前文本未触发适用条件：${scope[1]}。新增材料后应重新检查。`, source_refs: [] };
    return { ...entry, catalog_version: catalog.version, catalog_source: catalog.source,
      method: external ? "external_verification" : evaluations.has(entry.check_id) ? "text_screening" : related.length ? "deterministic_mapping" : "semantic_review",
      applicability: scope?.[1] || "通用审查；材料不足时不推定不适用", contract_type: contractType,
      evidence_requirement: external ? "原件、授权或官方核验记录及有效日期" : "当前合同原文、关联条款及附件；缺失项保存全文检查范围",
      required_materials: MATERIALS[entry.check_id] || (external ? ["有效证明材料或官方核验记录"] : []),
      fact_refs: [], ...result,
      search_scope: { file_version_id: document.fileVersionId || "", document_hash: document.sha256 || "", block_ids: (document.blocks || []).map((b) => b.block_id) }
    };
  });
  const findings = checkResults.filter((c) => !c.mapped && ["conflict", "missing"].includes(c.status)).map((check) => {
    const first = check.source_refs[0];
    return { risk_id: `check_${check.check_id}`, rule_id: check.check_id, source_type: "checklist_screening", evidence_origin: "checklist_screening",
      title: `${check.title}：${check.status === "missing" ? "约定要素待补齐" : "存在待核验问题"}`, risk_level: check.severity,
      risk_category: check.layer === "L6" ? "text_quality" : "commercial", risk_topic: check.layer === "L4" ? "remedy" : "general_checklist",
      conclusion_status: "needs_verification", evidence_status: "unverified", human_status: "pending_review",
      location_confidence: first ? 0.9 : 0,
      contract_location: { file_version_id: document.fileVersionId || "", page: first?.page ?? null, clause_no: first?.clause_no || "", quote: first?.quote || "", source_refs: check.source_refs, location_status: first ? "resolved" : "unresolved" },
      analysis: check.message, suggestion: `请核对并补充：${check.criterion}。`, checklist_ids: [check.check_id], related_checks: [check.check_id],
      catalog_version: catalog.version, legal_basis: [], company_basis: [] };
  });
  return { catalogVersion: catalog.version, checkResults, findings, documentText: text };
}

module.exports = { CATALOG, MAPPED, runGeneralChecklist };
