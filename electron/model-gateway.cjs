const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;

function gatewayError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function resolveCredential(reference, resolver) {
  if (!reference || reference === "none") return "";
  if (typeof resolver === "function") return String(resolver(reference) || "");
  const suffix = String(reference).replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
  return process.env[`CONTRACT_REVIEW_CREDENTIAL_${suffix}`] || "";
}

function endpointFor(model) {
  const endpoint = String(model?.endpoint || "").trim().replace(/\/$/, "");
  if (!endpoint) throw gatewayError("MODEL_CONFIG_INVALID", "模型 API 地址不能为空");
  return /\/chat\/completions$/i.test(endpoint) ? endpoint : `${endpoint}/chat/completions`;
}

function parseStructuredContent(content) {
  if (content && typeof content === "object") return content;
  if (typeof content !== "string") throw gatewayError("MODEL_OUTPUT_INVALID", "模型未返回结构化内容");
  const normalized = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(normalized);
  } catch (error) {
    throw gatewayError("MODEL_OUTPUT_INVALID", "模型返回内容不是有效 JSON", error);
  }
}

function responseContent(payload) {
  const choice = payload?.choices?.[0];
  return choice?.message?.content ?? choice?.text ?? payload?.output ?? payload?.data;
}

async function invokeModel(options = {}) {
  const model = options.model || {};
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return { ok: false, data: null, usage: null, latencyMs: 0, errorCode: "MODEL_REQUEST_FAILED", message: "当前运行环境没有可用的网络请求能力" };
  }
  if (!String(model.modelId || "").trim()) {
    return { ok: false, data: null, usage: null, latencyMs: 0, errorCode: "MODEL_CONFIG_INVALID", message: "模型标识不能为空" };
  }
  let url;
  try {
    url = endpointFor(model);
  } catch (error) {
    return { ok: false, data: null, usage: null, latencyMs: 0, errorCode: error.code, message: error.message };
  }
  const credential = resolveCredential(model.credentialRef, options.credentialResolver);
  if (model.credentialRef && model.credentialRef !== "none" && !credential) {
    return { ok: false, data: null, usage: null, latencyMs: 0, errorCode: "MODEL_CONFIG_INVALID", message: "模型凭据引用不可用" };
  }
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (credential) headers.Authorization = `Bearer ${credential}`;
  const body = {
    model: String(model.modelId),
    messages: Array.isArray(options.messages) ? options.messages : [],
    temperature: 0.1,
    response_format: { type: "json_object" }
  };
  const retries = Math.min(Math.max(Number(model.retries ?? 0), 0), MAX_RETRIES);
  const timeoutMs = Math.min(Math.max(Number(model.timeoutMs || DEFAULT_TIMEOUT_MS), 1000), 120000);
  let lastFailure = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.signal || controller.signal
      });
      if (!response?.ok) {
        const status = Number(response?.status || 0);
        throw gatewayError("MODEL_REQUEST_FAILED", `模型请求失败（HTTP ${status || "unknown"}）`);
      }
      const payload = await response.json();
      const data = parseStructuredContent(responseContent(payload));
      return {
        ok: true,
        data,
        usage: payload?.usage ? { ...payload.usage } : null,
        latencyMs: Date.now() - startedAt,
        errorCode: null,
        message: "模型调用成功"
      };
    } catch (error) {
      lastFailure = error?.name === "AbortError"
        ? gatewayError("MODEL_REQUEST_FAILED", "模型请求超时", error)
        : error;
      if (lastFailure.code === "MODEL_OUTPUT_INVALID" || attempt >= retries) break;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    ok: false,
    data: null,
    usage: null,
    latencyMs: 0,
    errorCode: lastFailure?.code || "MODEL_REQUEST_FAILED",
    message: lastFailure?.message || "模型请求失败"
  };
}

module.exports = { invokeModel, parseStructuredContent, resolveCredential };
