const test = require("node:test");
const assert = require("node:assert/strict");

const { exposedApiKeys } = require("../electron/preload.cjs");

test("preload 只暴露约定的本地桌面端 API", () => {
  assert.deepEqual(exposedApiKeys().sort(), [
    "exportReview",
    "importContract",
    "loadState",
    "saveState",
    "selectContractFile",
    "validateExport"
  ]);
});
