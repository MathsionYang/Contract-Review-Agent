<script setup>
import { computed, ref } from "vue";
import { ArrowRight, CheckCircle2, Clock3, FileStack, LoaderCircle, RefreshCw, ShieldAlert, Plus, Trash2 } from "lucide-vue-next";
import { useReviewStore } from "../stores/review";
import { contractTypes, statusLabels } from "../data/sampleData";
import Modal from "./Modal.vue";

const emit = defineEmits(["new-review", "open-review"]);
const store = useReviewStore();
const taskFilter = ref("all");
const deleteTarget = ref(null);
const deleting = ref(false);
const deleteError = ref("");
const actionsLocked = computed(() => !store.isReady || store.isBusy || store.chatBusy);

const tasks = computed(() => {
  return store.state.projects.map((project) => {
    const review = store.state.reviews[project.project_id];
    const risks = review?.risks || [];
    return {
      id: project.project_id,
      name: project.project_name || project.file_name || project.project_id,
      type: project.contract_type,
      fileVersionId: project.file_version_id,
      status: review?.task?.status || "waiting_confirmation",
      progress: Math.min(100, Math.max(0, Number(review?.task?.progress) || 0)),
      riskCount: risks.length,
      highCount: risks.filter((risk) => ["critical", "high"].includes(risk.risk_level)).length,
      updated: project.updated_at || project.created_at
    };
  }).filter((task) => taskFilter.value === "all" || (taskFilter.value === "working"
    ? ["queued", "running", "working", "validating"].includes(task.status)
    : task.status === taskFilter.value));
});

const stats = computed(() => ({
  projects: store.state.projects.length,
  pending: store.pendingRiskCount,
  risks: store.risks.length,
  versions: store.review ? (store.review.humanRevisions?.length || 0) + 1 : 0
}));

function formatUpdated(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour12: false });
}

async function openTask(projectId) {
  try {
    await store.selectProject(projectId);
    emit("open-review");
  } catch (error) {
    store.notify(error.message || "打开审查任务失败", "warn");
  }
}

function requestDelete(task) {
  if (actionsLocked.value) return;
  deleteTarget.value = task;
  deleteError.value = "";
}

function closeDelete() {
  if (deleting.value) return;
  deleteTarget.value = null;
  deleteError.value = "";
}

async function confirmDelete() {
  if (!deleteTarget.value || deleting.value || actionsLocked.value) return;
  deleting.value = true;
  deleteError.value = "";
  try {
    await store.deleteReviewTask(deleteTarget.value.id);
    deleteTarget.value = null;
  } catch (error) {
    deleteError.value = error.message || "删除失败，请重试";
  } finally {
    deleting.value = false;
  }
}

function statusClass(status) {
  return {
    waiting_confirmation: "badge-warning",
    queued: "badge-primary",
    running: "badge-primary",
    working: "badge-primary",
    completed: "badge-success",
    partial: "badge-muted",
    cancelled: "badge-warning",
    failed: "badge-danger",
    validating: "badge-warning"
  }[status] || "badge-muted";
}
</script>

