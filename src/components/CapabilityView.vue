<script setup>
import { computed, reactive, ref } from "vue";
import {
  Check, Cpu, FileCode2, Pencil, PlugZap, Plus, Power, ShieldCheck, Sparkles, Trash2, UploadCloud, X
} from "lucide-vue-next";
import { useReviewStore } from "../stores/review";
import Modal from "./Modal.vue";

const store = useReviewStore();
defineEmits(["new-review", "open-review", "configure", "export"]);
const roleLabels = {
  analysis: "语义分析",
  extraction: "条款抽取",
  embedding: "向量化",
  rerank: "重排序",
  vision: "视觉理解"
};
const policyLabels = {
  internal_only: "仅内部",
  local_only: "仅本地",
  approved_external: "已审批外部"
};
const statusLabels = {
  enabled: "已启用",
  disabled: "已停用",
  validating: "校验中",
  isolated: "已隔离",
  active: "运行中",
  disabled: "已停用"
};

const modelModalOpen = ref(false);
const modelMode = ref("create");
const modelForm = reactive(createEmptyModel());

const models = computed(() => store.state.capabilities?.models || []);
const enabledSkillCount = computed(() => (store.state.capabilities?.skills || []).filter((item) => item.status === "enabled").length);

function createEmptyModel() {
  return {
    name: "",
    modelId: "",
    provider: "",
    endpoint: "",
    role: "analysis",
    version: "",
    policy: "internal_only",
    contextLength: 0,
    maxTokens: 0,
    timeoutMs: 30000,
    retries: 0,
    credentialRef: "",
    status: "disabled",
    testStatus: "untested",
    lastTestedAt: ""
  };
}

function resetModelForm(model = null) {
  Object.assign(modelForm, createEmptyModel(), model ? { ...model } : {});
}

function openModelModal(model = null) {
  modelMode.value = model ? "edit" : "create";
  resetModelForm(model);
  modelModalOpen.value = true;
}

function closeModelModal() {
  modelModalOpen.value = false;
}

async function saveModel() {
  try {
    await store.saveModel({
      ...modelForm,
      contextLength: Number(modelForm.contextLength) || 0,
      maxTokens: Number(modelForm.maxTokens) || 0,
      timeoutMs: Number(modelForm.timeoutMs) || 0,
      retries: Number(modelForm.retries) || 0
    });
    closeModelModal();
  } catch (error) {
    store.notify(error.message || "模型配置保存失败", "warn");
  }
}

async function validateModel(model) {
  await store.validateModel(model.name);
}

async function toggleModel(model) {
  await store.toggleModel(model.name);
}

async function toggleSkill(skill) {
  await store.toggleSkill(skill.name);
}

async function deleteModel(model) {
  if (!window.confirm(`确定删除模型“${model.name}”吗？`)) return;
  await store.deleteModel(model.name);
}

