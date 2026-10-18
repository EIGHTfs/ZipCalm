# ZipCalm 压压惊

> 一个跑在 NAS 上的 Node.js 网页服务端：浏览文件目录、选择文件/文件夹压缩（多算法多格式）、带性能监控看板。
>
> 本仓库当前处于**开发中**：设计文档（`docs/`）与实现代码（`server/` + `web/`）并行推进，里程碑 M0~M4 已完成（见下方「当前进展」）。

## 名字的由来

| 维度 | 分析 |
|---|---|
| 双关 | **压** = 压缩文件，**压惊** = 安抚焦虑。NAS 空间不足本身就是一种「存储焦虑」，压完就「惊」了。 |
| 功能暗示 | 一听就知道跟「压缩」有关，不需要解释。 |

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/00-原始讨论完整转录.md](docs/00-原始讨论完整转录.md) | 两场设计讨论的逐字全文（含 AI 思考过程），原始存档 |
| [docs/01-需求与总体架构.md](docs/01-需求与总体架构.md) | 原始需求、决定架构的三个问题、必须想清楚的决策 |
| [docs/02-压缩格式与库选型.md](docs/02-压缩格式与库选型.md) | zip/tar/tar.gz/tar.zst 的库选型、库 vs 二进制、zstd 方案（Node 内置） |
| [docs/03-插件化架构与格式契约.md](docs/03-插件化架构与格式契约.md) | 每个格式一个格式包、插件契约、总入口职责边界 |
| [docs/04-压缩模式与黑名单.md](docs/04-压缩模式与黑名单.md) | 单独压缩/打包为一个、三层黑名单、智能跳过 |
| [docs/05-任务系统与进度推送.md](docs/05-任务系统与进度推送.md) | 后台任务、进度连续性、SSE 推送、状态落盘 |
| [docs/06-删除原文件与磁盘预检.md](docs/06-删除原文件与磁盘预检.md) | 先压→校验→再删、回收站、两倍空间预检 |
| [docs/07-性能监控看板.md](docs/07-性能监控看板.md) | 指标采集分层、采集频率、六个卡片 |
| [docs/08-前端布局设计.md](docs/08-前端布局设计.md) | 网盘式骨架、鼠标优先、触屏最小兼容、右键菜单 |
| [docs/09-API契约与APK铺路.md](docs/09-API契约与APK铺路.md) | API 规范、双认证、UUID、SSE、Range、错误码 |
| [docs/10-开源项目参考.md](docs/10-开源项目参考.md) | 9 个已克隆项目的可抄代码清单（文件:行号）+ 路径安全实现对比 |
| [docs/11-开发里程碑与验收标准.md](docs/11-开发里程碑与验收标准.md) | M0~M9 分步计划与逐条验收标准 |
| [docs/12-项目目录结构.md](docs/12-项目目录结构.md) | server/web/shared/docs/scripts/test 全目录设计 |
| [docs/M0/](docs/M0/README.md) | **M0 契约冻结（v1）**：API 规范 / 插件契约 / 数据模型 / 不变量清单 + 验收结论与拍板记录 |
| [docs/13-工期估算与模型分工.md](docs/13-工期估算与模型分工.md) | 工期估算（基于实测吞吐外推）+ 各阶段模型分工方案（主力 / 辅助） |
| [docs/14-工程执行约定.md](docs/14-工程执行约定.md) | 执行层约定：每任务收尾固定做「审计 + 顺手优化 / 全套验收 / 停服务 / 汇报」、契约优先、写入范围、常用命令、踩过的坑 |

## 当前进展

