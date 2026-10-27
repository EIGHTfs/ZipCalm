// WASM 引擎执行器（**子进程**，每次操作一个实例）
//
// 为什么必须独立进程：
//   1) js7z-tools 的 MT 模式每次运行会拉起 worker 线程，运行时在完成后自行退出；
//      同一个进程里连续创建多个实例（或复用一个实例跑第二条命令）实测会**挂住不返回**。
//      一次操作 = 一个新进程 = 一个新实例，彻底规避这个状态残留。
//   2) 超时/取消可以硬杀进程，不会把宿主服务拖住。
//
// 通信协议（父进程 ↔ 本脚本）：
//   入参：argv[2] = JSON spec
//     { argv: string[],          // 7z 参数（路径已是虚拟路径 /m0、/m1… 或相对名）
//       cwdWasm: string|null,    // 在 WASM 里 chdir 到哪（create 需相对名解析）
//       mounts: [{host, wasm}] } // 把宿主目录挂进虚拟文件系统
//   出参：**stderr 打印一行 JSON 信封** {"exit": <code>}
//         7z 自身的输出留在 stdout（实测 js7z 直接写真实 stdout，覆盖 instance.print 不生效，
//         所以不能靠"把 7z 输出改道 stderr"来分流——只能反过来：信封走 stderr）
//
// 关键异步语义（docs/18 §附四坑 1）：MT 版 `callMain` 是**异步**的，完成信号只在
// `onExit(exitCode)` 里。**绝不能在 callMain 返回后同步判定成功**——实测那样会误报"缺产物"，
// 文件稍后才落盘。本脚本严格等 onExit 之后再打印信封。

import { createRequire } from 'node:module';

const spec = JSON.parse(process.argv[2] || '{}');

/** 诊断信息（启动失败等）写 stderr，与信封同一通道，父进程按 JSON 行识别 */
const emit = (text) => process.stderr.write(text);

async function main() {
  // 依赖解析：包可能装在项目依赖目录（node_modules 软链或 NODE_PATH），交给 Node 自己找
  const requireFrom = createRequire(import.meta.url);
  const JS7z = requireFrom('js7z-tools');

  const instance = await JS7z();
  // 说明：js7z 的 7z 输出并不经过 instance.print（实测），会直接写到真实 stdout。
  // 这里仍设置一次，兼容某些版本；真正的分流见文件头注释。

  // 挂载宿主目录：NODEFS 让 WASM 里的路径直接读写真实文件
  for (const mount of spec.mounts || []) {
    try {
      instance.FS.mkdir(mount.wasm);
    } catch {
      /* 已存在（同一路径重复挂载）不算错 */
    }
    instance.FS.mount(instance.NODEFS, { root: mount.host }, mount.wasm);
  }
  if (spec.cwdWasm) instance.FS.chdir(spec.cwdWasm);

  // 严格等 onExit：这是唯一可靠的完成信号
  const exitCode = await new Promise((resolve) => {
    let settled = false;
    instance.onExit = (code) => {
      settled = true;
      resolve(typeof code === 'number' ? code : 0);
    };
    instance.callMain(spec.argv || []);
    // 兜底：若某版本不触发 onExit，超时也不能永远挂着（父进程另有硬超时）
    setTimeout(() => {
      if (!settled) resolve(-1);
    }, 10 * 60 * 1000).unref();
  });

  process.stderr.write(`${JSON.stringify({ exit: exitCode })}\n`);
  // MT 运行时会在完成后自行退出线程；这里显式结束进程，避免 worker 让父进程等
  process.exit(0);
}

main().catch((error) => {
  emit(`\n[wasm-runner] 启动失败：${error && error.message}\n`);
  process.stderr.write(`${JSON.stringify({ exit: -1, error: String(error && error.message) })}\n`);
  process.exit(0);
});
