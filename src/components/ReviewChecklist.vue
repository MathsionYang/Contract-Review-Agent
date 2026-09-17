<script setup>
import { computed, reactive, ref, watch } from "vue";
import { Save, ScanSearch, Search } from "lucide-vue-next";
import { useReviewStore } from "../stores/review";
import { checklistLayers, checklistStatuses, locationLabel } from "../services/checklistReview.mjs";

const store = useReviewStore();
const emit = defineEmits(["locate", "select-risk"]);
const layer = ref("all");
const status = ref("all");
const query = ref("");
const drafts = reactive({});
const saving = ref(false);
const checks = computed(() => store.review?.checklist_results || []);
const coverage = computed(() => store.review?.checklist_coverage || {});
const visible = computed(() => checks.value.filter((item) => (layer.value === "all" || item.layer === layer.value)
  && (status.value === "all" || item.status === status.value)
  && `${item.check_id} ${item.title} ${item.criterion} ${item.message}`.includes(query.value.trim())));
const humanCount = computed(() => checks.value.filter((item) => ["pass", "not_applicable"].includes(item.human_review?.outcome)).length);
const methods = { text_screening: "文本筛查", deterministic_mapping: "专项检查", external_verification: "外部核验", semantic_review: "语义复核" };
watch([() => store.activeProject?.project_id, checks], () => { for (const key of Object.keys(drafts)) delete drafts[key]; });
function edit(item) {
  return drafts[item.check_id] ||= { outcome: item.human_review?.outcome || "unverifiable", reviewer: item.human_review?.reviewer || "", evidence: item.human_review?.evidence || "", note: item.human_review?.note || "" };
}
function relatedRisks(item) {
  return store.risks.filter((risk) => risk.checklist_ids?.includes(item.check_id));
}
async function save(item) {
  saving.value = true;
  try { await store.saveChecklistReview(item.check_id, edit(item)); }
  catch (error) { store.notify(error.message || "复核保存失败", "warn"); }
  finally { saving.value = false; }
}
</script>

<template>
  <div class="checklist-view">
    <div class="checklist-summary" aria-live="polite">
      <span>通用 <b>{{ checks.length }}</b></span><span>专项 <b>{{ store.review?.check_results?.length || 0 }}</b></span>
      <span>冲突 <b>{{ coverage.conflict || 0 }}</b></span><span>缺项 <b>{{ coverage.missing || 0 }}</b></span>
      <span>待核验 <b>{{ coverage.unverifiable || 0 }}</b></span><span>人工复核 <b>{{ humanCount }}</b></span>
    </div>
    <div class="checklist-filters">
      <select v-model="layer" aria-label="筛选审查层级"><option value="all">全部层级</option><option v-for="(label, key) in checklistLayers" :key="key" :value="key">{{ key }} {{ label }}</option></select>
      <select v-model="status" aria-label="筛选检查状态"><option value="all">全部状态</option><option v-for="(label, key) in checklistStatuses" :key="key" :value="key">{{ label }}</option></select>
      <label class="checklist-search"><Search :size="14" /><input v-model="query" type="search" placeholder="编号或检查项" aria-label="搜索检查项" /></label>
    </div>
    <div class="checklist-results">
      <p v-if="!checks.length" class="checklist-empty">当前版本无通用清单结果</p>
      <p v-else-if="!visible.length" class="checklist-empty">无匹配检查项</p>
      <details v-for="item in visible" :key="item.check_id" class="checklist-item">
        <summary><span class="checklist-id">{{ item.check_id }}</span><strong>{{ item.title }}</strong><span class="checklist-status" :class="'checklist-' + item.status">{{ checklistStatuses[item.status] || item.status }}</span></summary>
        <div class="checklist-item-body">
          <dl>
            <dt>判据</dt><dd>{{ item.criterion }}</dd>
            <dt>结果</dt><dd>{{ item.message }}</dd>
            <dt>方式</dt><dd>{{ methods[item.method] || item.method }} · {{ item.severity === 'high' ? '高' : item.severity === 'medium' ? '中' : '低' }}风险</dd>
            <dt>适用</dt><dd>{{ item.applicability }}</dd>
            <dt>证据要求</dt><dd>{{ item.evidence_requirement }}</dd>
            <template v-if="item.required_materials?.length"><dt>待核材料</dt><dd>{{ item.required_materials.join('；') }}</dd></template>
          </dl>
          <div v-for="(source, index) in item.source_refs || []" :key="source.block_id + ':' + index" class="checklist-evidence">
            <button class="text-action" type="button" @click="emit('locate', source)"><ScanSearch :size="13" />{{ locationLabel(source) }}</button>
            <blockquote>{{ source.quote }}</blockquote>
          </div>
          <p v-if="!item.source_refs?.length" class="checklist-scope">全文检查范围 · {{ item.search_scope?.block_ids?.length || 0 }} 个逻辑块 · 无单一条款锚点</p>
          <div class="checklist-links"><button v-for="risk in relatedRisks(item)" :key="risk.risk_id" class="text-action" type="button" @click="emit('select-risk', risk)"><ScanSearch :size="13" />{{ risk.title }}</button></div>
          <form class="checklist-review-form" @submit.prevent="save(item)">
            <strong>人工复核</strong>
            <small v-if="item.human_review">{{ item.human_review.reviewer }} · {{ new Date(item.human_review.reviewed_at).toLocaleString() }}</small>
            <label>结论<select v-model="edit(item).outcome" aria-label="人工复核结论"><option value="unverifiable">待核验</option><option value="pass">复核通过</option><option value="not_applicable">确认不适用</option></select></label>
            <label>复核人<input v-model="edit(item).reviewer" required maxlength="100" aria-label="复核人" /></label>
            <label>材料依据<input v-model="edit(item).evidence" required maxlength="2000" aria-label="材料依据" /></label>
            <label>复核说明<textarea v-model="edit(item).note" required rows="2" maxlength="4000" aria-label="复核说明"></textarea></label>
            <button class="text-action" type="submit" :disabled="saving || store.isBusy || store.chatBusy"><Save :size="14" />保存复核</button>
          </form>
        </div>
      </details>
    </div>
    <footer class="checklist-footer">{{ visible.length }} / {{ checks.length }} 项 · {{ store.review?.checklist_version || '无清单版本' }}</footer>
  </div>
</template>
