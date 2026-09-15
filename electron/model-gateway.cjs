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

function modelConfigHint(model) {
  const modelId = String(model?.modelId || "").trim().toLowerCase();
  if (["deepseek", "deepseek api", "deepseek-api"].includes(modelId)) {
    return "DeepSeek 的模型标识不能填写服务商名称，请填写 deepseek-chat（或服务商实际支持的模型 ID）";
  }
  return "";
}

function redactProviderError(value) {
  const text = String(value || "")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/(api[-_ ]?key|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .trim();
  return text.slice(0, 500);
}

function providerErrorDetail(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return redactProviderError(payload);
  const error = payload.error;
  const message = error?.message || payload.message || (typeof error === "string" ? error : "");
  const code = error?.code || payload.code || "";
  const detail = [message, code && code !== message ? `错误码 ${code}` : ""].filter(Boolean).join(" · ");
  return redactProviderError(detail);
}

async function readProviderError(response) {
  try {
    if (typeof response?.json === "function") return providerErrorDetail(await response.json());
  } catch (_error) {}
  try {
    if (typeof response?.text === "function") return providerErrorDetail(await response.text());
  } catch (_error) {}
  return "";
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
  const modelHint = modelConfigHint(model);
  if (modelHint) {
    return { ok: false, data: null, usage: null, latencyMs: 0, errorCode: "MODEL_CONFIG_INVALID", message: modelHint };
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
    response_format: { type: "json_object" },
    ...(Number(model.maxTokens) > 0 ? { max_tokens: Number(model.maxTokens) } : {}),
    ...(options.stream ? { stream: true } : {})
  };
  const retries = Math.min(Math.max(Number(model.retries ?? 0), 0), MAX_RETRIES);
  const timeoutMs = Math.min(Math.max(Number(model.timeoutMs || DEFAULT_TIMEOUT_MS), 1000), 120000);
  let lastFailure = null;
  let emittedDelta = false;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let requestSignal = controller.signal;
    if (options.signal) {
      if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") requestSignal = AbortSignal.any([controller.signal, options.signal]);
      else if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: requestSignal
      });
      if (!response?.ok) {
        const status = Number(response?.status || 0);
        const detail = await readProviderError(response);
        throw gatewayError("MODEL_REQUEST_FAILED", `模型请求失败（HTTP ${status || "unknown"}）${detail ? `：${detail}` : ""}`);
      }
      let payload;
      let content;
      let usage = null;
      if (options.stream && response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamedContent = "";
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            const value = line.replace(/^data:\s*/i, "").trim();
            if (!value || value === "[DONE]") continue;
            let part;
            try { part = JSON.parse(value); } catch (_error) { continue; }
            const delta = part?.choices?.[0]?.delta?.content ?? part?.choices?.[0]?.message?.content ?? part?.output;
            if (typeof delta === "string") {
              streamedContent += delta;
              emittedDelta = true;
              if (typeof options.onDelta === "function") options.onDelta(delta);
            }
            if (part?.usage) usage = { ...part.usage };
          }
        }
        if (buffer.trim() && buffer.trim() !== "[DONE]") {
          const value = buffer.replace(/^data:\s*/i, "").trim();
          try {
            const part = JSON.parse(value);
            const delta = part?.choices?.[0]?.delta?.content ?? part?.choices?.[0]?.message?.content ?? part?.output;
            if (typeof delta === "string") {
              streamedContent += delta;
              emittedDelta = true;
              if (typeof options.onDelta === "function") options.onDelta(delta);
            }
            if (part?.usage) usage = { ...part.usage };
          } catch (_error) {}
        }
        content = streamedContent;
        payload = { usage };
      } else {
        payload = await response.json();
        content = responseContent(payload);
        if (typeof options.onDelta === "function" && typeof content === "string") {
          emittedDelta = Boolean(options.stream);
          options.onDelta(content);
        }
      }
      const data = parseStructuredContent(content);
      return {
        ok: true,
        data,
        usage: usage || (payload?.usage ? { ...payload.usage } : null),
        latencyMs: Date.now() - startedAt,
        errorCode: null,
        message: "模型调用成功"
      };
    } catch (error) {
      lastFailure = error?.name === "AbortError"
        ? gatewayError(options.signal?.aborted ? "MODEL_REQUEST_CANCELLED" : "MODEL_REQUEST_FAILED", options.signal?.aborted ? "模型请求已取消" : "模型请求超时", error)
        : error;
      if (lastFailure.code === "MODEL_OUTPUT_INVALID" || attempt >= retries || emittedDelta || controller.signal.aborted || options.signal?.aborted) break;
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
