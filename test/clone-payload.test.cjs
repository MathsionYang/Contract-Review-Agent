const test = require("node:test");
const assert = require("node:assert/strict");
const { reactive, ref } = require("vue");

test("IPC payload 会把 Vue 响应式代理转换为可结构化克隆对象", async () => {
  const { toCloneable } = await import("../src/services/clonePayload.mjs");
  const payload = reactive({ review: { risks: [{ risk_id: "risk-1" }] }, enabled: ref(true) });
  const plain = toCloneable(payload);

  assert.deepEqual(plain, { review: { risks: [{ risk_id: "risk-1" }] }, enabled: true });
  assert.doesNotThrow(() => structuredClone(plain));
});
