const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

function runLauncher(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "launch-electron.cjs"), ...args], {
      cwd: path.join(__dirname, ".."),
      env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("桌面启动器清除 ELECTRON_RUN_AS_NODE 并启动 Electron", async () => {
  const result = await runLauncher(["--version"], { ...process.env, ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout.trim(), /^v44\.3\.0$/);
});
