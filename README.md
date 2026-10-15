# ZipCalm 压压惊

> 一个跑在 NAS 上的 Node.js 网页服务端：浏览文件目录、选择文件/文件夹压缩（多算法多格式）、带性能监控看板。
>
> 本仓库当前阶段只做**设计方案文档**，尚未开始写代码。

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
| [docs/02-压缩格式与库选型.md](docs/02-压缩格式与库选型.md) | zip/tar/tar.gz/tar.zst 的库选型、库 vs 二进制、zstd 风险 |
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

## 核心设计结论速览

1. **架构先定，库后选**：先回答「压缩同步还是异步」「产物落盘还是下载即弃」「单用户还是多用户」，再谈选型。
2. **库为主、zstd 用二进制**：zip 用 archiver、tar 系列用 node-tar、zstd 走外部二进制，别赌 NAS 上的原生编译。
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
- 系统级：`zstd` 命令（tar.zst 的默认实现，可用 WASM 兜底）
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

> 本项目**不追求零依赖**。取舍是「部署可靠 + 开发效率优先」：除 `zstd` 外全部依赖均为纯 JS，无原生编译，NAS 上无需构建工具链。
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

因此依赖装在**本机可执行盘**，项目根只保留一个指向它的软链：

```bash
bash scripts/setup-dev-deps.sh                                     # 幂等；依赖目录取脚本内默认值（本机可执行盘）
ZIPCALM_BUILD_DIR=/some/exec/path bash scripts/setup-dev-deps.sh   # 覆盖依赖目录（不写死路径）
```

- 依赖位置：`${ZIPCALM_BUILD_DIR:-<默认可执行盘路径>}/node_modules`（默认值见 `scripts/setup-dev-deps.sh`）；软链：项目根 `node_modules` → 该目录。
- `package-lock.json` 落在依赖目录，不入库。
- 日常在项目根执行：`npm run dev`（开发服务，端口 5180）、`npm run build`（产物 `web/dist`）、`npm run preview`。
- **不要在项目根直接执行 `npm install` / `npm ci`**：会删掉软链并把依赖重新装到 noexec 盘。
- 源码始终留在工作区（`shared/`、`web/`、`scripts/`、`package.json`）；依赖目录只是构建缓存，可随时重装。
- 忽略规则：`.gitignore` 用 `node_modules`（不带斜杠，同时匹配真实目录与软链两种形态）与 `web/dist/`，依赖目录与构建产物都不会入库。