<template>
  <div class="page-stack">
    <section class="hero-band">
      <div class="hero-content">
        <p class="eyebrow">LOCAL CONTRACT REVIEW WORKBENCH</p>
        <h2>合同审查工作台</h2>
        <p class="hero-text">
          当前项目为 <strong>{{ store.activeProject?.project_name || "尚未导入合同" }}</strong>，{{ store.risks.length ? `已生成 ${store.risks.length} 条结构化风险，等待法务确认、修订和导出。` : "导入合同后将在此处呈现解析结果和审查任务。" }}
        </p>
        <div class="hero-actions">
          <button class="button button-light" type="button" @click="emit('new-review')"><Plus :size="16" />上传合同</button>
          <button class="button button-hero-ghost" type="button" :disabled="!store.activeProject" @click="emit('open-review')"><ArrowRight :size="16" />进入审查工作区</button>
        </div>
      </div>
      <div class="hero-seal"><ShieldAlert :size="24" /><span>证据可追溯</span></div>
    </section>

    <section class="stats-grid">
      <article class="stat-card">
        <div class="stat-label">全部项目</div><div class="stat-number">{{ stats.projects }}<small>个</small></div><div class="stat-trend">当前工作区项目</div><div class="stat-icon blue"><FileStack :size="19" /></div>
      </article>
      <article class="stat-card">
        <div class="stat-label">待人工任务</div><div class="stat-number">{{ stats.pending }}<small>项</small></div><div class="stat-trend warning">高风险与需核验待处理</div><div class="stat-icon amber"><Clock3 :size="19" /></div>
      </article>
      <article class="stat-card">
        <div class="stat-label">发现风险</div><div class="stat-number">{{ stats.risks }}<small>条</small></div><div class="stat-trend danger">critical / high {{ store.risks.filter((risk) => ["critical", "high"].includes(risk.risk_level)).length }} 条</div><div class="stat-icon red"><ShieldAlert :size="19" /></div>
      </article>
      <article class="stat-card">
        <div class="stat-label">审查版本</div><div class="stat-number">{{ stats.versions }}<small>个</small></div><div class="stat-trend success">AI 原始 + 人工修订</div><div class="stat-icon green"><CheckCircle2 :size="19" /></div>
      </article>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div><h2>审查任务</h2><p>按状态筛选当前项目与历史任务</p></div>
        <div class="filter-row">
          <button v-for="filter in [['all','全部'],['working','进行中'],['waiting_confirmation','待复核'],['completed','已完成'],['partial','部分完成'],['cancelled','已取消'],['failed','失败']]" :key="filter[0]" class="filter-chip" :class="{ active: taskFilter === filter[0] }" type="button" @click="taskFilter = filter[0]">{{ filter[1] }}</button>
        </div>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>任务 / 合同</th><th>合同类型</th><th>状态</th><th>进度</th><th>风险</th><th>更新时间</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="task in tasks" :key="task.id">
              <td class="task-name"><button class="table-link" type="button" :disabled="actionsLocked && task.id !== store.activeProject?.project_id" @click="openTask(task.id)">{{ task.name }}</button><span class="table-subtext">文件版本 {{ task.fileVersionId || "-" }} · 本地项目</span></td>
              <td><span class="badge badge-category">{{ contractTypes[task.type] || task.type }}</span></td>
              <td><span class="badge" :class="statusClass(task.status)"><span class="badge-dot"></span>{{ task.status === 'queued' ? '排队中' : statusLabels[task.status] || task.status }}</span></td>
              <td><div class="progress-row"><div class="progress-track"><span :style="{ width: `${task.progress}%` }"></span></div><small>{{ task.progress }}%</small></div></td>
              <td><span :class="{ 'risk-number': task.highCount, 'muted-number': !task.highCount }">{{ task.riskCount }} 条</span><span v-if="task.highCount" class="table-subtext">{{ task.highCount }} 条高风险</span></td>
              <td class="muted-text">{{ formatUpdated(task.updated) }}</td>
              <td><div class="task-actions">
                <button class="icon-button small" type="button" title="打开审查工作区" :aria-label="`打开审查任务：${task.name}`" :disabled="actionsLocked && task.id !== store.activeProject?.project_id" @click="openTask(task.id)"><ArrowRight :size="15" /></button>
                <button class="icon-button small danger" type="button" :title="actionsLocked ? '任务正在处理，请稍后删除' : '删除审查任务'" :aria-label="`删除审查任务：${task.name}`" :disabled="actionsLocked" @click="requestDelete(task)"><Trash2 :size="15" /></button>
              </div></td>
            </tr>
            <tr v-if="!tasks.length"><td colspan="7" class="empty-cell">{{ store.state.projects.length ? '当前筛选条件下暂无任务' : '暂无审查任务' }}</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <div class="dashboard-note"><RefreshCw :size="14" /> 所有审查文件、版本和操作记录只保存在本地工作区。</div>

    <Modal :open="Boolean(deleteTarget)" title="删除审查任务" @close="closeDelete">
      <p class="delete-task-name">确定删除“{{ deleteTarget?.name }}”？</p>
      <p>该任务的风险、复核、对话及导出记录将一并删除，删除后无法撤销。</p>
      <p class="muted-text">合同原文件、本地文件副本、已导出的文件和操作审计记录将保留。</p>
      <p v-if="deleteError" class="danger-text" role="alert">{{ deleteError }}</p>
      <template #footer>
        <button class="button" type="button" :disabled="deleting" @click="closeDelete">取消</button>
        <button class="button button-danger" type="button" :disabled="deleting || actionsLocked" @click="confirmDelete"><LoaderCircle v-if="deleting" class="spin" :size="15" /><Trash2 v-else :size="15" />{{ deleting ? '删除中...' : '确认删除' }}</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.task-actions { display: flex; gap: 6px; width: 62px; }
.task-name { max-width: 380px; overflow-wrap: anywhere; }
.delete-task-name { margin-top: 0; font-weight: 600; overflow-wrap: anywhere; }
</style>
