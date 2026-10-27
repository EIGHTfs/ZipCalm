# 09 API 契约与移动端铺路

> 定位：API 契约、双认证、SSE / 错误码，以及移动端接入路径的取舍。
> 本文端点清单已与 `server/http/routes/` 核对（2026-10-24）；未实现项已标注。

## 一、需求

接口设计要为后续手机客户端留出空间：客户端能连上服务端完成同样的管理操作。

## 二、API 设计原则

**原则 1：Web 与客户端用同一套 API。** 不为客户端单独设计，两端消费同一个 API，只是 UI 呈现不同。

**原则 2：API 版本化。** 所有接口前缀 `/api/v1/`。破坏性变更加 `/api/v2/`，老客户端仍可用。

**原则 3：认证支持双通道。**

- Web：Session Cookie（浏览器自动管理）
- 客户端：Bearer Token
- 登录一次同时返回 session 与 token，两端各取所需

**原则 4：任务用稳定 ID。** 每个任务分配 UUID，断线重连后按 ID 查状态；任务状态独立于连接。

**原则 5：进度推送用 SSE。** Web 用 EventSource；客户端可用 SSE 库，实在不行降级为 1 秒轮询。不用 WebSocket —— 进度是单向推送，双向能力浪费。

**原则 6：文件流下载支持 Range。** ⚠️ **当前未实现**（见下节「实现状态」）。

## 三、实际端点清单

| 资源 | 端点 | 说明 |
|---|---|---|
| **认证** | `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/token/refresh` | 登录同时下发 cookie 与 token |
| **文件系统** | `GET /fs/list` · `GET /fs/stat` · `POST /fs/mkdir` · `POST /fs/rename` · `POST /fs/move` · `POST /fs/delete` · `GET /fs/search` · `GET /fs/volumes` | 全部支持 `rootId` 切换存储根 |
| **压缩** | `POST /compress/preflight` · `POST /compress/tasks` · `GET /compress/tasks/:id` · `POST /compress/tasks/:id/cancel` · `POST /compress/tasks/:id/confirm-delete` | 预检 → 建任务 → 查/取消/确认删除 |
| **解压** | `POST /extract/preflight` · `POST /extract/tasks` | |
| **任务** | `GET /tasks` · `GET /tasks/:id` · `GET /tasks/history` · `POST /tasks/:id/cancel` · `POST /tasks/:id/retry` · `POST /tasks/:id/confirm-delete` · **`GET /tasks/events`**（SSE） | |
| **黑名单** | `GET/POST /blacklist` · `GET/POST /blacklist/user` · `POST /blacklist/preview` | 三层规则的读改 + 命中预览 |
| **硬链接去重** | `POST /hardlink/scan` · `POST /hardlink/execute` | 扫描只读；执行需显式确认 |
| **监控** | `GET /metrics/snapshot` · `GET /metrics/history` | |
| **其它** | `GET /health`（含实际运行身份 `runtime`）· `GET /formats`（格式可用性 + 能力声明）· **`GET /capabilities/:id`**（能力插件元数据，如密码的可用算法与兼容性提示） | |

### 各端点的新增字段（2026-10-27，加密/7z/硬链接预检之后）

| 端点 | 新增字段 | 用途 |
|---|---|---|
| `GET /formats` | `capabilities[]`（含 `methods[]` 每个带 `compatibility` / `caveat` / `available`、以及 `params` schema） | 前端据此渲染密码开关与算法下拉；**格式没声明就不该显示该能力** |
| `GET /formats` | `extractOnly` | `true` = 只读格式（RAR）。前端压缩抽屉必须过滤掉，否则用户会选中它然后收到 `UNSUPPORTED_FORMAT` |
| `POST /compress/preflight` | `hardlinks: { groups, files, logicalBytes, duplicateBytes, preservedByFormat, estimatedBytes, hint }` | 选 ZIP 压含硬链接目录时提示「会各存一份、建议 TAR」；`hint=false` 表示不用提示（无硬链接或占比 <10%） |
| `POST /extract/preflight` | `encrypted` / `isAes` | 加密包标记，前端据此显示密码输入框（`encrypted=true` 且用户还没传密码时才置位） |

### 实现状态（与设计的差距）

| 设计提到 | 状态 |
|---|---|
| `GET /fs/download`（Range 断点续传） | ❌ **未实现** —— 后端无端点、前端无下载按钮 |
| `POST /fs/upload` | ❌ 未实现（非当前需求） |

> 下载未实现已登记于 [17-设计与实现差异记录](17-设计与实现差异记录.md)。

### 响应与错误码

- 统一响应：`{ ok, data, error }`
- 错误对象：`{ code, message }`，`code` 为机器可读枚举
  - 路径与权限：`PATH_NOT_FOUND` / `PATH_OUT_OF_ROOT` / `PERMISSION_DENIED` / `VALIDATION_FAILED` / `FILE_ACCESS_DENIED`
  - 任务与磁盘：`DISK_FULL` / `TASK_CONFLICT` / `TASK_NOT_FOUND`
  - **加密包三态（必须分开，不能一律报"损坏"）**：`MISSING_PASSWORD`（缺密码）/ `BAD_PASSWORD`（密码错）/ `ARCHIVE_CORRUPTED`（包损坏）
  - **引擎与能力**：`FORMAT_UNAVAILABLE`（格式不可用，如缺 unrar/7z）/ `SEVENZIP_MISSING`（缺 7z 无法解 AES）/ `UNSUPPORTED_FORMAT`（如对 RAR 发起压缩）/ `VERIFY_FAILED`（压完自测或解压前校验失败）
  - **文件冲突**：`TARGET_EXISTS`（目标已存在，绝不覆盖）
