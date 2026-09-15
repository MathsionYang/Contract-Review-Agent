const { spawn } = require("node:child_process");

// 某些宿主环境会设置该变量，必须在启动 Electron 二进制前移除，否则 Electron 会退化为 Node 模式。
delete process.env.ELECTRON_RUN_AS_NODE;

const electronBinary = require("electron");
const electronArgs = process.argv.slice(2);
// 该工作台不依赖 GPU；显式关闭 GPU 并改为进程内模式，可兼容无显卡驱动或远程桌面环境。
for (const flag of ["--disable-gpu", "--in-process-gpu"]) {
  if (!electronArgs.includes(flag)) electronArgs.unshift(flag);
}
const child = spawn(electronBinary, electronArgs, {
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