| 里程碑 | 状态 | 交付 |
|---|---|---|
| M0 契约冻结 | ✅ | API 规范 / 插件契约 / 数据模型 / 不变量清单（`docs/M0/`） |
| M1 骨架跑通 | ✅ | 目录浏览、登录鉴权、路径白名单与越界防护 |
| M2 单格式压缩 | ✅ | zip 压缩与解压（zip-slip 防护、绝不覆盖、假数据逐文件 hash 往返校验） |
| M3 任务系统 | ✅ | 任务落盘与崩溃恢复、串行队列、SSE 实时进度、任务记录保留策略与手动清理 |
| M4 多格式插件化 | ✅ | tar / tar.gz / tar.zst（Node 内置 zstd）+「加目录即注册」+ 启动自检 Node ≥ 22.15 |
| M5 删除原文件 | ✅ | 删除流程（校验通过 → 二次确认 → 进回收站 → 日志）；`waiting_confirm` 可取消 + 超时；`deleting` 前抢执行槽位；崩溃后启动对账 |
| M6 黑名单与预检 | ✅ | 三层黑名单（全局 15 条已压缩格式 / 用户自定义 / 任务级临时）+ 命中项跳过且不参与删除 + 磁盘剩余 < 待压 × 2 拒绝启动 |
| M7 ~ M9 | ⏳ | 性能看板 / 打磨与触屏 / **MT 管理器插件**（不做独立 APK：借 MT 的文件管理与 SMB 挂载，插件把"MT 压缩 SMB 文件是灰的"这个空白补上；插件内部「统一入口判定 + 本地压缩 / SMB 转发两个独立模块」） |

**已实现能力**（截至 M5）：

- 浏览器中浏览目录、多选、压缩（zip / tar / tar.gz / tar.zst）、解压（四格式通用，含 `.tar.gz` 这类复合扩展名识别）
- 后台任务：状态落盘、崩溃后自动标记中断并保留半成品、串行执行、SSE 推送进度、断线重连先拉快照再续序号
- **删除原文件**：校验通过才删；二次确认同时比对文件数与字节数；进回收站（可找回）而非真删；删除日志可追溯；中断后启动对账（文件安全在回收站）
- **黑名单与磁盘预检**：三层规则（全局 15 条已压缩格式 / 用户自定义 / 任务级临时），命中项**不进压缩包、也不参与删除**；选目录时实时提示「X 个文件已跳过」并标出命中规则与所在层；磁盘剩余不足「待压量 × 2」时任务直接拒绝启动
- 安全不变量：路径白名单（`..` / 绝对路径 / 盘符 / NUL / 符号链接一律拒绝）、绝不覆盖同名产物、删除前复核集合与文件状态（有变化就跳过）
- 能力自探测：格式可用性**真探测**（zstd 走「Node 内置 → 系统命令」回退链，都不可用则该格式置灰并说明原因）

**一键验收**：`bash scripts/test-all.sh` 跑八套（M1 不变量 / M2 往返 / M3 任务 / 崩溃恢复 / 边界探测 / 记录清理 / M4 多格式 / 构建门禁），当前全绿。

## 版本记录

版式：**里程碑完成升 minor（`0.x.0`）**，**修复与优化升 patch（`0.x.y`）**；`package.json` 与 `shared/app-version.js` 必须同值。

| 版本 | 里程碑 | 内容 |
|---|---|---|
| 0.6.0 | M6 | 三层黑名单（全局 15 条已压缩格式 / 用户自定义 / 任务级临时）：命中项**不进包也不参与删除**、跳过数实时提示、磁盘剩余 < 待压 × 2 拒绝启动 |
| 0.5.0 | M5 | 删除原文件：校验通过才删、二次确认比对 files+bytes、进回收站可找回、删除日志可追溯、中断后启动对账；`waiting_confirm` 可取消 + 超时（超时绝不等于确认）且不阻塞队列 |
| 0.4.0 | M4 | tar / tar.gz / tar.zst（zstd 走 Node 内置 `node:zlib`）；「加目录即注册」；启动自检 Node ≥ 22.15 |
| 0.3.0 | M3 | 任务落盘与崩溃恢复、串行队列、SSE 进度推送、任务记录保留策略与手动清理 |
| 0.2.0 | M2 | zip 压缩与解压（zip-slip 防护、绝不覆盖、假数据逐文件 hash 往返校验） |
| 0.1.0 | M0 ~ M1 | 契约冻结（API 规范 / 插件契约 / 数据模型 / 不变量清单）；骨架跑通（目录浏览、登录鉴权、路径白名单） |