- **错误码比错误消息重要** —— 客户端拿到 `DISK_FULL` 可以弹专门引导，拿到字符串只能照显

## 四、为客户端铺路的约定（现在就要守）

1. **一切状态从 API 拉**：前端可有缓存，但数据源永远是 API，不存在「只有前端知道的状态」
2. **任务 ID 是 UUID**，不是数组下标
3. **进度用 SSE 推送**，不靠轮询
4. **认证双通道**：Web 用 Cookie，客户端用 Bearer Token
5. **下载支持 Range**（未实现，见 §三）
6. **API 版本化**：`/api/v1/` 前缀
7. **错误码可编程**

## 五、网页端与客户端的分工边界

| 逻辑 | 归属 | 说明 |
|---|---|---|
| 文件浏览、多选、参数收集 | 前端 | 各自实现，API 一致 |
| 压缩/解压执行 | 服务端 | 唯一实现 |
| 进度推送 | 服务端 | SSE 统一推，两端各自消费 |
| 黑名单匹配 | 服务端 | 不信任前端 |
| 磁盘预检 | 服务端 | 前端不参与 |
| 路径校验 | 服务端 | 前端传入的路径一律按白名单复核 |

**原则：交互归前端，业务归后端。** 两端 UI 可以不同，但调用的 API、提交的参数、收到的结果必须一致。

## 六、移动端路径的取舍

| 路径 | 说明 | 结论 |
|---|---|---|
| **A. WebView 包壳** | 一周能出，体验不如原生但自用够 | 备选 |
| **B. PWA** | 加 manifest + Service Worker 即可「添加到主屏幕」；iOS 支持有限 | **当前方向**（M9 待做） |
| **C. 原生开发**（Kotlin/Flutter） | 体验最好、工作量最大 | 仅在极致 UI 要求时考虑 |
| **D. MT 管理器插件** | 白嫖 MT 的文件管理/多选/双窗口/SMB 挂载；切入点：MT 原生不支持压缩 SMB 上的文件 | ❌ **已放弃**（见下） |

### 为什么放弃 MT 插件路线

调研（[docs/research/mt-plugin-feasibility.md](research/mt-plugin-feasibility.md)）结论：

- MT 插件 API v3 只有 4 类接口（TranslationEngine / TextEditorFunction / TextEditorFloatingMenu / TextEditorToolMenu），**没有文件菜单扩展点** —— 无法在文件管理器里加入自己的菜单项，这是该路线的致命前提
- 需要 MT VIP 才能开发
- jar 扫描确认：`smb` / `mount` / `share` / `file` 相关扩展点数量为 0

**因此 M9 回归 PWA 方案**：网页端在手机浏览器可用即可，「添加到主屏幕」顺手做，`manifest.json` / Service Worker 不作硬要求。

> 该调研保留在仓库中，若将来 MT 开放文件菜单扩展点可重新评估。

## 七、状态可恢复

Web 前端用路由，客户端需要状态可恢复：

- 打开后回到上次浏览的目录
- 若有未完成任务，提示「上次任务已中断，是否重试」
- 状态存 localStorage（Web）/ 本地存储（客户端）

这要求前端不依赖内存状态 —— 所有状态都能从 API 拉回，或从本地缓存恢复。

## 八、契约冻结（M0）交付物

- **API 规范**：每个端点的输入、输出、错误码；统一响应格式；错误码枚举
- **格式插件契约**：每个格式包必须实现的接口；边界（格式包只负责"怎么压"，不负责调度/删除/预检）
- **数据模型**：任务对象字段（UUID、状态机、进度结构）、黑名单结构、配置结构
- **不变量清单（最关键）**：删除前必须校验通过、任务状态落盘不依赖连接、路径必须过白名单、磁盘预检两倍规则

**M0 验收标准**：三份文档写完，换一个不熟悉项目的人读一遍就能说出怎么调用；错误码覆盖所有已知失败场景；插件契约方法签名确定，每个格式包能对号入座。

## 九、M9 现状

- 用 curl + Bearer Token 可完整跑通文件浏览 + 压缩 + 解压 + 搜索
- 所有错误码机器可读
- **PWA 未开始**（按需求排期在网页端完全开发完之后）

### POST /fs/repair-names —— 修复乱码文件名（PUA 转义还原）

```jsonc
// 请求
{ "rootId": "Download", "path": "/某目录", "dryRun": true, "maxDepth": 6, "maxEntries": 5000 }
// 响应
{ "path": "/某目录", "dryRun": true, "maxDepth": 6, "scanned": 3, "truncated": false,
  "candidates": [{ "from": "s7/￾￾….txt", "to": "s7/中文文件名.txt", "hex": "73372f…" }],
  "unrecoverable": [{ "path": "s7/????.txt", "reason": "lossy" }],
  "conflicts": [{ "from": "…", "to": "…", "reason": "target-exists" }],
  "counts": { "candidates": 2, "unrecoverable": 1, "conflicts": 0, "renamed": 0 },
  "renamed": 0 }
```

- **`dryRun` 默认 true**：不显式传 `false` 只出清单，不改任何文件
- `candidates` / `unrecoverable` / `conflicts` 列表最多各 50 条（`counts` 里的数量永远是精确值）
- **绝不覆盖**：目标已存在 → 进 `conflicts`，文件不动
- 跳过符号链接；路径过白名单（越界 → `PATH_OUT_OF_ROOT`）；只接受目录（文件 → `VALIDATION_FAILED`）
