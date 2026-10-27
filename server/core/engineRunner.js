// 外部引擎统一执行入口（**所有** 走外部程序/WASM 的格式插件都必须经这里）
//
// 为什么要有这一层（而不是各插件自己 spawn）：
//   限核、超时硬杀、全局串行是**部署环境约束**（本机只有 3 核，跑满会触发宿主"系统 CPU 过载"保护，
//   实测已造成过一次 503），不是某个格式的特性。散在各插件里 → 每加一个格式就漏一次；
//   各插件各有一把串行锁时，7z 任务与 RAR 任务还能同时跑，一起把 CPU 打满。
//
// 统一后作者不需要知道限核的存在：调 runEngineProcess 就自动获得
//   ① 绑核（按平台分层，见下）② nice/低优先级 ③ 全局串行 ④ 超时/取消整组 SIGKILL ⑤ 逐行回调
//
// ===== 限核的三层策略（从最可靠到最不可靠，逐层降级）=====
//   ① 应用层线程数：7z 原生 `-mmt=N`（产物 md5 与线程数无关，实测一致）。
//      但 **unrar 没有线程参数、7z WASM 库内固定 3 线程**，所以这一层不能兜底，只能锦上添花。
//   ② OS 级绑核：Linux `taskset -c <list>`（实测可把 Cpus_allowed_list 收到指定核）；
//      Windows 可用 PowerShell 启动后设 `ProcessorAffinity`（**本机无 Windows，未实测**）；
//      **macOS 没有可用绑核手段**（taskpolicy 只调 QoS、cpuset 是 FreeBSD 的）→ 如实跳过。
//   ③ 优先级：Linux/macOS `nice -n 10`；Windows `PriorityClass = Idle`。
//
// 原则：**能绑的绑上、不能绑的如实降级并写进日志/probe**，绝不做"看起来在限其实没限"的实现。
//
// 环境变量：
//   `ZC_ENGINE_CPU_CORES`  统一覆盖核数（唯一入口，不做旧名兼容——项目仍在开发期，不留双名字包袱）
//   `ZC_TASKSET_BIN`       覆盖 taskset 路径（自探测失败时的兜底入口）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 全局串行闸门：跨格式、跨调用共用（模块级单例） */
let queueTail = Promise.resolve();
let waitingCount = 0;

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 按「环境变量 → PATH → 常见绝对路径」找可执行文件，并校验可执行（tool-self-detection 的规矩） */
function findExecutable(envKey, candidates) {
  const fromEnv = envKey ? process.env[envKey] : null;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return isExecutable(fromEnv) ? fromEnv : null;
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  // 最后再按 PATH 找一遍（不同发行版位置不同）
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of candidates.map((item) => path.basename(item))) {
      const full = path.join(dir, name);
      if (isExecutable(full)) return full;
    }
  }
  return null;
}

/**
 * 计算可用核数（默认「总核数 − 1」，至少 1）。
 * @returns {{cores: number, cpuList: string, mask: string, source: string}}
 */
export function cpuLimit() {
  const total = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const raw = Number(process.env.ZC_ENGINE_CPU_CORES);
  const requested = Number.isInteger(raw) && raw >= 1 ? raw : null;
  const source = requested ? 'ZC_ENGINE_CPU_CORES' : 'default';
  const cores = requested ? Math.min(requested, total) : Math.max(1, total - 1);
  const cpuList = Array.from({ length: cores }, (_, index) => index).join(',');
  // Windows 的 ProcessorAffinity 是**绝对位掩码**：核 0..N-1 → (1<<N)-1
  const mask = `0x${((1 << cores) - 1).toString(16)}`;
  return { cores, cpuList, mask, source };
}

/** 当前限定的核数（供 `-mmt` 之类参数对齐：线程多于可用核只会互相等锁） */
export function currentCpuCores() {
  return cpuLimit().cores;
}

/**
 * 探测本平台的限核能力（可注入参数，便于单测跨平台分支）。
 * @param {{platform?: string, hasTaskset?: boolean, hasNice?: boolean, hasPowershell?: boolean, tasksetPath?: string, nicePath?: string, powershellPath?: string}} [probe]
 * @returns {{platform: string, binding: 'taskset'|'powershell-affinity'|'none', priority: 'nice'|'powershell-idle'|'none', tasksetPath: string|null, nicePath: string|null, powershellPath: string|null, reason: string}}
 */
