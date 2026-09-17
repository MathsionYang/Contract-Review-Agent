const { JSONParser } = require("@streamparser/json");

function createRiskStream(onRisk) {
  const parser = new JSONParser({ paths: ["$.risks.*"], keepStack: false });
  let failed = false;
  let prefix = "";
  let started = false;
  parser.onValue = ({ value, key, parent }) => {
    if (Array.isArray(parent) && value && typeof value === "object" && !Array.isArray(value)
      && typeof value.title === "string" && value.title.trim()) onRisk(value, Number(key));
  };
  parser.onError = () => { failed = true; };
  return {
    write(delta) {
      if (failed || parser.isEnded || typeof delta !== "string") return;
      let text = delta;
      if (!started) {
        prefix += delta;
        const trimmed = prefix.trimStart();
        if (trimmed.startsWith("{")) text = trimmed;
        else if (/^```(?:json)?\s*\{/i.test(trimmed)) text = trimmed.replace(/^```(?:json)?\s*/i, "");
        else {
          if (prefix.length > 64) failed = true;
          return;
        }
        started = true;
        prefix = "";
      }
      parser.write(text);
    }
  };
}

module.exports = { createRiskStream };
