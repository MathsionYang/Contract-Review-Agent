const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const workspaceSource = fs.readFileSync(path.resolve(__dirname, "../src/components/ReviewWorkspace.vue"), "utf8");
const storeSource = fs.readFileSync(path.resolve(__dirname, "../src/stores/review.js"), "utf8");
const apiSource = fs.readFileSync(path.resolve(__dirname, "../src/services/electronApi.js"), "utf8");

test("审查流水线头部同时提供开始与停止入口，并只在运行中允许停止", () => {
  assert.match(workspaceSource, /v-if="taskCanStart"[\s\S]{0,220}@click="startReview"/);
  assert.match(workspaceSource, /v-if="reviewRunning"[\s\S]{0,220}@click="stopReview"/);
  assert.match(workspaceSource, /const reviewRunning = computed\(\(\) => \["running", "cancelling"\]\.includes\(taskStatus\.value\) && store\.isBusy\)/);
  assert.match(workspaceSource, /const taskCanStart = computed\(\(\) => Boolean\(store\.review\) && !reviewRunning\.value && !store\.isBusy && !store\.chatBusy\)/);
});

test("停止按钮调用 store 的审查取消动作而不是对话取消动作", () => {
  assert.match(workspaceSource, /async function stopReview\(\) \{\s*await store\.cancelReview\(\);\s*\}/);
  assert.match(storeSource, /async function cancelReview\(\)/);
  assert.match(storeSource, /electronApi\.cancelReview\(\{ projectId: activeReviewRun\.projectId \}\)/);
  assert.match(storeSource, /runReview, cancelReview,/);
  assert.match(apiSource, /cancelReview\(payload\)/);
});

test("停止后的流水线状态与按钮文案覆盖已取消终态", () => {
  assert.match(workspaceSource, /taskStatus === 'cancelled'/);
  assert.match(workspaceSource, /审查已停止，已保留已生成的风险/);
  assert.match(workspaceSource, /\["partial", "failed", "cancelled"\]\.includes\(taskStatus\.value\)/);
});