> 每次提交前扫一眼本节与「当前进展」：**版本号升了吗？功能描述还跟得上代码吗？**

## 核心设计结论速览

1. **架构先定，库后选**：先回答「压缩同步还是异步」「产物落盘还是下载即弃」「单用户还是多用户」，再谈选型。
2. **库为主、全零依赖**：zip 用 archiver、tar 系列用 node-tar、zstd 走 Node ≥ 22.15 内置的 `node:zlib` —— 全部无原生编译，也不依赖用户额外安装压缩工具。
3. **插件化**：每个格式一个格式包（ext/create/list/test/available/estimate），格式包只负责「怎么压」，调度/删除/预检归总入口。
4. **两种压缩模式**：单独压缩（每个文件夹一个包）/ 打包为一个，做成互斥单选。
5. **后台任务 + 事件驱动进度**：任务状态落盘、SSE 推送、前端断线不影响任务，重连拉快照。
6. **删除原文件五步走**：压缩完成 → 校验 → 标记 → 待确认 → 进回收站，任何一步失败都不删。
7. **磁盘预检**：剩余空间 ≥ 待压文件 × 2；单独压缩模式按单文件夹滚动检查。
8. **看板只留 6 个指标**：CPU、内存、事件循环延迟、磁盘 IO、活跃任务、最近完成。
9. **前端借网盘骨架，压缩提到操作第一位**；网页端鼠标优先，触屏只做「长按=右键」最小兼容。
10. **API 从第一天为 APK 铺路**：/api/v1 版本化、任务 UUID、SSE、双认证、Range、机器可读错误码。

## 技术选型原则

**优先成熟的库，不为「少依赖」而自研轮子。**

- 前端：Vue 3（SFC）+ vue-router + pinia + axios + dayjs + pretty-bytes；图标 **lucide-vue-next**、看板图表 **uplot**；构建 Vite + @vitejs/plugin-vue
- 后端：Fastify；压缩 archiver（zip）/ node-tar（tar、tar.gz、tar.zst）；监控 systeminformation + pidusage
- 系统级：无（zstd 由 **Node ≥ 22.15 内置的 `node:zlib`** 提供；系统 `zstd` 命令仅作回退项）
- 不引入：7z / rar（v1 范围外）、数据库（用 JSON/JSONL 落盘）、p-queue（v1 强制串行）、UI 组件库 / Tailwind

**库收口策略（换库改动量最小化）**：第三方库只允许在**唯一入口** import，由 `npm run check:drift` 门禁钉死（已挂到 `build` 前，违规即构建失败）：

| 库 | 唯一入口 |
|---|---|
| `lucide-vue-next` | `web/src/components/common/Icon.vue` |
| `uplot` | `web/src/components/metrics/TrendChart.vue` |
| `axios` | `web/src/api/client.js` |
| `dayjs` / `pretty-bytes` | `web/src/utils/format.js` |
| 压缩库（archiver / node-tar） | 各自的格式包 `server/plugins/formats/<id>/` |

**框架级依赖（Vue / vue-router / pinia / Fastify）不做收口** —— 换框架等于重写，包一层适配只会增加间接层而无收益。
门禁扫描器为正则实现（剥离注释后匹配 `import` / `export-from` / 动态 `import()` / `require`），已知边界：不支持极端多行 import 与 TS 装饰器；需要更强保证时再评估引入 AST 解析器。

