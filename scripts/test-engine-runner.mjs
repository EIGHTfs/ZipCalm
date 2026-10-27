#!/usr/bin/env node
//
// 外部引擎统一执行入口的单元测试（`server/core/engineRunner.js`）
//
// 为什么需要这一套：本机只有 Linux，**跨平台分支没法实跑**——只能靠"把 platform 与探测结果注入进去"
// 的单测来证明：Windows 走 PowerShell 分支、macOS 明确不绑核、探测失败时逐级降级。
// 没有这些单测，跨平台代码等于没写。
//
// 覆盖：
//   ① Linux + taskset → 绑核 + nice，且退出码仍是引擎的（taskset/nice 是 exec 直通）
//   ② Linux 无 taskset → 只 nice，日志/策略里明说没绑核
//   ③ Windows + PowerShell → 走 PowerShell（**不用 cmd /c start**，因为 start 不透传退出码）
//   ④ Windows 无 PowerShell → 不绑核不降优先级
//   ⑤ macOS → 明确 binding=none（不假装限了）
//   ⑥ 未知平台 → 不绑核
//   ⑦ 核数/掩码计算；ZC_ENGINE_CPU_CORES 生效、旧名不再生效
//   ⑧ 真实跑一次引擎：退出码透传（故意返回 7）、超时被杀、取消被杀、全局串行

import { createReporter } from './helpers/test-report.mjs';
import { cpuLimit, detectStrategy, engineStrategyInfo, planWrapper, runEngineProcess } from '../server/core/engineRunner.js';

const reporter = createReporter();
const { check } = reporter;

// ===== 一、平台分支（注入 platform 与探测结果，不依赖真实 OS）=====
const linuxTaskset = detectStrategy({ platform: 'linux', hasTaskset: true, hasNice: true, tasksetPath: '/bin/taskset', nicePath: '/bin/nice' });
const wrappedLinux = planWrapper({ command: '/bin/7z', args: ['t', '-y', '/tmp/a.7z'] }, { strategy: linuxTaskset, cpuList: '0,1' });
check('Linux+taskset：绑核到指定核列表，并叠加 nice -n 10',
  wrappedLinux.command === '/bin/taskset' && wrappedLinux.args.slice(0, 5).join(' ') === '-c 0,1 /bin/nice -n 10',
  `${wrappedLinux.command} ${wrappedLinux.args.join(' ')}`);
check('Linux+taskset：引擎命令与参数原样保留在末尾（退出码直通的前提）',
  wrappedLinux.args.slice(-4).join(' ') === '/bin/7z t -y /tmp/a.7z', wrappedLinux.args.slice(-4).join(' '));

const linuxNoTaskset = detectStrategy({ platform: 'linux', hasTaskset: false, hasNice: true, nicePath: '/bin/nice' });
const wrappedNoTaskset = planWrapper({ command: '/bin/unrar', args: ['x'] }, { strategy: linuxNoTaskset });
check('Linux 无 taskset：降级为只 nice，且策略里明说 binding=none',
  linuxNoTaskset.binding === 'none' && wrappedNoTaskset.command === '/bin/nice' && /未找到 taskset/.test(linuxNoTaskset.reason),
  `${wrappedNoTaskset.command} | ${linuxNoTaskset.reason}`);

const winPowerShell = detectStrategy({ platform: 'win32', hasPowershell: true, powershellPath: 'powershell' });
const wrappedWin = planWrapper({ command: 'C:/bin/7z.exe', args: ['t', '-y', 'C:/tmp/a.7z'] }, { strategy: winPowerShell, mask: '0x3' });
check('Windows+PowerShell：走 PowerShell 而不是 cmd /c start（start 不透传退出码）',
  wrappedWin.command === 'powershell' && !wrappedWin.args.includes('start'),
  `${wrappedWin.command} ${wrappedWin.args.slice(0, 2).join(' ')}`);
check('Windows+PowerShell：脚本里设 ProcessorAffinity、Idle 优先级，并以 exit $p.ExitCode 收尾',
  wrappedWin.args.join(' ').includes('ProcessorAffinity = [IntPtr]0x3')
    && wrappedWin.args.join(' ').includes("PriorityClass = 'Idle'")
    && wrappedWin.args.join(' ').includes('exit $p.ExitCode'),
  wrappedWin.args.join(' ').slice(-120));

const winNoPowerShell = detectStrategy({ platform: 'win32', hasPowershell: false });
const wrappedWinBare = planWrapper({ command: '7z.exe', args: ['t'] }, { strategy: winNoPowerShell });
check('Windows 无 PowerShell：不绑核不降优先级，命令原样执行',
  winNoPowerShell.binding === 'none' && wrappedWinBare.command === '7z.exe' && wrappedWinBare.args.join(' ') === 't',
  winNoPowerShell.reason);

