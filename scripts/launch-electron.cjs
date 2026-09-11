const { spawn } = require("node:child_process");

// 某些宿主环境会设置该变量，必须在启动 Electron 二进制前移除，否则 Electron 会退化为 Node 模式。
delete process.env.ELECTRON_RUN_AS_NODE;

const electronBinary = require("electron");
const child = spawn(electronBinary, process.argv.slice(2), {
  stdio: "inherit",
  windowsHide: false
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