function formatTestedAt(value) {
  if (!value) return "尚未校验";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <div class="page-stack">
    <div class="page-heading">
      <div>
        <p class="eyebrow dark">CAPABILITY CONTROL</p>
        <h2>能力配置</h2>
        <p>维护审查 Skill、模型角色和本地运行参数；敏感凭据只通过引用名管理。</p>
      </div>
      <button class="button button-primary" type="button" @click="openModelModal()">
        <Plus :size="15" />新增模型
      </button>
    </div>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>审查 Skill</h2>
          <p>Skill 不能绕过权限、证据、Validator 和人工确认规则。</p>
        </div>
        <div class="panel-header-actions">
          <span class="badge badge-primary">{{ enabledSkillCount }} 项启用</span>
          <button class="icon-button" type="button" title="安装 Skill" aria-label="安装 Skill" @click="store.notify('Skill 安装入口将在 Electron 版本中接入签名校验', 'warn')"><UploadCloud :size="16" /></button>
        </div>
      </div>
      <div class="capability-grid">
        <article v-for="skill in store.state.capabilities?.skills" :key="skill.name" class="capability-card">
          <div class="capability-icon"><ShieldCheck :size="19" /></div>
          <div class="capability-card-main">
            <div class="capability-card-title">
              <strong>{{ skill.name }}</strong>
              <span class="badge" :class="skill.status === 'enabled' ? 'badge-success' : skill.status === 'isolated' ? 'badge-danger' : 'badge-warning'">{{ statusLabels[skill.status] || skill.status }}</span>
            </div>
            <div class="capability-version mono">v{{ skill.version }} · {{ skill.scope }}</div>
            <p>{{ skill.description }}</p>
          </div>
          <div class="capability-card-actions">
            <button class="icon-button small" type="button" title="查看 Skill 详情" aria-label="查看 Skill 详情" @click="store.notify(`${skill.name} 当前版本 ${skill.version}`, 'ok')"><FileCode2 :size="15" /></button>
            <button v-if="skill.status === 'enabled' || skill.status === 'disabled'" class="icon-button small" type="button" :title="skill.status === 'enabled' ? '停用 Skill' : '启用 Skill'" :aria-label="skill.status === 'enabled' ? `停用 ${skill.name}` : `启用 ${skill.name}`" @click="toggleSkill(skill)"><Power :size="14" /></button>
          </div>
        </article>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>模型配置</h2>
          <p>模型不会预置测试数据；请人工填写、保存并校验，校验通过后手动启用，配置会保存在本地并供下次使用。</p>
        </div>
        <span class="badge badge-muted">{{ models.length }} 个模型</span>
      </div>
      <div class="table-wrap">
        <table class="data-table model-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>服务商 / API 地址</th>
              <th>角色</th>
              <th>配置参数</th>
              <th>数据策略</th>
              <th>状态</th>
              <th class="action-column">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="model in models" :key="model.name">
              <td>
                <div class="file-name"><Cpu :size="16" /><strong>{{ model.name }}</strong></div>
                <span class="table-subtext mono">{{ model.modelId || model.name }} · {{ model.version }}</span>
              </td>
              <td>
                <strong>{{ model.provider }}</strong>
                <span class="table-subtext endpoint-text" :title="model.endpoint">{{ model.endpoint }}</span>
              </td>
              <td><span class="badge badge-category">{{ roleLabels[model.role] || model.role }}</span></td>
              <td>
                <span class="table-subtext">上下文 {{ model.contextLength || "-" }}</span>
                <span class="table-subtext">输出 {{ model.maxTokens || "不限" }} · 超时 {{ model.timeoutMs || "-" }} ms</span>
              </td>
              <td><span class="badge badge-muted">{{ policyLabels[model.policy] || model.policy }}</span><span class="table-subtext">{{ model.credentialRef || "无凭据引用" }}</span></td>
              <td>
                <span class="badge" :class="model.status === 'active' ? 'badge-success' : 'badge-muted'">{{ statusLabels[model.status] || model.status }}</span>
                <span class="table-subtext" :class="model.testStatus === 'passed' ? 'success-text' : model.testStatus === 'failed' ? 'danger-text' : ''">{{ model.testStatus === "passed" ? "配置已校验" : model.testStatus === "failed" ? "校验失败" : formatTestedAt(model.lastTestedAt) }}</span>
              </td>
              <td class="action-column">
                <div class="row-actions">
                  <button class="icon-button small" type="button" title="校验配置" :aria-label="`校验 ${model.name} 配置`" @click="validateModel(model)"><PlugZap :size="14" /></button>
                  <button class="icon-button small" type="button" :title="model.status === 'active' ? '停用模型' : '启用模型'" :aria-label="model.status === 'active' ? `停用 ${model.name}` : `启用 ${model.name}`" @click="toggleModel(model)"><Check v-if="model.status === 'active'" :size="14" /><Power v-else :size="14" /></button>
                  <button class="icon-button small" type="button" title="编辑模型" :aria-label="`编辑 ${model.name}`" @click="openModelModal(model)"><Pencil :size="14" /></button>
                  <button class="icon-button small danger" type="button" title="删除模型" :aria-label="`删除 ${model.name}`" @click="deleteModel(model)"><Trash2 :size="14" /></button>
                </div>
              </td>
            </tr>
            <tr v-if="!models.length"><td colspan="7" class="empty-cell">暂无模型配置，请先新增模型。</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <div class="dashboard-note"><Sparkles :size="14" /> 模型、OCR 和文档解析服务的凭据不在渲染层保存。</div>
  </div>

  <Modal :open="modelModalOpen" :title="modelMode === 'edit' ? '编辑模型配置' : '新增模型配置'" :wide="true" @close="closeModelModal">
    <template #subtitle><p class="modal-subtitle">填写模型调用所需的非敏感参数，凭据只填写安全存储中的引用名。</p></template>
    <div class="form-grid two-columns">
      <div class="form-field"><label>配置名称 <span>*</span></label><input v-model="modelForm.name" class="text-input" :disabled="modelMode === 'edit'" placeholder="例如：hunyuan-pro" /></div>
      <div class="form-field"><label>模型标识 <span>*</span></label><input v-model="modelForm.modelId" class="text-input" placeholder="例如：hunyuan-pro" /></div>
      <div class="form-field"><label>服务商</label><input v-model="modelForm.provider" class="text-input" placeholder="例如：DeepSeek" /></div>
      <div class="form-field"><label>API 地址 <span>*</span></label><input v-model="modelForm.endpoint" class="text-input" placeholder="例如：https://api.deepseek.com/v1" /></div>
      <div class="form-field"><label>模型角色</label><select v-model="modelForm.role" class="text-input"><option v-for="(label, key) in roleLabels" :key="key" :value="key">{{ label }}（{{ key }}）</option></select></div>
      <div class="form-field"><label>数据策略</label><select v-model="modelForm.policy" class="text-input"><option v-for="(label, key) in policyLabels" :key="key" :value="key">{{ label }}</option></select></div>
      <div class="form-field"><label>上下文长度</label><input v-model.number="modelForm.contextLength" class="text-input" type="number" min="0" step="1" /></div>
      <div class="form-field"><label>最大输出 Token</label><input v-model.number="modelForm.maxTokens" class="text-input" type="number" min="0" step="1" /></div>
      <div class="form-field"><label>超时（毫秒）</label><input v-model.number="modelForm.timeoutMs" class="text-input" type="number" min="0" step="1000" /></div>
      <div class="form-field"><label>失败重试次数</label><input v-model.number="modelForm.retries" class="text-input" type="number" min="0" max="5" step="1" /></div>
      <div class="form-field"><label>配置版本</label><input v-model="modelForm.version" class="text-input" placeholder="例如：cfg-v1" /></div>
      <div class="form-field"><label>启用条件</label><div class="form-static-note">保存后默认停用，完成配置校验后可在列表中启用</div></div>
      <div class="form-field field-span-2"><label>凭据引用</label><input v-model="modelForm.credentialRef" class="text-input" placeholder="例如：cred://deepseek/analysis" /><small class="inline-note">只保存引用名；API Key 应配置在 Electron 主进程环境或安全凭据存储中。</small></div>
    </div>
    <template #footer><button class="button" type="button" @click="closeModelModal"><X :size="15" />取消</button><button class="button button-primary" type="button" @click="saveModel"><Check :size="15" />保存配置</button></template>
  </Modal>
</template>