const darwin = detectStrategy({ platform: 'darwin', hasNice: true, nicePath: '/usr/bin/nice' });
const wrappedDarwin = planWrapper({ command: '/usr/local/bin/7z', args: ['t'] }, { strategy: darwin });
check('macOS：明确 binding=none（无可用绑核手段，不假装限了）',
  darwin.binding === 'none' && /macOS 无可用绑核手段/.test(darwin.reason), darwin.reason);
check('macOS：仍降优先级（nice），命令里不含 taskset',
  wrappedDarwin.command === '/usr/bin/nice' && !wrappedDarwin.args.some((item) => item.includes('taskset')),
  `${wrappedDarwin.command} ${wrappedDarwin.args.join(' ')}`);

const unknown = detectStrategy({ platform: 'aix', hasNice: false });
check('未知平台：不绑核，且原因可读', unknown.binding === 'none' && /未知平台/.test(unknown.reason), unknown.reason);

// ===== 二、核数与掩码 =====
const limit = cpuLimit();
check('核数默认「总核数 − 1」且至少 1', limit.cores >= 1 && limit.cpuList.split(',').length === limit.cores, JSON.stringify(limit));
check('Windows 掩码 = (1<<核数)-1 的十六进制', limit.mask === `0x${((1 << limit.cores) - 1).toString(16)}`, limit.mask);

process.env.ZC_7Z_CPU_CORES = '2';
const legacyIgnored = cpuLimit();
process.env.ZC_ENGINE_CPU_CORES = '1';
const unified = cpuLimit();
delete process.env.ZC_ENGINE_CPU_CORES;
delete process.env.ZC_7Z_CPU_CORES;
check('ZC_ENGINE_CPU_CORES 生效', unified.source === 'ZC_ENGINE_CPU_CORES' && unified.cores === 1, `cores=${unified.cores} source=${unified.source}`);
check('旧名 ZC_7Z_CPU_CORES 不再生效（开发期不留双名字）',
  legacyIgnored.source === 'default', `cores=${legacyIgnored.cores} source=${legacyIgnored.source}`);

// ===== 三、真实跑进程：退出码透传 / 超时 / 取消 / 串行 =====
const exitSeven = await runEngineProcess({ command: process.execPath, args: ['-e', 'process.exit(7)'], timeoutMs: 20000, label: 'test-exit' });
check('退出码透传：引擎返回 7 → code=7（不被 taskset/nice 吞掉）', exitSeven.code === 7, `code=${exitSeven.code}`);

const stdoutEcho = await runEngineProcess({ command: process.execPath, args: ['-e', 'console.log("line-1"); console.log("line-2")'], timeoutMs: 20000, label: 'test-stdout' });
check('stdout 正常收集', /line-1/.test(stdoutEcho.stdout) && /line-2/.test(stdoutEcho.stdout), stdoutEcho.stdout.trim().slice(0, 60));

const lines = [];
await runEngineProcess({
  command: process.execPath,
  args: ['-e', 'for (let i = 0; i < 3; i += 1) console.log(`tick-${i}`)'],
  timeoutMs: 20000,
  onLine: (line) => lines.push(line),
  label: 'test-lines',
});
check('onLine 逐行回调可用（7z 的 -bb1 进度解析依赖它）', lines.filter((line) => line.startsWith('tick-')).length === 3, JSON.stringify(lines.slice(0, 4)));

const timeoutCase = await runEngineProcess({
  command: process.execPath,
  args: ['-e', 'setTimeout(() => {}, 60000)'],
  timeoutMs: 800,
  label: 'test-timeout',
});
check('超时：进程被杀且返回 timedOut=true', timeoutCase.timedOut === true, `timedOut=${timeoutCase.timedOut} code=${timeoutCase.code}`);

const controller = new AbortController();
setTimeout(() => controller.abort(), 500);
const abortCase = await runEngineProcess({
  command: process.execPath,
  args: ['-e', 'setTimeout(() => {}, 60000)'],
  timeoutMs: 30000,
  signal: controller.signal,
  label: 'test-abort',
});
check('取消：signal.abort 后进程被杀且返回 aborted=true', abortCase.aborted === true, `aborted=${abortCase.aborted}`);

// 串行：两个 600ms 的进程并发发起，总耗时应 ≥ 1200ms（说明没有并行）
const startedAt = Date.now();
await Promise.all([
  runEngineProcess({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 600)'], timeoutMs: 20000, label: 'serial-a' }),
  runEngineProcess({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 600)'], timeoutMs: 20000, label: 'serial-b' }),
]);
const elapsed = Date.now() - startedAt;
check('全局串行：两个引擎进程不会并行（并发发起总耗时 ≥ 1.1s）', elapsed >= 1100, `elapsed=${elapsed}ms`);

const info = engineStrategyInfo();
check('engineStrategyInfo()：能报出本平台的绑定方式与原因', typeof info.binding === 'string' && typeof info.reason === 'string',
  `${info.platform}/${info.binding}/cores=${info.cores}`);

reporter.summary();
