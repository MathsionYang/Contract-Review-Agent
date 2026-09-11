const crypto = require("node:crypto");

function callId() {
  return `tool_call_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|password|credential|api.?key/i.test(key) ? "[REDACTED]" : redact(item)]));
  }
  if (typeof value !== "string") return value;
  return value
    .replace(/sk-[a-z0-9_-]{6,}/gi, "[REDACTED]")
    .replace(/bearer\s+[a-z0-9._-]+/gi, "Bearer [REDACTED]");
}

function normalizeToolCall(raw = {}) {
  const kind = raw.kind === "skill" || raw.type === "skill" ? "skill" : "mcp";
  let args = raw.arguments ?? raw.args ?? raw.input ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch (_error) { args = { value: args }; }
  }
  return {
    tool_call_id: String(raw.tool_call_id || raw.id || callId()),
    kind,
    name: String(raw.name || raw.function?.name || "").trim(),
    arguments: redact(args && typeof args === "object" ? args : {}),
    requested_permission: String(raw.requested_permission || raw.permission || "read_contract_context"),
    requested_at: raw.requested_at || new Date().toISOString()
  };
}

function baseRecord(call) {
  return {
    execution_id: `execution_${call.tool_call_id}`,
    tool_call_id: call.tool_call_id,
    kind: call.kind,
    name: call.name,
    arguments: call.arguments,
    requested_permission: call.requested_permission,
    permission_decision: "denied",
    sandbox: { required: true, mode: "isolated", network: "deny_by_default", filesystem: "scoped" },
    status: "blocked",
    error_code: null,
    message: "",
    started_at: null,
    completed_at: new Date().toISOString()
  };
}

async function processToolCalls(calls = [], options = {}) {
  const enabledSkills = new Set(options.enabledSkills || []);
  const enabledMcpTools = new Set(options.enabledMcpTools || []);
  const policy = options.permissionPolicy || {};
  const mode = String(policy.toolExecution || "confirm");
  const executor = typeof options.executor === "function" ? options.executor : null;
  const records = [];
  for (const raw of calls || []) {
    const call = normalizeToolCall(raw);
    const record = baseRecord(call);
    if (!call.name) {
      record.error_code = "TOOL_CALL_INVALID";
      record.message = "工具调用缺少名称";
      records.push(record);
      continue;
    }
    if (!executor) {
      record.error_code = "TOOL_EXECUTOR_UNAVAILABLE";
      record.message = "当前桌面端没有注册该工具的真实执行器，仅保留审计记录";
      records.push(record);
      continue;
    }
    if (mode === "deny") {
      record.error_code = "TOOL_PERMISSION_DENIED";
      record.message = "本地会话策略禁止执行工具";
      records.push(record);
      continue;
    }
    if (call.kind === "skill" && !enabledSkills.has(call.name)) {
      record.error_code = "SKILL_NOT_ENABLED";
      record.message = "Skill 未启用或不属于当前审查执行快照";
      records.push(record);
      continue;
    }
    if (call.kind === "mcp" && enabledMcpTools.size && !enabledMcpTools.has(call.name)) {
      record.error_code = "MCP_TOOL_NOT_ALLOWED";
      record.message = "MCP Tool 不在当前允许列表中";
      records.push(record);
      continue;
    }
    if (mode !== "allow") {
      record.permission_decision = "confirmation_required";
      record.status = "awaiting_confirmation";
      record.error_code = "TOOL_CONFIRMATION_REQUIRED";
      record.message = "工具执行需要用户单独确认";
      records.push(record);
      continue;
    }
    record.permission_decision = "allowed";
    record.status = "running";
    record.started_at = new Date().toISOString();
    try {
      const result = await executor({ ...call, sandbox: record.sandbox });
      record.status = result?.ok === false ? "failed" : "completed";
      record.error_code = result?.errorCode || null;
      record.message = result?.message || (record.status === "completed" ? "工具执行完成" : "工具执行失败");
      record.output = redact(result?.data ?? result?.output ?? null);
    } catch (error) {
      record.status = "failed";
      record.error_code = error.code || "TOOL_EXECUTION_FAILED";
      record.message = error.message || "工具执行失败";
    }
    record.completed_at = new Date().toISOString();
    records.push(record);
  }
  return records;
}

module.exports = { normalizeToolCall, processToolCalls, redact };