> 本项目**不追求零依赖**。取舍是「部署可靠 + 开发效率优先」：所有依赖均为纯 JS 或 Node 内置（zstd 走 `node:zlib`），无原生编译，NAS 上无需构建工具链。
> 运行时要求：**Node ≥ 22.15**（zstd 内置 API 自 v22.15.0 起提供；`fs.statfs` 自 v18.15 起）。
> 目录与框架约定见 [docs/12-项目目录结构.md](docs/12-项目目录结构.md) 第三节。

## 讨论来源

- https://chat.deepseek.com/share/g5al9q561a1ush4qgu
- https://chat.deepseek.com/share/snpfs66csaraldelit

两场讨论均为「只提建议、不写代码」的纯设计讨论，本文档集为逐字整理（见 docs/00）。

## 参考项目（第三方代码快照）

`参考项目/` 下是 10 个第三方开源项目的本地代码（9 个 git 克隆 + 1 个从 npm tarball 解压），用于精读可抄代码（见 [docs/10](docs/10-开源项目参考.md)）：

- 它们是**别人的代码**，不属于本项目产物，建议将来建仓时写进 `.gitignore`；
- 文档中的「文件:行号」绑定各仓库当时的 commit（commit 清单见 docs/10 第〇节），上游更新后行号会漂移；
- 其中一个项目（wfmanager）的路径防护实测存在缺陷，docs/10 已注明**只抄 UI 不抄安全逻辑**。

## 开发环境约束（依赖安装）

本工作区挂载在 NFS 上且带 `noexec`（`/tmp` 同样是 noexec），`node_modules` 里的原生二进制（esbuild 等）在工作区内无法执行；**直接在项目根执行 `npm install` 也会失败**——npm 10 的 reify 阶段会先删掉项目根的 `node_modules` 软链（日志：`npm warn reify Removing non-directory`），再在 noexec 盘建真实目录，随后 esbuild postinstall 报 `EACCES`。

因此依赖装在**可执行目录**（脚本自探测），项目根只保留一个指向它的软链：

```bash
bash scripts/setup-dev-deps.sh                                     # 幂等：未指定则自动探测可执行目录
ZIPCALM_BUILD_DIR=/some/exec/path bash scripts/setup-dev-deps.sh   # 显式指定（优先级最高）
```

- 依赖目录的确定顺序（`scripts/setup-dev-deps.sh` 的 `detect_build_dir`）：
  1. 环境变量 `ZIPCALM_BUILD_DIR`——先校验「可写 + 可执行」，不合格直接报错退出（不会默默换路径）；
  2. 自探测候选：项目根同级 `<父目录>/.zipcalm-build` → 从项目根**向上逐层**的 `<上层>/zipcalm-build` → `$TMPDIR/zipcalm-build`、`$HOME/.cache/zipcalm-build`（临时目录仅作兜底，可能被系统清理，重跑本脚本即可恢复）。
- **探测方式是「真写一个脚本并执行」**（`probe_exec_dir`）：noexec 挂载会被直接挡掉，所以不需要预先知道某个盘是不是 NFS、是不是 noexec；**脚本里没有任何机器专属的硬编码路径**。
- 软链：项目根 `node_modules` → `<依赖目录>/node_modules`；`package-lock.json` 落在依赖目录，不入库。
- 日常在项目根执行：`npm run dev`（开发服务，端口 5180）、`npm run build`（产物 `web/dist`）、`npm run preview`；后端服务用 `bash scripts/start.sh {start|stop|restart|status}`。
- **不要在项目根直接执行 `npm install` / `npm ci`**：会删掉软链并把依赖重新装到 noexec 盘。
- 源码始终留在工作区（`shared/`、`web/`、`server/`、`scripts/`、`package.json`）；依赖目录只是构建缓存，可随时重装。
- 忽略规则：`.gitignore` 忽略 `node_modules`（不带斜杠，同时匹配真实目录与软链）、`web/dist/`、`ZipCalm.pid`（运行时 PID 文件）、`storage/`（运行态数据与凭据配置）。