export function detectStrategy(probe = {}) {
  const platform = probe.platform || process.platform;
  const tasksetPath = probe.hasTaskset === undefined
    ? findExecutable('ZC_TASKSET_BIN', ['/bin/taskset', '/usr/bin/taskset'])
    : (probe.hasTaskset ? (probe.tasksetPath || '/bin/taskset') : null);
  const nicePath = probe.hasNice === undefined
    ? findExecutable(null, ['/bin/nice', '/usr/bin/nice'])
    : (probe.hasNice ? (probe.nicePath || '/bin/nice') : null);
  const powershellPath = probe.hasPowershell === undefined
    ? findExecutable(null, ['/usr/bin/powershell', '/usr/bin/pwsh'])
    : (probe.hasPowershell ? (probe.powershellPath || 'powershell') : null);

  if (platform === 'linux') {
    if (tasksetPath) {
      return {
        platform,
        binding: 'taskset',
        priority: nicePath ? 'nice' : 'none',
        tasksetPath,
        nicePath,
        powershellPath: null,
        reason: 'Linux + taskset：绑核到指定核列表',
      };
    }
    return {
      platform,
      binding: 'none',
      priority: nicePath ? 'nice' : 'none',
      tasksetPath: null,
      nicePath,
      powershellPath: null,
      reason: 'Linux 但未找到 taskset（ZC_TASKSET_BIN 也未指定）：仅降优先级，不绑核',
    };
  }

  if (platform === 'win32') {
    if (powershellPath) {
      return {
        platform,
        binding: 'powershell-affinity',
        priority: 'powershell-idle',
        tasksetPath: null,
        nicePath: null,
        powershellPath,
        reason: 'Windows + PowerShell：启动后设 ProcessorAffinity 与 Idle 优先级（**未在真机验证**）',
      };
    }
    return {
      platform,
      binding: 'none',
      priority: 'none',
      tasksetPath: null,
      nicePath: null,
      powershellPath: null,
      reason: 'Windows 且未找到 PowerShell：不绑核不降优先级（仅依赖应用层 -mmt）',
    };
  }

  if (platform === 'darwin') {
    // macOS 没有可用的绑核手段：taskpolicy 只能调 QoS，cpuset 是 FreeBSD 的，cputhrottle 是第三方。
    // **如实跳过**，不假装限了。
    return {
      platform,
      binding: 'none',
      priority: nicePath ? 'nice' : 'none',
      tasksetPath: null,
      nicePath,
      powershellPath: null,
      reason: 'macOS 无可用绑核手段（taskpolicy 只调 QoS）：仅降优先级，不绑核',
    };
  }

  return {
    platform,
    binding: 'none',
    priority: nicePath ? 'nice' : 'none',
    tasksetPath: null,
    nicePath,
    powershellPath: null,
    reason: `未知平台 ${platform}：不绑核，仅尝试降优先级`,
  };
}

/**
 * 纯函数：按策略把命令包成最终要 spawn 的形态（便于单测跨平台分支）。
 *
 * 关键约束：**包装层不能替换引擎的退出码**。
 *   - Linux 的 `taskset`/`nice` 是 exec 直通，退出码就是引擎的退出码 ✅
 *   - Windows 的 `cmd /c start /wait` **不保证透传子进程退出码**（start 返回的是自身结果），
 *     所以这里**不用 start**，改用 PowerShell：`Start-Process -Wait -PassThru` 后读 `ExitCode` 并 `exit`，
 *     这样拿到的才是引擎的退出码。⚠️ 该分支未在真机验证（本机只有 Linux），已在 docs/17 登记。
 *
 * @param {{command: string, args: string[]}} spec
 * @param {{strategy?: object, cores?: number, cpuList?: string, mask?: string}} [context]
 * @returns {{command: string, args: string[]}}
 */
export function planWrapper(spec, context = {}) {
  const strategy = context.strategy || detectStrategy();
  const { cpuList, mask } = {
    cpuList: context.cpuList || cpuLimit().cpuList,
    mask: context.mask || cpuLimit().mask,
  };

  if (strategy.binding === 'taskset') {
    const head = strategy.priority === 'nice' && strategy.nicePath ? [strategy.nicePath, '-n', '10'] : [];
    return { command: strategy.tasksetPath, args: ['-c', cpuList, ...head, spec.command, ...spec.args] };
  }

  if (strategy.binding === 'powershell-affinity') {
    // 用单引号包参数并转义内部单引号，避免 PowerShell 把参数当表达式
    const quotedArgs = spec.args.map((item) => `'${String(item).replace(/'/g, "''")}'`).join(',');
    const script = [
      `$p = Start-Process -FilePath '${String(spec.command).replace(/'/g, "''")}'`,
      quotedArgs ? `-ArgumentList @(${quotedArgs})` : '',
      '-PassThru -WindowStyle Hidden',
      `; $p.ProcessorAffinity = [IntPtr]${mask}`,
      "; $p.PriorityClass = 'Idle'",
      '; $p.WaitForExit()',
      '; exit $p.ExitCode',
    ].filter(Boolean).join(' ');
    return { command: strategy.powershellPath, args: ['-NoProfile', '-NonInteractive', '-Command', script] };
  }

  // 无绑核：有 nice 就只降优先级（exec 直通，退出码仍是引擎的）
  if (strategy.priority === 'nice' && strategy.nicePath) {
    return { command: strategy.nicePath, args: ['-n', '10', spec.command, ...spec.args] };
  }
  return { command: spec.command, args: spec.args };
}

