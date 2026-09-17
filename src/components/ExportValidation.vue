<script setup>
import { computed } from "vue";
import { AlertTriangle, CheckCircle2, LoaderCircle, ShieldX } from "lucide-vue-next";

const props = defineProps({ validation: { type: Object, default: null }, loading: Boolean });
const issues = computed(() => (props.validation?.items || []).filter((item) => item.status !== "passed"));
const heading = computed(() => {
  if (props.loading) return "校验中...";
  if (!props.validation) return "尚未取得校验结果";
  if (!props.validation.canExport) return "存在阻断项，暂不可导出";
  if (props.validation.mode === "draft") return `可导出草稿，${issues.value.length} 项待核验`;
  return "校验通过，可导出正式报告";
});
</script>

<template>
  <section class="export-validation" :class="{ blocked: validation && !validation.canExport, warning: validation?.canExport && issues.length }" aria-live="polite">
    <div class="export-validation-heading">
      <LoaderCircle v-if="loading" class="spin" :size="18" />
      <ShieldX v-else-if="validation && !validation.canExport" :size="18" />
      <AlertTriangle v-else-if="issues.length" :size="18" />
      <CheckCircle2 v-else-if="validation?.canExport" :size="18" />
      <strong>{{ heading }}</strong>
    </div>
    <p v-if="validation?.mode === 'draft'" class="export-draft-notice">草稿 / 待核验，不代表已完成法务确认，不得作为正式审查结论。</p>
    <ul v-if="issues.length" class="export-issues">
      <li v-for="(item, index) in issues" :key="`${item.id}-${index}`">
        <strong>{{ item.status === 'warning' ? '待核验' : '阻断' }} · {{ item.label }}<span v-if="item.riskId"> · {{ item.riskId }}</span></strong>
        <p>{{ item.message }}</p>
        <p v-if="item.suggestion">{{ item.suggestion }}</p>
        <code>{{ item.code }}</code>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.export-validation { padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-muted); }
.export-validation.blocked { border-color: #edb8b5; }
.export-validation.warning { border-color: #e5cf95; }
.export-validation-heading { display: flex; align-items: center; gap: 8px; }
.export-validation-heading svg { flex-shrink: 0; }
.blocked .export-validation-heading { color: var(--red); }
.warning .export-validation-heading { color: var(--amber); }
.export-draft-notice { margin: 8px 0 0; color: var(--text-muted); }
.export-issues { max-height: 280px; overflow: auto; margin: 10px 0 0; padding: 0; list-style: none; }
.export-issues li { padding: 10px 0; border-top: 1px solid var(--border); overflow-wrap: anywhere; }
.export-issues strong { font-size: 12px; }
.export-issues p { margin: 4px 0; font-size: 12px; color: var(--text-muted); }
.export-issues code { font-size: 10px; color: var(--text-light); }
</style>
