<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AlertCircle, Bot, Check, ChevronDown, ChevronUp, LoaderCircle } from "lucide-vue-next";

const props = defineProps({ summary: { type: Object, required: true }, role: { type: String, default: "extraction" }, active: { type: Boolean, default: false }, cancelling: { type: Boolean, default: false } });
const expanded = ref(props.active);
const analysis = computed(() => props.role === "analysis");
const title = computed(() => analysis.value ? "语义分析" : "条款抽取");
const now = ref(Date.now());
let timer;
const running = computed(() => props.active && !props.cancelling && ["pending", "running"].includes(props.summary.status));
const interrupted = computed(() => !running.value && !props.cancelling && props.summary.status === "running");
const warning = computed(() => interrupted.value || ["partial", "degraded", "failed"].includes(props.summary.status) || props.summary.context?.truncated_pages?.length > 0);
const count = (value) => Math.max(0, Math.floor(Number(value) || 0));
const totalBatches = computed(() => count(props.summary.total_batches));
const completedBatches = computed(() => Math.min(count(props.summary.completed_batches), totalBatches.value));
const batch = computed(() => Math.min(count(props.summary.current_batch) || completedBatches.value + 1, totalBatches.value));
const percent = computed(() => totalBatches.value ? Math.round(completedBatches.value / totalBatches.value * 100) : 0);
const recentFacts = computed(() => (props.summary.recent_facts || []).slice(-5).reverse());
const recentRisks = computed(() => (props.summary.recent_risks || []).slice(-5).reverse());
const typeLabels = { money: "金额", ratio: "比例", duration: "期限", party: "主体", obligation: "义务", penalty: "违约责任", condition: "条件", date: "日期", reference: "引用", clause: "条款" };
const statusLabel = computed(() => props.cancelling ? "正在停止" : running.value ? "进行中" : interrupted.value ? "已中断" : ({
  pending: "待开始", completed: "已完成", partial: "部分完成", degraded: "已降级", failed: "未完成", cancelled: "已取消", not_configured: analysis.value ? "未调用" : "规则抽取"
})[props.summary.status] || "待开始");
const message = computed(() => {
  if (props.cancelling) return "正在停止模型请求，已收到的完整结果会保留。";
  if (analysis.value) {
    if (interrupted.value) return "语义分析已中断，已接收的完整风险仍保留。";
    if (running.value) {
      if (props.summary.phase === "preparing") return "正在整理合同、事实和检索依据。";
      const batchLabel = props.summary.total_batches ? `第 ${count(props.summary.current_batch)}/${count(props.summary.total_batches)} 批 · ` : "";
      if (props.summary.phase === "receiving") return `${batchLabel}正在接收模型输出：已收到约 ${count(props.summary.received_char_count)} 字，已识别 ${count(props.summary.received_risk_count)} 条候选。`;
      return `${batchLabel}已提交语义分析请求，等待模型返回首个片段。`;
    }
    if (props.summary.status === "completed") return `语义分析完成，共收到 ${count(props.summary.received_risk_count)} 条模型候选风险，待人工核验。`;
    if (props.summary.status === "cancelled") return `语义分析已被用户停止，保留 ${count(props.summary.received_risk_count)} 条完整模型候选。`;
    if (props.summary.status === "failed") return `语义分析未完成，已保留 ${count(props.summary.received_risk_count)} 条完整模型候选和本地检查结果。`;
    if (props.summary.status === "not_configured") return "未配置可用的语义分析模型，本次仅保留本地检查结果。";
    return "等待语义分析。";
  }
  if (interrupted.value) return "抽取已中断，已接收的过程摘要仍保留。";
  if (running.value) {
    if (!totalBatches.value) return "正在整理合同原文，准备分批抽取。";
    if (props.summary.phase === "validating") return `第 ${batch.value} 批已返回，正在校验引文与数值。`;
    if (props.summary.phase === "batch_completed") return `第 ${completedBatches.value} 批已完成原文校验。`;
    if (props.summary.phase === "receiving") return `第 ${batch.value} / ${totalBatches.value} 批正在接收模型输出，已收到约 ${count(props.summary.received_char_count)} 字。`;
    return `正在抽取第 ${batch.value} / ${totalBatches.value} 批，已提交请求，等待模型返回首个片段。`;
  }
  if (props.summary.status === "degraded") return "模型抽取未全部完成，已保留规则事实和通过原文校验的模型事实。";
  if (props.summary.status === "partial") return "抽取完成，部分候选未通过原文或数值校验，未纳入审查。";
  if (props.summary.status === "cancelled") return "条款抽取已被用户停止，已保留规则事实。";
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
// 距离"空闲超时"还有多久：让用户能区分"模型在慢慢想"和"请求已经卡住"。
const lastOutputAt = computed(() => Number.isFinite(Date.parse(props.summary.last_delta_at || ""))
  ? props.summary.last_delta_at
  : Number.isFinite(Date.parse(props.summary.current_source ? props.summary.batch_started_at || "" : ""))
    ? props.summary.batch_started_at
    : props.summary.started_at);
const silenceSeconds = computed(() => {
  if (!running.value) return 0;
  const base = Date.parse(lastOutputAt.value || "");
  if (!Number.isFinite(base)) return 0;
  return Math.max(0, Math.floor((now.value - base) / 1000));
});
const idleTimeoutSeconds = computed(() => Math.round(Math.max(Number(props.summary.timeout_ms) || 0, 0) / 1000));
const waitingForFirstDelta = computed(() => running.value && !props.summary.first_delta_at);
const sourceLabel = computed(() => {
  const source = props.summary.current_source || {};
  return [source.page ? `第 ${source.page} 页` : source.logical_page ? `逻辑页 ${source.logical_page}` : "原文块", source.clause_no].filter(Boolean).join(" · ");
});
// 推理时间线：由主进程上报的结构化事件渲染，只包含阶段、计数和已验证摘要，没有模型原始输出。
const activityEventLabels = {
  preparing: "整理输入", requesting: "已提交模型请求", receiving: "正在接收模型输出",
  validating: "校验引文与数值", batch_completed: "本批抽取完成", first_delta: "收到首个输出片段",
  risk_received: "识别到候选风险", finished: "阶段结束", context_error: "上下文不足",
  local_checks_done: "本地确定性检查完成", retrieval_done: "依据检索完成"
};
const timeline = computed(() => (props.summary.activities || []).slice(-8).reverse());
function activityLabel(entry) {
  return activityEventLabels[entry.event] || entry.event;
}
function activityDetail(entry) {
  if (entry.event === "risk_received") return `${entry.title || "候选风险"}${entry.location_status === "unresolved" ? " · 原文待定位" : " · 原文已定位"}`;
  if (entry.event === "retrieval_done") return `状态 ${entry.status || "unknown"} · 查询 ${count(entry.query_count)} · 缓存命中 ${count(entry.cache_hit_count)}`;
  if (entry.event === "finished") return `收到候选 ${count(entry.received_risk_count)} 条 · 输出约 ${count(entry.received_char_count)} 字`;
  const parts = [];
  if (entry.batch) parts.push(`第 ${entry.batch}${entry.total_batches ? ` / ${entry.total_batches}` : ""} 批`);
  if (entry.received_char_count) parts.push(`已接收约 ${count(entry.received_char_count)} 字`);
  if (entry.reasoning_char_count) parts.push(`推理活跃 ${count(entry.reasoning_char_count)} 字`);
  if (entry.clause_no) parts.push(entry.clause_no);
  return parts.join(" · ");
}
function activityTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleTimeString("zh-CN", { hour12: false });
}
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
      <div v-if="running && (summary.received_char_count || summary.reasoning_char_count || silenceSeconds >= 10)" class="extraction-ticker" aria-live="off">
        <span v-if="!analysis && totalBatches">第 {{ batch }}/{{ totalBatches }} 批</span>
        <span>已接收 <b>{{ count(summary.received_char_count) }}</b> 字</span>
        <span v-if="summary.reasoning_char_count">推理活跃 <b>{{ count(summary.reasoning_char_count) }}</b> 字</span>
        <span v-if="summary.first_delta_at">首段响应 {{ activityTime(summary.first_delta_at) }}</span>
        <span v-else-if="silenceSeconds >= 10" class="ticker-waiting">{{ waitingForFirstDelta ? "等待首段响应" : "等待新内容" }} {{ silenceSeconds }} 秒<span v-if="idleTimeoutSeconds"> · {{ idleTimeoutSeconds }} 秒无响应判定超时</span></span>
      </div>
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
        <span>合同 <b>{{ count(summary.context.page_count) }}</b> 页</span><span>事实 <b>{{ count(summary.context.included_fact_count) }}/{{ count(summary.context.total_fact_count ?? summary.context.included_fact_count) }}</b></span><span>检索依据 <b>{{ count(summary.context.included_evidence_count) }}/{{ count(summary.context.total_evidence_count ?? summary.context.included_evidence_count) }}</b></span><span v-if="summary.context.submitted_batches">补审批次 <b>{{ count(summary.context.completed_batches) }}/{{ count(summary.context.submitted_batches) }}</b></span>
      </div>
      <p v-if="analysis && summary.context?.truncated_pages?.length" class="extraction-error">{{ summary.context.truncated_pages.length }} 页原文有删节，未覆盖全部内容。</p>
      <p v-if="summary.message" class="extraction-error">{{ summary.message }}</p>
      <div v-if="expanded" class="extraction-details">
        <div v-if="timeline.length" class="extraction-timeline">
          <small>推理时间线 · 仅结构化进展，不含模型原始输出</small>
          <ol>
            <li v-for="entry in timeline" :key="entry.activity_id + entry.at"><span class="timeline-dot" :class="`timeline-${entry.event}`"></span><div><strong>{{ activityLabel(entry) }}</strong><em v-if="activityTime(entry.at)">{{ activityTime(entry.at) }}</em><p v-if="activityDetail(entry)">{{ activityDetail(entry) }}</p></div></li>
          </ol>
        </div>
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
        <p v-if="summary.truncated_batch_count" class="extraction-validation">有 {{ count(summary.truncated_batch_count) }} 批输出达到长度上限：已将输出预算提高到 {{ count(summary.max_output_tokens_used) }} token 重试<span v-if="summary.split_batch_count">，并对 {{ count(summary.split_batch_count) }} 个批次做了拆分</span></p>
        <p v-if="summary.budget_escalation_count" class="extraction-validation">输出预算共提高 {{ count(summary.budget_escalation_count) }} 次（上限 {{ count(summary.output_token_budget_ceiling) }} token）。若仍频繁出现，请提高抽取模型的输出预算或改用非推理模型。</p>
      </div>
    </div>
  </article>
</template>