/**
 * 排队（全局串行）。等待时可观测：日志里能看到 `engine queued`。
 * @template T
 * @param {() => Promise<T>} task
 * @param {{label?: string, logger?: {info: Function, warn: Function}}} [context]
 * @returns {Promise<T>}
 */
export function runSerialized(task, context = {}) {
  const label = context.label || 'engine';
  const logger = context.logger;
  if (waitingCount > 0 && logger && typeof logger.info === 'function') {
    logger.info('engine queued', { label, waiting: waitingCount });
  }
  waitingCount += 1;
  const next = queueTail.then(
    () => task(),
    () => task(),
  );
  queueTail = next.then(
    () => undefined,
    () => undefined,
  );
  const settled = () => {
    waitingCount = Math.max(0, waitingCount - 1);
  };
  next.then(settled, settled);
  return next;
}

/** 诊断：当前平台策略（供 probe()/日志，能看出"本平台到底限没限"） */
export function engineStrategyInfo() {
  const strategy = detectStrategy();
  const { cores, cpuList, mask, source } = cpuLimit();
  return {
    platform: strategy.platform,
    binding: strategy.binding,
    priority: strategy.priority,
    cores,
    cpuList,
    mask,
    coresSource: source,
    reason: strategy.reason,
  };
}

/**
 * 跑一个外部引擎进程（原生二进制 / node 子进程 / WASM runner 都走这里）。
 *
 * @param {object} spec
 * @param {string} spec.command 可执行文件（`/bin/7z`、`/bin/unrar`、`process.execPath`）
 * @param {string[]} spec.args 参数
 * @param {string} [spec.cwd] 工作目录
 * @param {number} [spec.timeoutMs] 超时（默认 60s），超时整组 SIGKILL
 * @param {AbortSignal} [spec.signal] 任务取消信号
 * @param {(line: string) => void} [spec.onLine] 逐行回调（进度解析）
 * @param {string} [spec.label] 引擎名（日志里用：'7z' / '7z-wasm' / 'unrar' / 'unrar-js'）
 * @param {Record<string,string>} [spec.env] 追加的环境变量（可选；RAR 用它强制 UTF-8 locale）
 * @param {{info: Function, warn: Function}} [spec.logger] 日志器（可选）
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut: boolean, aborted: boolean}>}
 */
export function runEngineProcess(spec) {
  const label = spec.label || 'engine';
  const timeoutMs = spec.timeoutMs || 60 * 1000;
  const strategy = detectStrategy();
  const wrapped = planWrapper({ command: spec.command, args: spec.args }, { strategy });
  if (spec.logger && typeof spec.logger.info === 'function' && spec.onceStrategyLog !== true) {
    spec.logger.info('engine strategy', { label, binding: strategy.binding, priority: strategy.priority, reason: strategy.reason });
  }

  return runSerialized(
    () =>
      new Promise((resolve) => {
        let child;
        try {
          // detached: true → 自成进程组，超时/取消时整组杀，避免孙进程变孤儿继续吃 CPU
          child = spawn(wrapped.command, wrapped.args, {
            cwd: spec.cwd || undefined,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            // 可选：调用方需要特定 locale（如 RAR 必须 en_US.UTF-8 才输出可逆的 PUA 转义）
            ...(spec.env ? { env: { ...process.env, ...spec.env } } : {}),
          });
        } catch (error) {
          resolve({ code: -1, stdout: '', stderr: String(error && error.message), timedOut: false, aborted: false });
          return;
        }

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let aborted = false;
        let killed = false;

        const killTree = () => {
          if (killed) return;
          killed = true;
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {
              /* 已退出 */
            }
          }
        };

        const emit = (chunk, isError) => {
          const text = chunk.toString();
          if (isError) stderr += text;
          else stdout += text;
          if (typeof spec.onLine === 'function') {
            for (const line of text.split(/\r?\n/)) {
              if (line.trim().length > 0) spec.onLine(line);
            }
          }
        };

        const timer = setTimeout(() => {
          timedOut = true;
          killTree();
        }, timeoutMs);

        if (spec.signal) {
          if (spec.signal.aborted) {
            aborted = true;
            killTree();
          } else {
            spec.signal.addEventListener('abort', () => {
              aborted = true;
              killTree();
            }, { once: true });
          }
        }

        child.stdout.on('data', (chunk) => emit(chunk, false));
        child.stderr.on('data', (chunk) => emit(chunk, true));
        child.on('error', (error) => {
          clearTimeout(timer);
          resolve({ code: -1, stdout, stderr: `${stderr}${String(error && error.message)}`, timedOut, aborted });
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (timedOut && spec.logger && typeof spec.logger.warn === 'function') {
            spec.logger.warn('engine timeout, killed', { label, timeoutMs });
          }
          // 退出码来自引擎本身（taskset/nice 是 exec 直通；Windows 走 PowerShell 的 exit $p.ExitCode）
          resolve({ code: typeof code === 'number' ? code : -1, stdout, stderr, timedOut, aborted });
        });
      }),
    { label, logger: spec.logger },
  );
}
