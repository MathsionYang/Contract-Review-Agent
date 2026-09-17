<script setup>
import { computed, reactive, ref } from "vue";
import {
  Check, Cpu, FileCode2, Pencil, PlugZap, Plus, Power, ShieldCheck, Sparkles, Trash2, UploadCloud, X
} from "lucide-vue-next";
import { useReviewStore } from "../stores/review";
import { electronApi } from "../services/electronApi";
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
  active: "已启用"
};

const modelModalOpen = ref(false);
const modelMode = ref("create");
const modelForm = reactive(createEmptyModel());
const credentialConfigured = ref(false);
const credentialStatusLoading = ref(false);
const modelSaving = ref(false);

const models = computed(() => store.state.capabilities?.models || []);
const enabledSkillCount = computed(() => (store.state.capabilities?.skills || []).filter((item) => item.status === "enabled").length);

function createEmptyModel() {
  return {
    configId: "",
    name: "",
    modelId: "",
    provider: "",
    endpoint: "",
    role: "analysis",
    version: "",
    policy: "internal_only",
    contextLength: 0,
    maxTokens: 0,
    timeoutMs: 60000,
    retries: 1,
    credentialRef: "",
    apiKey: "",
    status: "disabled",
    testStatus: "untested",
    lastTestedAt: ""
  };
}

function resetModelForm(model = null) {
  for (const key of Object.keys(modelForm)) delete modelForm[key];
  Object.assign(modelForm, createEmptyModel(), model ? { ...model } : {});
  modelForm.apiKey = "";
}

async function refreshCredentialStatus() {
  const reference = String(modelForm.credentialRef || "").trim();
  credentialConfigured.value = false;
  if (!reference || reference === "none") return;
  credentialStatusLoading.value = true;
  try {
    const result = await electronApi.getCredentialStatus({ reference });
    credentialConfigured.value = Boolean(result?.configured);
  } catch (_error) {
    credentialConfigured.value = false;
  } finally {
    credentialStatusLoading.value = false;
  }
}

async function openModelModal(model = null) {
  modelMode.value = model ? "edit" : "create";
  resetModelForm(model);
  credentialConfigured.value = false;
  modelModalOpen.value = true;
  await refreshCredentialStatus();
}

function closeModelModal() {
  modelModalOpen.value = false;
}

async function saveModel() {
  if (modelSaving.value) return;
  modelSaving.value = true;
  try {
    if (!String(modelForm.name || "").trim()) throw new Error("模型名称不能为空");
    if (!String(modelForm.modelId || "").trim()) throw new Error("模型标识不能为空");
    if (!String(modelForm.endpoint || "").trim()) throw new Error("API 地址不能为空");
    const reference = String(modelForm.credentialRef || "").trim();
    const apiKey = String(modelForm.apiKey || "").trim();
    if (apiKey && (!reference || reference === "none")) {
      throw new Error("填写 API Key 时，请同时填写 Key 引用名，以区分多组 Key");
    }
    if (apiKey) {
      await electronApi.saveCredential({ reference, apiKey });
    }
    const { apiKey: _apiKey, ...modelPayload } = modelForm;
    await store.saveModel({
      ...modelPayload,
      configId: modelMode.value === "edit" ? modelPayload.configId : "",
      credentialRef: reference,
      contextLength: Number(modelForm.contextLength) || 0,
      maxTokens: Number(modelForm.maxTokens) || 0,
      timeoutMs: Number(modelForm.timeoutMs) || 0,
      retries: Number(modelForm.retries) || 0
    });
    credentialConfigured.value = Boolean(reference && (apiKey || credentialConfigured.value));
    closeModelModal();
  } catch (error) {
    store.notify(error.message || "模型配置保存失败", "warn");
  } finally {
    modelSaving.value = false;
  }
}

async function validateModel(model) {
  try { await store.validateModel(model.configId || model.name); }
  catch (error) { store.notify(error.message || "连接测试失败", "warn"); }
}

async function toggleModel(model) {
  try { await store.toggleModel(model.configId || model.name); }
  catch (error) { store.notify(error.message || "模型状态保存失败", "warn"); }
}

async function toggleSkill(skill) {
  await store.toggleSkill(skill.name);
}

