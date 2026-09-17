<script setup>
import { computed, ref } from "vue";
import { AlertTriangle, Check, ClipboardList, Filter, Search, X } from "lucide-vue-next";

const props = defineProps({ review: { type: Object, default: null } });
const emit = defineEmits(["close"]);

const typeLabels = {
  money: "金额", ratio: "比例", duration: "期限", party: "主体", obligation: "义务",
  penalty: "违约责任", condition: "条件", date: "日期", reference: "引用", clause: "条款"
};
// 丢弃原因的用户可读解释：区分"模型编造"与"本地校验未通过"，避免用户误以为抽取坏了。
const reasonLabels = {
  block_not_in_batch: { label: "来源块不在本次请求范围", hint: "模型引用了未提供的块号；属于模型输出错位，已丢弃。" },
  quote_not_found: { label: "原文中不存在该引文", hint: "模型给出的原文片段在合同里找不到；属于编造引用，已丢弃。" },
  clause_mismatch: { label: "条款号与原文不符", hint: "模型标注的条款号与原文实际归属不一致，已丢弃。" },
  value_mismatch: { label: "数值与引文不一致", hint: "模型自报数值与引文实际数值不同，已丢弃。" },
  obligation_incomplete: { label: "义务事实不完整", hint: "缺少义务方或动作，无法形成可用事实。" },
  party_incomplete: { label: "主体事实不完整", hint: "缺少主体名称与住所。" },
  unknown_type: { label: "事实类型不受支持", hint: "模型返回了约定之外的类型。" },
  quote_missing: { label: "缺少原文引文", hint: "没有 raw_text，无法核验。" },
  invalid_shape: { label: "候选结构无效", hint: "返回内容不是对象。" }
};

const keyword = ref("");
const filterType = ref("all");
const filterOrigin = ref("all");

const facts = computed(() => (props.review?.contract_facts || []).map((fact) => ({
  ...fact,
  origin: fact.origin || "rules",
  location: fact.source_refs?.[0] || {}
})));

const filtered = computed(() => {
  const term = keyword.value.trim();
  return facts.value.filter((fact) => {
    if (filterType.value !== "all" && fact.fact_type !== filterType.value) return false;
    if (filterOrigin.value !== "all" && fact.origin !== filterOrigin.value) return false;
    if (!term) return true;
    return [fact.raw_text, fact.value, fact.clause_no, fact.value_span].some((value) => String(value ?? "").includes(term));
  });
});

const typeOptions = computed(() => {
  const types = new Map();
  for (const fact of facts.value) types.set(fact.fact_type, (types.get(fact.fact_type) || 0) + 1);
  return [...types.entries()].map(([type, count]) => ({ type, count, label: typeLabels[type] || type }));
});

const summary = computed(() => props.review?.execution_summary?.extraction || null);
const rulesCount = computed(() => facts.value.filter((fact) => fact.origin !== "model").length);
const modelCount = computed(() => facts.value.filter((fact) => fact.origin === "model").length);
const rejectionReasons = computed(() => {
  const reasons = summary.value?.rejection_reasons || {};
  return Object.entries(reasons).map(([reason, count]) => ({
    reason, count,
    label: reasonLabels[reason]?.label || reason,
    hint: reasonLabels[reason]?.hint || "",
    types: Object.entries(summary.value?.rejected_fact_types || {}).map(([type, n]) => `${typeLabels[type] || type} ${n}`).join("、")
  })).sort((left, right) => right.count - left.count);
});

