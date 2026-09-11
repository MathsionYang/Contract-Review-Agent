function normalizedAllowlist(allowlist = []) {
  return allowlist.map((item) => {
    try {
      return new URL(String(item)).origin;
    } catch (_error) {
      return "";
    }
  }).filter(Boolean);
}

function isAllowedUrl(value, allowlist = []) {
  let target;
  try {
    target = new URL(String(value));
  } catch (_error) {
    return false;
  }
  return normalizedAllowlist(allowlist).includes(target.origin);
}

function sourceRecord(source, fallback) {
  return {
    source_id: String(source?.source_id || source?.id || `${fallback}-${Math.random().toString(16).slice(2)}`),
    title: String(source?.title || source?.name || "未命名法律来源"),
    url: String(source?.url || ""),
    clause_no: String(source?.clause_no || source?.clauseNo || ""),
    clause_title: String(source?.clause_title || source?.clauseTitle || ""),
    excerpt: String(source?.excerpt || source?.text || ""),
    published_at: String(source?.published_at || source?.publishedAt || "")
  };
}

async function verifyLegalSource(options = {}) {
  const url = String(options.url || "").trim();
  const allowlist = options.allowlist || [];
  if (!url || !isAllowedUrl(url, allowlist)) {
    return { status: "unauthorized", sources: [], errorCode: "SOURCE_UNAVAILABLE", message: "法律来源不在允许访问的白名单内" };
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return { status: "unavailable", sources: [], errorCode: "SOURCE_UNAVAILABLE", message: "当前运行环境没有可用的网络请求能力" };
  }
  const target = new URL(url);
  target.searchParams.set("q", String(options.query || ""));
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs || 15000), 1000), 60000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: options.signal || controller.signal
    });
    if (!response?.ok) return { status: "unavailable", sources: [], errorCode: "SOURCE_UNAVAILABLE", message: `法律来源请求失败（HTTP ${response?.status || "unknown"}）` };
    const payload = await response.json();
    const sources = (Array.isArray(payload) ? payload : payload?.sources || payload?.results || []).map((source, index) => sourceRecord(source, `legal-${index + 1}`));
    return { status: "verified", sources, errorCode: null, message: "实时法律来源核验成功" };
  } catch (error) {
    return { status: "unavailable", sources: [], errorCode: "SOURCE_UNAVAILABLE", message: error?.name === "AbortError" ? "法律来源请求超时" : "法律来源暂不可用" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isAllowedUrl, verifyLegalSource };
