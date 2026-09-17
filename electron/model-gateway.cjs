const DEFAULT_TIMEOUT_MS = 60000;
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

function endpointFor(model, operation = "chat") {
  const endpoint = String(model?.endpoint || "").trim().replace(/\/$/, "");
  if (!endpoint) throw gatewayError("MODEL_CONFIG_INVALID", "模型 API 地址不能为空");
  let url;
  try { url = new URL(endpoint); } catch (_) { throw gatewayError("MODEL_CONFIG_INVALID", "模型 API 地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw gatewayError("MODEL_CONFIG_INVALID", "模型 API 地址必须为不含凭据的 HTTP(S) 地址");
  url.pathname = `${url.pathname.replace(/\/$/, "").replace(/\/(?:chat\/completions|embeddings)$/i, "")}/${operation === "embedding" ? "embeddings" : "chat/completions"}`;
  return url.toString();
}

function validateVectors(vectors, count) {
  if (!Array.isArray(vectors) || vectors.length !== count || !count) return false;
  const dimension = vectors[0]?.length;
  return Number.isInteger(dimension) && dimension > 0 && dimension <= 65536 && Array.from(vectors).every((vector) => (
    Array.isArray(vector) && vector.length === dimension && Array.from(vector).every((value) => typeof value === "number" && Number.isFinite(value))
    && Number.isFinite(Math.hypot(...vector)) && Math.hypot(...vector) > 0
  ));
}

function embeddingData(payload, count) {
  const rows = payload?.data;
  if (!Array.isArray(rows) || rows.length !== count) throw gatewayError("MODEL_OUTPUT_INVALID", "向量响应数量与输入不一致");
  const vectors = new Array(count);
  for (const row of rows) {
    if (!Number.isInteger(row?.index) || row.index < 0 || row.index >= count || vectors[row.index]) throw gatewayError("MODEL_OUTPUT_INVALID", "向量响应 index 缺失、重复或越界");
    vectors[row.index] = row.embedding;
  }
  if (!validateVectors(vectors, count)) throw gatewayError("MODEL_OUTPUT_INVALID", "向量维度不一致或包含无效数值");
  return { vectors, dimension: vectors[0].length };
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
  const operation = options.operation || (model.role === "embedding" ? "embedding" : "chat");
  if (!["chat", "embedding"].includes(operation)) return { ok: false, errorCode: "MODEL_ROLE_UNSUPPORTED", message: "当前模型协议尚未接入" };
  if (operation === "embedding" && (!Array.isArray(options.input) || !options.input.length || options.input.some((value) => typeof value !== "string" || !value.trim()))) {
    return { ok: false, errorCode: "MODEL_INPUT_INVALID", message: "向量输入必须为非空文本数组" };
  }
  if (operation === "embedding") options = { ...options, stream: false };
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
    url = endpointFor(model, operation);
  } catch (error) {
    return { ok: false, data: null, usage: null, latencyMs: 0, errorCode: error.code, message: error.message };
  }
  const credential = resolveCredential(model.credentialRef, options.credentialResolver);
  if (model.credentialRef && model.credentialRef !== "none" && !credential) {
    return { ok: false, data: null, usage: null, latencyMs: 0, errorCode: "MODEL_CONFIG_INVALID", message: "模型凭据引用不可用" };
  }
  const headers = { "Content-Type": "application/json", Accept: options.stream ? "text/event-stream, application/json" : "application/json" };
  if (credential) headers.Authorization = `Bearer ${credential}`;
  const body = operation === "embedding" ? { model: String(model.modelId), input: options.input, encoding_format: "float" } : {
    model: String(model.modelId),
    messages: Array.isArray(options.messages) ? options.messages : [],
    temperature: 0.1,
    response_format: { type: "json_object" },
    ...(Number(model.maxTokens) > 0 ? { max_tokens: Number(model.maxTokens) } : {}),
    ...(options.stream ? { stream: true } : {})
  };
  const configuredRetries = Math.min(Math.max(Number(model.retries ?? 0), 0), MAX_RETRIES);
  // Recover once from transient timeouts, including older saved configs with retries=0.
  const retryLimit = options.retryTimeouts === false ? configuredRetries : Math.max(configuredRetries, 1);
  const timeoutMs = Math.min(Math.max(Number(model.timeoutMs || DEFAULT_TIMEOUT_MS), 1000), 120000);
  let lastFailure = null;
  let emittedDelta = false;
  let attemptsUsed = 0;
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    attemptsUsed = attempt + 1;
    const startedAt = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    let totalTimedOut = false;
    let receivedActivity = false;
    const attemptTimeoutMs = Math.min(timeoutMs * (attempt + 1), 120000);
    // 首个字节之前的等待单独放宽：推理模型可能在输出 JSON 前先思考很久，
    // 用同一空闲阈值会把"还没开始输出"误判成"卡死"。
    const firstDeltaTimeoutMs = Math.min(Math.max(Number(options.firstDeltaTimeoutMs) || 0, 0), 600000);
    let timer;
    const resetIdleTimeout = () => {
      clearTimeout(timer);
      const deadline = receivedActivity || !firstDeltaTimeoutMs ? attemptTimeoutMs : Math.max(attemptTimeoutMs, firstDeltaTimeoutMs);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadline);
    };
    resetIdleTimeout();
    // 流式内容持续到达时不按请求总时长误判超时，但仍限制单次调用最长十分钟。
    const totalTimeoutMs = Math.min(Math.max(Number(options.maxDurationMs) || 600000, 1000), 600000);
    const totalTimer = options.stream ? setTimeout(() => { totalTimedOut = true; controller.abort(); }, totalTimeoutMs) : null;
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
      if (operation === "embedding") {
        const payload = await response.json();
        return { ok: true, data: embeddingData(payload, options.input.length), usage: payload?.usage || null,
          latencyMs: Date.now() - startedAt, attempts: attemptsUsed, errorCode: null, message: "向量模型调用成功" };
      }
      let payload;
      let content;
      let usage = null;
      let finishReason;
      if (options.stream && !response.headers?.get?.("content-type")?.includes("application/json") && response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamedContent = "";
        let done = false;
        const consumeLine = (line) => {
          if (!/^data:/i.test(line)) return;
          const value = line.replace(/^data:\s*/i, "").trim();
          if (value === "[DONE]") { done = true; return; }
          if (!value) return;
          let part;
          try { part = JSON.parse(value); } catch (_error) { throw gatewayError("MODEL_OUTPUT_INVALID", "模型流式响应包含无效 JSON 数据帧"); }
          if (part.error) throw gatewayError("MODEL_REQUEST_FAILED", providerErrorDetail(part) || "模型流式请求失败");
          const choice = part?.choices?.[0];
          const delta = choice?.delta?.content ?? choice?.message?.content ?? part?.output;
          const reasoning = choice?.delta?.reasoning_content || choice?.delta?.reasoning;
          if ((typeof delta === "string" && delta.length) || (typeof reasoning === "string" && reasoning.length)) {
            receivedActivity = true;
            resetIdleTimeout();
          }
          if (typeof delta === "string" && delta.length) {
            streamedContent += delta;
            emittedDelta = true;
            if (typeof options.onDelta === "function") options.onDelta(delta);
          }
          // 推理增量单独回调：调用方目前只用于统计活跃度，原始推理文本不会进入审查结果或进度事件。
          if (typeof reasoning === "string" && reasoning.length && typeof options.onReasoningDelta === "function") {
            options.onReasoningDelta(reasoning);
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (part?.usage) usage = { ...part.usage };
        };
        try {
          while (!done) {
            const chunk = await reader.read();
            buffer += decoder.decode(chunk.value, { stream: !chunk.done });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";
            for (const line of lines) {
              consumeLine(line);
              if (done) break;
            }
            if (chunk.done) { if (!done && buffer.trim()) consumeLine(buffer); break; }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        content = streamedContent;
        payload = { usage };
      } else {
        payload = await response.json();
        content = responseContent(payload);
        finishReason = payload?.choices?.[0]?.finish_reason;
        if (typeof options.onDelta === "function" && typeof content === "string") {
          emittedDelta = Boolean(options.stream);
          options.onDelta(content);
        }
      }
      if (finishReason === "length") throw gatewayError("MODEL_OUTPUT_TRUNCATED", "模型输出达到长度上限，审查尚未完成");
      if (finishReason === "content_filter") throw gatewayError("MODEL_OUTPUT_INVALID", "模型输出被服务商过滤，审查尚未完成");
      const data = parseStructuredContent(content);
      return {
        ok: true,
        data,
        usage: usage || (payload?.usage ? { ...payload.usage } : null),
        latencyMs: Date.now() - startedAt,
        attempts: attemptsUsed,
        errorCode: null,
        message: "模型调用成功"
      };
    } catch (error) {
      const userCancelled = Boolean(options.signal?.aborted);
      lastFailure = userCancelled
        ? gatewayError("MODEL_REQUEST_CANCELLED", "模型请求已取消", error)
        : totalTimedOut
          ? gatewayError("MODEL_REQUEST_TIMEOUT", `模型调用超过单次总时限 ${totalTimeoutMs / 1000} 秒`, error)
        : timedOut
          ? gatewayError("MODEL_REQUEST_TIMEOUT", options.stream
            ? `${receivedActivity ? "模型连续" : "等待模型首段响应超过"} ${Math.round((receivedActivity ? attemptTimeoutMs : Math.max(attemptTimeoutMs, firstDeltaTimeoutMs)) / 1000)} 秒${receivedActivity ? "没有新内容" : ""}`
            : "模型请求超时", error)
          : error;
      const retryableTimeout = timedOut && !userCancelled && !emittedDelta;
      const retryableFailure = retryableTimeout || (attempt < configuredRetries && !emittedDelta && !userCancelled);
      if (["MODEL_OUTPUT_INVALID", "MODEL_OUTPUT_TRUNCATED"].includes(lastFailure.code) || totalTimedOut || !retryableFailure || attempt >= retryLimit) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 1000)));
    } finally {
      clearTimeout(timer);
      clearTimeout(totalTimer);
    }
  }
  return {
    ok: false,
    data: null,
    usage: null,
    latencyMs: 0,
    attempts: attemptsUsed,
    timeoutMs,
    errorCode: lastFailure?.code || "MODEL_REQUEST_FAILED",
    message: lastFailure?.message || "模型请求失败"
  };
}