function typeLabel(type) { return typeLabels[type] || type; }
function displayValue(fact) {
  if (fact.fact_type === "duration" && fact.calendar_type) return `${fact.value} ${fact.unit || ""}（${fact.calendar_type}）`.trim();
  if (fact.fact_type === "money") return `${fact.value}${fact.currency ? " " + fact.currency : ""}`;
  return fact.value ?? "";
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal wide extraction-modal" role="dialog" aria-modal="true" aria-label="条款与事实抽取核验">
      <header class="modal-header">
        <div class="settings-card-icon"><ClipboardList :size="18" /></div>
        <div>
          <h2>条款与事实抽取核验</h2>
          <p class="modal-subtitle">
            共 {{ facts.length }} 条事实（规则 {{ rulesCount }} · 模型 {{ modelCount }}）<template v-if="summary">，模型调用 {{ summary.call_count || 0 }} 次</template>
          </p>
        </div>
        <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="emit('close')"><X :size="16" /></button>
      </header>

      <div class="modal-content">
        <div v-if="!facts.length" class="extraction-empty">
          <AlertTriangle :size="20" />
          <p>当前审查还没有抽取事实。请先执行合同审查，或在能力配置中确认条款抽取模型已启用。</p>
        </div>

        <template v-else>
          <div class="extraction-filters">
            <label class="extraction-search"><Search :size="14" /><input v-model="keyword" type="search" placeholder="搜索原文、数值或条款号" aria-label="搜索事实" /></label>
            <label class="extraction-select"><Filter :size="14" /><select v-model="filterType" aria-label="按类型筛选"><option value="all">全部类型（{{ facts.length }}）</option><option v-for="option in typeOptions" :key="option.type" :value="option.type">{{ option.label }}（{{ option.count }}）</option></select></label>
            <label class="extraction-select"><select v-model="filterOrigin" aria-label="按来源筛选"><option value="all">全部来源</option><option value="rules">规则抽取</option><option value="model">模型抽取</option></select></label>
            <span class="extraction-count">显示 {{ filtered.length }} 条</span>
          </div>

          <div class="table-wrap extraction-table-wrap">
            <table class="data-table extraction-table">
              <thead><tr><th>类型</th><th>解析值</th><th>原文引文</th><th>条款号</th><th>来源</th><th>原文位置</th></tr></thead>
              <tbody>
                <tr v-for="fact in filtered" :key="fact.fact_id || `${fact.fact_type}-${fact.raw_text}`">
                  <td><span class="badge" :class="fact.origin === 'model' ? 'badge-primary' : 'badge-muted'">{{ typeLabel(fact.fact_type) }}</span></td>
                  <td class="mono extraction-value">{{ displayValue(fact) }}</td>
                  <td class="extraction-quote">{{ fact.raw_text }}<small v-if="fact.value_span">数值片段：{{ fact.value_span }}</small></td>
                  <td class="mono">{{ fact.clause_no || "-" }}</td>
                  <td>{{ fact.origin === "model" ? "模型" : "规则" }}</td>
                  <td class="mono muted-text">{{ fact.location.block_id || "未定位" }}<template v-if="fact.location.logical_page"> · 逻辑页 {{ fact.location.logical_page }}</template></td>
                </tr>
                <tr v-if="!filtered.length"><td colspan="6" class="empty-cell">没有符合条件的事实</td></tr>
              </tbody>
            </table>
          </div>

          <section v-if="summary" class="extraction-diagnostics">
            <h3>抽取过程说明</h3>
            <ul class="extraction-stats">
              <li><span>规则抽取</span><strong>{{ summary.baseline_fact_count || 0 }} 条</strong></li>
              <li><span>模型采纳</span><strong>{{ summary.accepted_fact_count || 0 }} 条</strong></li>
              <li><span>与规则重复合并</span><strong>{{ summary.duplicate_fact_count || 0 }} 条</strong></li>
              <li><span>校验未通过丢弃</span><strong>{{ summary.rejected_fact_count || 0 }} 条</strong></li>
              <li><span>类型不在抽取范围</span><strong>{{ summary.out_of_scope_fact_count || 0 }} 条</strong></li>
            </ul>

            <div v-if="rejectionReasons.length" class="extraction-reasons">
              <p class="extraction-reasons-title"><AlertTriangle :size="14" />丢弃原因分布<span>这些条目没有进入风险分析，逐项原因如下</span></p>
              <ul>
                <li v-for="item in rejectionReasons" :key="item.reason">
                  <strong>{{ item.label }}：{{ item.count }} 条</strong>
                  <p>{{ item.hint }}</p>
                  <small v-if="item.types">涉及类型：{{ item.types }}</small>
                </li>
              </ul>
            </div>
            <p v-else class="extraction-reasons-ok"><Check :size="14" />没有因校验未通过被丢弃的事实。</p>

            <p class="extraction-note">
              说明：被丢弃<b>不等于</b>抽取失败。若原因是"原文中不存在该引文"或"数值与引文不一致"，
              说明本地校验拦住了模型编造的内容；这类条目不应进入风险清单。
            </p>
          </section>
        </template>
      </div>

      <footer class="modal-footer">
        <button class="button" type="button" @click="emit('close')">关闭</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.extraction-modal { width: min(1080px, 96vw); }
.extraction-empty { display: flex; align-items: center; gap: 10px; padding: 18px; border: 1px dashed var(--border-strong); border-radius: 8px; color: var(--text-muted); }
.extraction-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.extraction-search { display: flex; min-width: 240px; flex: 1; align-items: center; gap: 6px; padding: 0 9px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); }
.extraction-search input { width: 100%; height: 32px; border: 0; outline: 0; background: transparent; font-size: 12px; }
.extraction-select { display: flex; align-items: center; gap: 6px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
.extraction-select select { height: 32px; border: 0; outline: 0; background: transparent; color: var(--text-muted); font-size: 12px; }
.extraction-count { color: var(--text-light); font-size: 11px; }
.extraction-table-wrap { max-height: 46vh; overflow: auto; }
.extraction-table { min-width: 820px; }
.extraction-value { white-space: nowrap; }
.extraction-quote { max-width: 380px; line-height: 1.6; }
.extraction-quote small { display: block; margin-top: 3px; color: var(--text-light); font-family: var(--mono); font-size: 10px; }
.extraction-diagnostics { margin-top: 16px; padding: 13px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-muted); }
.extraction-diagnostics h3 { margin: 0 0 9px; font-size: 13px; }
.extraction-stats { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0; padding: 0; list-style: none; }
.extraction-stats li { display: flex; align-items: baseline; gap: 6px; font-size: 11.5px; }
.extraction-stats span { color: var(--text-light); }
.extraction-stats strong { font-family: var(--mono); }
.extraction-reasons { margin-top: 12px; padding-top: 11px; border-top: 1px solid var(--border); }
.extraction-reasons-title { display: flex; align-items: center; gap: 6px; margin: 0 0 7px; color: #9a531a; font-size: 12px; font-weight: 600; }
.extraction-reasons-title span { color: var(--text-light); font-weight: 400; font-size: 10.5px; }
.extraction-reasons ul { margin: 0; padding: 0; list-style: none; }
.extraction-reasons li { padding: 7px 0; border-top: 1px dashed var(--border); }
.extraction-reasons li:first-child { border-top: 0; }
.extraction-reasons li strong { font-size: 11.5px; }
.extraction-reasons li p { margin: 3px 0 0; color: var(--text-muted); font-size: 11px; line-height: 1.6; }
.extraction-reasons li small { color: var(--text-light); font-size: 10.5px; }
.extraction-reasons-ok { display: flex; align-items: center; gap: 6px; margin: 12px 0 0; color: var(--green); font-size: 11.5px; }
.extraction-note { margin: 12px 0 0; padding: 9px 10px; border-left: 3px solid var(--primary); border-radius: 5px; color: var(--text-muted); background: var(--surface); font-size: 11px; line-height: 1.7; }
</style>