async function deleteModel(model) {
  if (!window.confirm(`确定删除模型“${model.name}”吗？`)) return;
  try { await store.deleteModel(model.configId || model.name); }
  catch (error) { store.notify(error.message || "模型删除失败", "warn"); }
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
          <p>{{ models.filter(model => model.status === 'active').length }} 个已启用</p>
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
            <tr v-for="model in models" :key="model.configId || model.name">
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
                <span class="table-subtext" :title="model.testMessage || ''" :class="model.testStatus === 'passed' && model.testKind === 'remote' ? 'success-text' : model.testStatus === 'failed' ? 'danger-text' : ''">{{ store.isModelTesting(model.configId) ? '连接测试中' : model.testStatus === 'passed' ? (model.testKind === 'remote' ? '连接已验证' : '仅字段已校验') : model.testStatus === 'failed' ? '连接测试失败' : '尚未测试' }}</span>
                <span v-if="model.lastTestedAt" class="table-subtext">{{ formatTestedAt(model.lastTestedAt) }}</span>
                <span v-if="model.testStatus === 'failed'" class="table-subtext danger-text">{{ model.testMessage }}</span>
                <span v-if="['rerank', 'vision'].includes(model.role)" class="table-subtext">尚未接入执行</span>
              </td>
              <td class="action-column">
                <div class="row-actions">
                  <button class="icon-button small" type="button" :title="store.isModelTesting(model.configId) ? '连接测试中' : '测试连接（发送最小请求）'" :aria-label="`测试 ${model.name} 连接`" :disabled="store.isModelTesting(model.configId)" @click="validateModel(model)"><PlugZap :size="14" /></button>
                  <button class="icon-button small" type="button" :title="model.status === 'active' ? '停用模型' : '启用模型'" :aria-label="model.status === 'active' ? `停用 ${model.name}` : `启用 ${model.name}`" :disabled="store.isModelTesting(model.configId)" @click="toggleModel(model)"><Check v-if="model.status === 'active'" :size="14" /><Power v-else :size="14" /></button>
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

    <div class="dashboard-note"><Sparkles :size="14" /> API Key 只在输入时短暂经过界面，保存后由 Electron 加密到本机凭据文件；模型配置只保存 Key 引用名。</div>
  </div>

  <Modal :open="modelModalOpen" :title="modelMode === 'edit' ? '编辑模型配置' : '新增模型配置'" :wide="true" @close="closeModelModal">
    <template #subtitle><p class="modal-subtitle">API Key 可直接在此填写。保存一次后下次启动继续使用，编辑时不会回显已保存的 Key。</p></template>
    <div class="form-grid two-columns">
      <div class="form-field"><label>配置名称 <span>*</span></label><input v-model="modelForm.name" class="text-input" placeholder="例如：hunyuan-pro" /></div>
      <div class="form-field"><label>模型标识 <span>*</span></label><input v-model="modelForm.modelId" class="text-input" placeholder="例如：hunyuan-pro" /></div>
      <div class="form-field"><label>服务商</label><input v-model="modelForm.provider" class="text-input" placeholder="例如：DeepSeek" /></div>
      <div class="form-field"><label>API 地址 <span>*</span></label><input v-model="modelForm.endpoint" class="text-input" placeholder="例如：https://api.deepseek.com/v1" /></div>
      <div class="form-field"><label>模型角色</label><select v-model="modelForm.role" class="text-input"><option v-for="(label, key) in roleLabels" :key="key" :value="key">{{ label }}（{{ key }}）</option></select></div>
      <div class="form-field"><label>数据策略</label><select v-model="modelForm.policy" class="text-input"><option v-for="(label, key) in policyLabels" :key="key" :value="key">{{ label }}</option></select></div>
      <div class="form-field"><label>上下文长度</label><input v-model.number="modelForm.contextLength" class="text-input" type="number" min="0" step="1" /></div>
      <div class="form-field"><label>最大输出 Token</label><input v-model.number="modelForm.maxTokens" class="text-input" type="number" min="0" step="1" /></div>
      <div class="form-field"><label>首段响应 / 空闲超时（毫秒）</label><input v-model.number="modelForm.timeoutMs" class="text-input" type="number" min="1000" max="120000" step="1000" /></div>
      <div class="form-field"><label>失败重试次数</label><input v-model.number="modelForm.retries" class="text-input" type="number" min="0" max="5" step="1" /></div>
      <div class="form-field"><label>配置版本</label><input v-model="modelForm.version" class="text-input" placeholder="例如：cfg-v1" /></div>
      <div class="form-field"><label>连接状态</label><div class="form-static-note">保存后待测试</div></div>
      <div class="form-field"><label>Key 引用名 <span v-if="modelForm.apiKey">*</span></label><input v-model="modelForm.credentialRef" class="text-input" placeholder="例如：cred://deepseek/analysis" autocomplete="off" @change="refreshCredentialStatus" /><small class="inline-note">用于区分多组 Key；同一引用可绑定多个模型。</small></div>
      <div class="form-field"><label>API Key <span v-if="modelMode === 'create' && !credentialConfigured">*</span></label><input v-model="modelForm.apiKey" class="text-input" type="text" autocomplete="off" spellcheck="false" placeholder="在此填写本模型的明文 Key" @input="credentialConfigured = false" /><small v-if="credentialStatusLoading" class="inline-note">正在检查本机凭据...</small><small v-else-if="credentialConfigured" class="inline-note success-text">本机已配置；留空保存将沿用现有 Key</small><small v-else class="inline-note">仅用于本次保存，Electron 会在本机安全存储中加密保存，不写入模型配置。</small></div>
    </div>
    <template #footer><button class="button" type="button" :disabled="modelSaving" @click="closeModelModal"><X :size="15" />取消</button><button class="button button-primary" type="button" :disabled="modelSaving" @click="saveModel"><Check :size="15" />{{ modelSaving ? "保存中" : "保存配置" }}</button></template>
  </Modal>
</template>