async function testModelConnection(options = {}) {
  const model = { ...options.model, retries: 0, timeoutMs: Math.min(Number(options.model?.timeoutMs) || 15000, 15000), maxTokens: 256 };
  if (!["analysis", "extraction", "embedding"].includes(model.role)) {
    return { ok: false, errorCode: "MODEL_ROLE_UNSUPPORTED", message: "该角色尚未接入执行协议，不能标记为连通测试通过" };
  }
  const result = await (options.invokeModel || invokeModel)({
    model, credentialResolver: options.credentialResolver, fetchImpl: options.fetchImpl, retryTimeouts: false,
    ...(model.role === "embedding" ? { operation: "embedding", input: ["合同审查连通性测试"] } : {
      messages: [{ role: "system", content: 'Return only the JSON object {"ok":true}.' }, { role: "user", content: "Connection test." }]
    })
  });
  const valid = result?.ok && (model.role === "embedding" ? validateVectors(result.data?.vectors, 1) : result.data?.ok === true);
  return { ok: Boolean(valid), errorCode: valid ? null : result?.errorCode || "MODEL_OUTPUT_INVALID",
    message: valid ? "真实连通性测试通过" : result?.ok ? "模型响应不符合该角色的协议" : result?.message || "连通性测试失败",
    latencyMs: result?.latencyMs || 0, testedAt: new Date().toISOString(), testKind: "remote",
    ...(valid && model.role === "embedding" ? { dimension: result.data.vectors[0].length } : {}) };
}

module.exports = { invokeModel, parseStructuredContent, resolveCredential, validateVectors, testModelConnection };
