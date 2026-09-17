<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AlertCircle, Bot, Check, ChevronDown, ChevronUp, LoaderCircle } from "lucide-vue-next";

const props = defineProps({ summary: { type: Object, required: true }, role: { type: String, default: "extraction" }, active: { type: Boolean, default: false } });
const expanded = ref(props.active);
const analysis = computed(() => props.role === "analysis");
const title = computed(() => analysis.value ? "语义分析" : "条款抽取");
const now = ref(Date.now());
let timer;
const running = computed(() => props.active && ["pending", "running"].includes(props.summary.status));
const interrupted = computed(() => !props.active && props.summary.status === "running");
const warning = computed(() => interrupted.value || ["partial", "degraded", "failed"].includes(props.summary.status) || props.summary.context?.truncated_pages?.length > 0);
const count = (value) => Math.max(0, Math.floor(Number(value) || 0));
const totalBatches = computed(() => count(props.summary.total_batches));
const completedBatches = computed(() => Math.min(count(props.summary.completed_batches), totalBatches.value));
const batch = computed(() => Math.min(count(props.summary.current_batch) || completedBatches.value + 1, totalBatches.value));
const percent = computed(() => totalBatches.value ? Math.round(completedBatches.value / totalBatches.value * 100) : 0);
const recentFacts = computed(() => (props.summary.recent_facts || []).slice(-5).reverse());
const recentRisks = computed(() => (props.summary.recent_risks || []).slice(-5).reverse());
const typeLabels = { money: "金额", ratio: "比例", duration: "期限", party: "主体", obligation: "义务", penalty: "违约责任", condition: "条件", date: "日期", reference: "引用", clause: "条款" };
const statusLabel = computed(() => running.value ? "进行中" : interrupted.value ? "已中断" : ({
  pending: "待开始", completed: "已完成", partial: "部分完成", degraded: "已降级", failed: "未完成", not_configured: analysis.value ? "未调用" : "规则抽取"
})[props.summary.status] || "待开始");
const message = computed(() => {
  if (analysis.value) {
    if (interrupted.value) return "语义分析已中断，已接收的完整风险仍保留。";
    if (running.value) {
      if (props.summary.phase === "preparing") return "正在整理合同、事实和检索依据。";
      if (props.summary.phase === "receiving") return `已接收模型响应，正在整理风险；已识别 ${count(props.summary.received_risk_count)} 条候选。`;
      return "已提交语义分析请求，等待模型返回。";
    }
    if (props.summary.status === "completed") return `语义分析完成，共收到 ${count(props.summary.received_risk_count)} 条模型候选风险，待人工核验。`;
    if (props.summary.status === "failed") return `语义分析未完成，已保留 ${count(props.summary.received_risk_count)} 条完整模型候选和本地检查结果。`;
    if (props.summary.status === "not_configured") return "未配置可用的语义分析模型，本次仅保留本地检查结果。";
    return "等待语义分析。";
  }
  if (interrupted.value) return "抽取已中断，已接收的过程摘要仍保留。";
  if (running.value) {
    if (!totalBatches.value) return "正在整理合同原文，准备分批抽取。";
    if (props.summary.phase === "validating") return `第 ${batch.value} 批已返回，正在校验引文与数值。`;
    if (props.summary.phase === "batch_completed") return `第 ${completedBatches.value} 批已完成原文校验。`;
    return `正在抽取第 ${batch.value} / ${totalBatches.value} 批，等待模型返回。`;
  }
  if (props.summary.status === "degraded") return "模型抽取未全部完成，已保留规则事实和通过原文校验的模型事实。";
  if (props.summary.status === "partial") return "抽取完成，部分候选未通过原文或数值校验，未纳入审查。";
  if (props.summary.status === "not_configured") return "未配置可用的条款抽取模型，本次使用本地规则抽取。";
  if (props.summary.status === "completed") return "条款抽取完成，结果已交给后续风险审查。";
  return "等待条款抽取。";
});
const elapsed = computed(() => {
  const start = Date.parse(props.summary.started_at);
  const end = running.value ? now.value : Date.parse(props.summary.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
});
const sourceLabel = computed(() => {
  const source = props.summary.current_source || {};
  return [source.page ? `第 ${source.page} 页` : source.logical_page ? `逻辑页 ${source.logical_page}` : "原文块", source.clause_no].filter(Boolean).join(" · ");
});
onMounted(() => {
  watch(running, (value, previous) => {
    clearInterval(timer);
    now.value = Date.now();
    if (previous !== undefined && value !== previous) expanded.value = value;
    if (value) timer = setInterval(() => { now.value = Date.now(); }, 1000);
  }, { immediate: true });
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <article class="chat-message extraction-activity" :aria-label="`${title}过程`" :class="{ 'extraction-warning': warning }">
    <span class="chat-avatar"><Bot :size="15" /></span>
    <div class="chat-message-main extraction-message">
      <header class="extraction-heading">
        <strong>{{ title }}</strong>
        <span class="extraction-state"><LoaderCircle v-if="running" class="spin" :size="12" /><AlertCircle v-else-if="warning" :size="12" /><Check v-else-if="summary.status === 'completed' || summary.status === 'not_configured'" :size="12" />{{ statusLabel }}</span>
        <button class="icon-button small" type="button" :title="`${expanded ? '收起' : '展开'}${title}详情`" :aria-label="`${expanded ? '收起' : '展开'}${title}详情`" :aria-expanded="expanded" @click="expanded = !expanded"><ChevronUp v-if="expanded" :size="14" /><ChevronDown v-else :size="14" /></button>
      </header>
      <p class="extraction-description" role="status">{{ message }}</p>
      <div class="extraction-meta"><span>{{ summary.model_name || (analysis ? '未配置模型' : '本地规则') }}</span><span v-if="elapsed" aria-live="off">{{ running ? '已用时' : '用时' }} {{ elapsed }}</span></div>
      <div v-if="!analysis && totalBatches && expanded" class="extraction-progress">
        <progress :value="completedBatches" :max="totalBatches" aria-label="已完成抽取批次" />
        <span>{{ completedBatches }}/{{ totalBatches }} 批 · {{ percent }}%</span>
      </div>
      <div v-if="!analysis && expanded" class="extraction-counts">
        <span>规则事实 <b>{{ count(summary.baseline_fact_count) }}</b></span>
        <span>模型新增 <b>{{ count(summary.accepted_fact_count) }}</b></span>
        <span>合计 <b>{{ count(summary.total_fact_count ?? (count(summary.baseline_fact_count) + count(summary.accepted_fact_count))) }}</b></span>
      </div>
      <div v-if="analysis && expanded && summary.context" class="extraction-counts">
        <span>合同 <b>{{ count(summary.context.page_count) }}</b> 页</span><span>事实 <b>{{ count(summary.context.included_fact_count) }}</b></span><span>检索依据 <b>{{ count(summary.context.included_evidence_count) }}</b></span>
      </div>
      <p v-if="analysis && summary.context?.truncated_pages?.length" class="extraction-error">{{ summary.context.truncated_pages.length }} 页原文有删节，未覆盖全部内容。</p>
      <p v-if="summary.message" class="extraction-error">{{ summary.message }}</p>
      <div v-if="expanded" class="extraction-details">
        <div v-if="running && summary.current_source?.quote" class="extraction-source">
          <small>当前原文 · {{ sourceLabel }}</small>
          <blockquote>{{ summary.current_source.quote }}</blockquote>
        </div>
        <div v-if="analysis && recentRisks.length" class="extraction-facts analysis-recent-risks">
          <small>最近识别 · 待人工核验</small>
          <ul>
            <li v-for="risk in recentRisks" :key="risk.risk_id"><div><span>{{ risk.title }}</span><small>{{ risk.location_status === 'resolved' ? risk.clause_no || '原文已定位' : '原文待定位' }}</small></div><p v-if="risk.quote">{{ risk.quote }}</p></li>
          </ul>
        </div>
        <div v-if="recentFacts.length" class="extraction-facts">
          <small>最近抽取 · 通过原文校验，待业务核验</small>
          <ul>
            <li v-for="fact in recentFacts" :key="fact.fact_id"><div><span>{{ typeLabels[fact.fact_type] || '事实' }}</span><small>{{ fact.clause_no || '未编号条款' }}</small></div><p>{{ fact.quote }}</p></li>
          </ul>
        </div>
        <p v-if="summary.duplicate_fact_count || summary.rejected_fact_count" class="extraction-validation">已去重 {{ count(summary.duplicate_fact_count) }} 条 · 未通过校验 {{ count(summary.rejected_fact_count) }} 条</p>
      </div>
    </div>
  </article>
</template>
