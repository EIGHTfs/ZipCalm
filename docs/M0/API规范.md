# M0 契约冻结 · API 规范（v1）

> 文档状态：**M0 冻结候选**（依据 `docs/11-开发里程碑与验收标准.md` 第三节 M0 交付物）
> 契约版本：`/api/v1/`（`docs/09` 约定 6）。M0 冻结后，**破坏性变更只能加 `/api/v2/`，v1 语义不再改**。
> 关联契约：[插件契约.md](插件契约.md) · [数据模型.md](数据模型.md) · [不变量清单.md](不变量清单.md)
> 本文自足：读完本文 + 数据模型，即可不看代码完成任一端点的调用。

---

## 一、全局约定

| 项 | 约定 | 依据 |
|---|---|---|
| 前缀 | 所有接口以 `/api/v1/` 开头 | docs/09 约定 6 |
| 编码 | 请求/响应均为 UTF-8 JSON（`application/json; charset=utf-8`） | docs/09 |
| 时间 | 一律 Unix **毫秒**整数（如 `1730000000000`） | docs/09 约定 1（状态可从 API 复现） |
| 字节 | 一律整数（bytes），不做单位换算；换算由前端做 | docs/12 `web/src/utils/format.js` |
| 路径 | 一律 **相对存储根的 POSIX 路径**：根为 `/`，子项如 `/photos/2024/a.jpg`。禁止反斜杠、禁止 `..` 段 | docs/06、docs/10（safePath / rootFn.resolve） |
| 认证 | 除 `/auth/login`、`/auth/logout`、`/health` 外**全部需要认证**；Session Cookie + Bearer Token 双通道 | docs/09 约定 4 |
| 幂等 | 见第三章各端点 `幂等` 列；`DELETE` 默认幂等 | docs/09 §三「幂等性」 |
| 错误 | 全部走统一错误码，禁止只返回字符串错误 | docs/09 约定 7 |
| SSE | 单向推送，端点 `/api/v1/tasks/events`；降级方案为 1 秒轮询任务列表 | docs/09 约定 3、docs/11 M3 |
| 下载 | 支持 HTTP Range（断点续传） | docs/09 约定 5 |
| 上传 | `/api/v1/fs/upload` 为**保留未实现**（v1 返回 `NOT_IMPLEMENTED`） | docs/09 §三「如果将来要」 |

### 1.1 统一响应结构

成功：

```json
{
  "ok": true,
  "data": { },
  "error": null
}
```

失败：

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "PATH_NOT_FOUND",
    "message": "路径不存在：/photos/missing",
    "details": { "path": "/photos/missing" }
  }
}
```

规则：

- `ok` 是布尔值，**唯一判定依据**（不要靠 HTTP 状态码分支，APK 同理）。
- 失败时 `data` 必须为 `null`；成功时 `error` 必须为 `null`。
- `error.code` 为机器可读枚举（第八章）；`error.message` 仅供人看；`error.details` 为可选对象（字段随错误码而定）。
- 过渡兼容：`docs/09` 第八节写作 `{ ok:false, code, message }`，本契约把它规范为「同一信息的嵌套写法」——`code`/`message` 落在 `error` 内层，顶层仍是 `{ ok, data, error }`（见第十章第 3 条）。

### 1.2 分页 / 排序 / 过滤

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `cursor` | string | 无 | 游标（上一页响应的 `data.nextCursor`），任务/历史列表用 |
| `limit` | int | 50 | 1~200 |
| `sort` | string | `name` | `name` / `size` / `mtime` |
| `order` | string | `asc` | `asc` / `desc` |
| `status` | string | 无 | 任务状态过滤，逗号分隔（如 `running,queued`） |

列表响应统一带分页信封：

```json
{ "ok": true, "data": { "items": [], "total": 0, "limit": 50, "nextCursor": null }, "error": null }
```

---

## 二、认证（Session + Bearer 双通道）

| 通道 | 载体 | 适用 | 有效期 | 落盘 |
|---|---|---|---|---|
| Session | Cookie `zc_session`（`HttpOnly`、`SameSite=Lax`、`Path=/api/v1`，HTTPS 时 `Secure`） | 网页前端 | 7 天滑动续期 | 服务端会话表（存哈希） |
| Bearer | 请求头 `Authorization: Bearer <token>` | APK / curl / 脚本 | 30 天 | `storage/auth-tokens.json` **只存 token 的 sha256 + 过期时间，不存明文** |

- 登录成功**一次返回两样**（Cookie 由 `Set-Cookie` 下发，`token` 在响应体里给 APK 用）。
- 两条通道同时存在时 **Bearer 优先**，Cookie 兜底。
- 凭据缺失/无效/过期分别返回 `AUTH_REQUIRED` / `AUTH_INVALID` / `AUTH_EXPIRED`（401），APK 据此决定「跳登录页」还是「先刷新 token」。
- 凭据明文**不得落盘**（docs/01 §五「Token/凭据落盘」）。

---

## 三、端点总表

`幂等`：✔ 表示重复调用结果一致；✖ 表示每次调用产生新资源。

### 3.1 认证

| 方法 | 路径 | 用途 | 幂等 |
|---|---|---|---|
| POST | `/api/v1/auth/login` | 登录，发 Cookie + Token | ✖ |
| POST | `/api/v1/auth/logout` | 登出，清 Cookie + 吊销 Token | ✔ |
| GET | `/api/v1/auth/me` | 当前登录身份 | ✔ |
| POST | `/api/v1/auth/token/refresh` | 换新 Token（Bearer） | ✖ |

### 3.2 文件系统

| 方法 | 路径 | 用途 | 幂等 |
|---|---|---|---|
| GET | `/api/v1/fs/list` | 列目录 | ✔ |
| GET | `/api/v1/fs/stat` | 单条目详情 | ✔ |
| GET | `/api/v1/fs/du` | 目录体积统计（压缩预估/预检用） | ✔ |
| POST | `/api/v1/fs/mkdir` | 新建目录 | ✔ |
| POST | `/api/v1/fs/rename` | 同目录改名 | ✔ |
| POST | `/api/v1/fs/move` | 移动（拖拽） | ✔ |
| POST | `/api/v1/fs/delete` | 删除（进回收站，非真删） | ✔ |
| GET / HEAD | `/api/v1/fs/download` | 下载（支持 Range） | ✔ |
| POST | `/api/v1/fs/upload` | **保留未实现** | — |

### 3.3 格式、压缩与任务

| 方法 | 路径 | 用途 | 幂等 |
|---|---|---|---|
| GET | `/api/v1/formats` | 格式列表 + 可用性（UI 置灰依据） | ✔ |
| POST | `/api/v1/compress/preflight` | 压缩预检（不建任务） | ✔ |
| POST | `/api/v1/compress/tasks` | 创建压缩任务 | ✖ |
| GET | `/api/v1/compress/tasks/{id}` | 单任务查询（别名，转发到 `/tasks/{id}`） | ✔ |
| POST | `/api/v1/compress/tasks/{id}/cancel` | 取消任务 | ✔ |
| POST | `/api/v1/compress/tasks/{id}/confirm-delete` | 二次确认后删除原文件 | ✔ |
| POST | `/api/v1/extract/preflight` | 解压预检（归档可读 / 目标目录可写 / 空间） | ✔ |
| POST | `/api/v1/extract/tasks` | 创建解压任务 | ✖ |
| POST | `/api/v1/tasks/{id}/confirm-delete` | **通用**二次确认删除（compress 删原文件 / extract 删压缩包共用同一实现；`/compress/tasks/{id}/confirm-delete` 为别名） | ✔ |
| DELETE | `/api/v1/tasks/{id}` | **删除任务记录**（仅终态：`failed`/`interrupted`/`aborted`/`done`；非终态返回 `INVALID_STATE`）。只从 `tasks.json`（活动记录）移除，**不删历史** | ✔ |
| GET | `/api/v1/tasks` | 任务列表（活动 + 历史） | ✔ |
| GET | `/api/v1/tasks/{id}` | 单任务查询（**唯一实现**） | ✔ |
| GET | `/api/v1/tasks/events` | SSE：任务进度 + 指标 | ✔ |

### 3.4 指标、黑名单、元信息

| 方法 | 路径 | 用途 | 幂等 |
|---|---|---|---|
| GET | `/api/v1/metrics/snapshot` | 最新一帧指标 | ✔ |
| GET | `/api/v1/metrics/history` | 最近 N 分钟环形缓冲 | ✔ |
| GET | `/api/v1/blacklist` | 三层黑名单读取 | ✔ |
| PUT | `/api/v1/blacklist/user` | 用户层黑名单全量替换 | ✔ |
| POST | `/api/v1/blacklist/preview` | 命中预览（压缩前提示"X 个已跳过"） | ✔ |
| GET | `/api/v1/health` | 健康与自检 | ✔ |

---

## 四、端点详述

### 4.1 认证

#### POST /api/v1/auth/login

请求：

```json
{ "username": "admin", "password": "***" }
```

响应 `200`：

```json
{
  "ok": true,
  "data": {
    "user": { "name": "admin" },
    "token": "<opaque-token>",
    "tokenExpiresAt": 1732592000000,
    "sessionExpiresAt": 1730604800000
  },
  "error": null
}
```

响应头：`Set-Cookie: zc_session=<id>; HttpOnly; SameSite=Lax; Path=/api/v1[; Secure]`

- `HttpOnly` + `SameSite=Lax` **始终开启**（防 XSS 读取、防跨站携带）。
- **`Secure` 按部署协议可配**（`auth.cookieSecure`）：HTTPS 部署必须开启；纯内网 HTTP 部署**不能开**（浏览器不会回传 Secure Cookie，登录会直接失效）。默认策略：**跟随请求协议探测**（反代下看 `X-Forwarded-Proto`），配置可显式覆盖。这是「参数化/配置化 + 自探测」在安全设置上的落地。

错误码：`VALIDATION_FAILED`(400)、`AUTH_INVALID`(401，用户名或密码错误)、`RATE_LIMITED`(429，连续失败登录)。

#### POST /api/v1/auth/logout

请求可选 `{ "allDevices": false }`。`allDevices:true` 时吊销该用户全部 token 与会话。
响应 `200`：`{ "ok": true, "data": { "loggedOut": true, "revokedTokens": 1 }, "error": null }`。幂等：未登录调用也返回成功。

#### GET /api/v1/auth/me

响应 `200`：

```json
{ "ok": true, "data": { "user": { "name": "admin" }, "authType": "bearer", "expiresAt": 1732592000000 }, "error": null }
```

`authType` ∈ `session` | `bearer`。

#### POST /api/v1/auth/token/refresh

请求头带旧 Bearer。响应 `200`：`{ "ok": true, "data": { "token": "<new>", "tokenExpiresAt": 1732592000000 }, "error": null }`。
旧 token 可选择立即失效（`{ "rotate": true }`，默认 true）。

### 4.2 文件系统

#### GET /api/v1/fs/list

| 查询参数 | 必填 | 说明 |
|---|---|---|
| `path` | 是 | 相对存储根路径，根为 `/` |
| `sort` / `order` | 否 | 见 1.2 |
| `showHidden` | 否 | 默认 `false`；`true` 时返回点文件（黑名单中的系统垃圾仍需标注） |

响应 `200`：

```json
{
  "ok": true,
  "data": {
    "path": "/photos/2024",
    "parent": "/photos",
    "entries": [
      {
        "name": "a.jpg",
        "path": "/photos/2024/a.jpg",
        "type": "file",
        "size": 1048576,
        "mtime": 1730000000000,
        "readable": true,
        "extension": ".jpg",
        "blacklisted": true,
        "blacklistLayer": "global"
      }
    ],
    "total": 1,
    "truncated": false
  },
  "error": null
}
```

- `type` ∈ `file` | `dir` | `symlink`。**符号链接不跟随**（`lstat`）；指向白名单之外的 symlink 返回 `type:"symlink"` + `enterable:false`，尝试进入时返回 `PATH_OUT_OF_ROOT`。
- `blacklisted`/`blacklistLayer` 由服务端计算（黑名单匹配归服务端，docs/09 §五）。
- `truncated:true` 表示命中 `limits.maxListEntries`，前端提示"条目过多，已截断"。
- > 1 万条目的目录允许分页（`cursor`/`limit`），但 M1 只要求能列出（docs/11 §四）。

错误码：`INVALID_PATH`(400)、`PATH_OUT_OF_ROOT`(403)、`PATH_NOT_FOUND`(404)、`NOT_A_DIRECTORY`(400)、`PERMISSION_DENIED`(403)。

#### GET /api/v1/fs/stat

`?path=/a/b.zip` → `data` 为单条目对象（字段同 `entries[]`，另加 `childCount`（目录）、`mime`（文件）、`archiveFormat`（若扩展名命中格式表））。

#### GET /api/v1/fs/du

`?path=/photos` → 递归统计，用于压缩预估与空间预检的**前端展示**（真正的预检以后端 `compress/preflight` 为准）。

```json
{ "ok": true, "data": { "path": "/photos", "totalBytes": 5368709120, "fileCount": 1200, "dirCount": 80, "skipped": [], "computedAt": 1730000000000 }, "error": null }
```

`skipped[]` 元素形如 `{ "path": "/photos/loop", "reason": "SYMLINK_LOOP" }`（不可读目录跳过而不中断，对齐 docs/10 kadi `calculateDirectorySize`）。

#### POST /api/v1/fs/mkdir

`{ "path": "/newdir" }` → `200 { "ok": true, "data": { "path": "/newdir" }, "error": null }`。
幂等：目录已存在 → `ok:true` + `data.created:false`。错误：`PATH_NOT_FOUND`（父目录不存在）、`PERMISSION_DENIED`、`TARGET_EXISTS`（同名文件占位）。

#### POST /api/v1/fs/rename

`{ "path": "/a.txt", "newName": "b.txt" }` → `data` 为新路径。仅同目录改名；`newName` 不含 `/`。
冲突 → `TARGET_EXISTS`(409)，**绝不覆盖**。

#### POST /api/v1/fs/move

`{ "paths": ["/a", "/b.txt"], "targetDir": "/backup" }`

```json
{ "ok": true, "data": { "moved": ["/backup/a", "/backup/b.txt"], "skipped": [] }, "error": null }
```

- v1 为**同步操作**（单用户、MVP）；单次 ≤ `limits.maxMoveItems`（默认 200），超限 → `VALIDATION_FAILED`。
- 跨分区（`EXDEV`）→ `CROSS_DEVICE_UNSUPPORTED`(409)，提示改用「复制 + 删除原文件」。
- 目标已存在同名 → `TARGET_EXISTS`(409)，整批拒绝（不做部分移动）。

#### POST /api/v1/fs/delete

`{ "paths": ["/a.txt", "/dir"] }`

```json
{ "ok": true, "data": { "deleted": ["/a.txt"], "failed": [{ "path": "/dir", "code": "PERMISSION_DENIED" }], "trashBatch": "<batchId>" }, "error": null }
```

- **进回收站、不是真删**（统一走 `core/compress/deleter.js`，与 M5 删除原文件同一机制）；`trashBatch` 指向 `storage/trash/<batchId>/`，可恢复。
- 幂等：路径不存在 → 计入 `deleted`（`{ "path": "...", "missing": true }` 记在 `data.notFound`），整体仍 `ok:true`。

#### GET /api/v1/fs/download（含 Range）

见第六章。

### 4.3 格式与压缩

#### GET /api/v1/formats

```json
{
  "ok": true,
  "data": {
    "formats": [
      { "id": "zip",     "ext": ".zip",     "mime": "application/zip", "name": "ZIP",     "available": true,  "unavailableReason": null, "default": true },
      { "id": "tar",     "ext": ".tar",     "mime": "application/x-tar", "name": "TAR",   "available": true,  "unavailableReason": null, "default": false },
      { "id": "targz",   "ext": ".tar.gz",  "mime": "application/gzip", "name": "TAR.GZ", "available": true,  "unavailableReason": null, "default": false },
      { "id": "tarzst",  "ext": ".tar.zst", "mime": "application/zstd", "name": "TAR.ZST","available": false, "unavailableReason": "系统未找到 zstd 可执行文件", "default": false }
    ]
  },
  "error": null
}
```

UI 规则（对齐 M4 验收）：`available:false` → 选项**置灰**并展示 `unavailableReason` 作为悬停提示。

#### POST /api/v1/compress/preflight

**这是压缩前的一次性演练，不创建任务、不写盘。** 服务端在这里完成：路径白名单 → 可读/可写权限 → 黑名单命中 → 体积统计 → 磁盘预检（≥ 2 倍）。

请求：

```json
{
  "sources": ["/photos/2024", "/notes.txt"],
  "mode": "single",
  "format": "zip",
  "options": { "level": 6, "outputDir": "/photos/2024", "blacklist": { "enabled": true, "extraPatterns": ["*.bak"] } }
}
```

`mode` ∈ `single`（每个源各一个包） | `bundle`（合成一个包）（docs/04、数据模型第四章）。

响应 `200`（`ok:true` 不代表一定能压，要看 `data.canProceed`）：

```json
{
  "ok": true,
  "data": {
    "canProceed": true,
    "mode": "single",
    "format": "zip",
    "totalBytes": 5368709120,
    "estimatedOutputBytes": 2147483648,
    "requiredBytes": 10737418240,
    "freeBytes": 21474836480,
    "preflightFactor": 2,
    "items": [
      { "path": "/photos/2024", "name": "2024", "kind": "dir", "size": 5368709120, "exists": true, "readable": true, "writableParent": true, "willSkip": false, "skipReason": null }
    ],
    "skipped": [ { "path": "/photos/2024/thumb.jpg", "pattern": "*.jpg", "layer": "global" } ],
    "packages": [ { "source": "/photos/2024", "outputPath": "/photos/2024/2024.zip", "estimatedBytes": 1610612736 } ],
    "warnings": []
  },
  "error": null
}
```

- `requiredBytes` 定义见 [不变量清单.md](不变量清单.md) INV-04；`single` 模式为**逐包滚动检查**（docs/06 §三），因此 `single` 下 `packages[].estimatedBytes` 参与滚动判定，`requiredBytes` 为「当前待压包 × 2」的最大值。
- 拒绝时（`canProceed:false`）返回 HTTP `200` + `ok:true`，业务原因放 `data.blockedReason`（形如 `{ "code": "DISK_FULL", "message": "…" }`）；也可直接以 HTTP `507` + `ok:false` 返回——**两种由同一实现统一出口，前端只需认 `error.code` 或 `data.blockedReason.code`**（推荐实现：预检接口统一 `ok:true`，`canProceed` 表达业务结论；创建任务接口统一 `ok:false`）。
- 硬错误（路径/权限/格式不可用）仍走 `ok:false`：`PATH_OUT_OF_ROOT`、`PATH_NOT_FOUND`、`PERMISSION_DENIED`、`UNSUPPORTED_FORMAT`、`FORMAT_UNAVAILABLE`。

#### POST /api/v1/compress/tasks（创建任务）

请求：

```json
{
  "sources": ["/photos/2024"],
  "mode": "single",
  "format": "zip",
  "options": {
    "level": 6,
    "keepOriginal": true,
    "deleteConfirmed": false,
    "outputDir": null,
    "blacklist": { "enabled": true, "extraPatterns": [] },
    "clientRequestId": "<uuid>"
  }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `single` | `single` \| `bundle`（docs/04） |
| `format` | `zip` | 必须是 `/formats` 返回的 `id` |
| `options.keepOriginal` | `true` | **默认保留原文件**（docs/06 §一）；`false` 表示勾选了删除原文件 |
| `options.deleteConfirmed` | `false` | `true` = 提交时已二次确认，任务压完校验通过后**自动进入删除阶段**；`false` 则停在 `waiting_confirm` 等用户调 `confirm-delete` |
| `options.clientRequestId` | null | 幂等键：相同值 60 秒内重复提交返回同一任务（防双击） |
| `options.level` | 格式默认 | 超出 `levelRange` → `VALIDATION_FAILED` |

响应 `201`：`data` 为**任务对象**（字段见 [数据模型.md](数据模型.md) 第二章）：

```json
{ "ok": true, "data": { "task": { "id": "<uuid>", "status": "queued", "phase": "precheck", "...": "..." } }, "error": null }
```

错误码：`PATH_OUT_OF_ROOT`、`PATH_NOT_FOUND`、`PERMISSION_DENIED`、`UNSUPPORTED_FORMAT`、`FORMAT_UNAVAILABLE`(503)、`TASK_CONFLICT`(409)、`DISK_FULL`(507)、`ALL_SOURCES_SKIPPED`(422)、`VALIDATION_FAILED`(400)。

- **创建即预检**：预检不通过**不建任务、不入队**（避免"排队后秒失败"的噪音任务）；预检细节见上一条。
- **`TASK_CONFLICT`** 触发条件（对齐参考实现 `taskManager.ts:92-125` + `:403-408`）：新任务的源路径或目标路径，与任一 `queued`/`running`/`cancelling` 任务的源/目标路径**相等或互为父子**。
- **`DISK_FULL`** 与状态机的关系见 [数据模型.md](数据模型.md) 第三章「错误码 × 状态」自洽表。

#### POST /api/v1/compress/tasks/{id}/cancel

响应 `200`：`data.task`（`status` 变为 `cancelling`）。
- 仅 `queued` / `running` 且 `phase ∈ {precheck, scanning, compressing, verifying}` 可取消 → 否则 `TASK_NOT_CANCELLABLE`(409)。
- 取消通过 `AbortSignal` 通知执行器（不杀进程）；执行器清理 `.part` 半成品后任务进入 `aborted`。
- 幂等：已是 `aborted` → `ok:true`；已 `done`/`failed` → `TASK_NOT_CANCELLABLE`。

#### POST /api/v1/compress/tasks/{id}/confirm-delete

请求：`{ "confirm": true, "expectedFiles": 120, "expectedBytes": 5368709120 }`

- 用户在二次确认弹窗里看到"将删除 N 个文件、共 X GB"（docs/06 §一），把这两个数字回传，服务端比对不通过则拒绝（防 UI 与实际不一致）。
- 仅当任务 `phase === "waiting_confirm"` 时有效，否则 `INVALID_STATE`(409)。
- 响应 `200`：`data.task`（进入 `deleting`）。
- 若用户放弃删除 → 不动原文件，任务保持 `done`，`delete.status` 置 `skipped`。

#### GET /api/v1/tasks 与 GET /api/v1/tasks/{id}

- 列表：`?status=queued,running&limit=50&cursor=`；返回 `data.items[]`（任务摘要）+ `data.queue`（`{ active: "<id|null>", waiting: 3, parallel: false }`）+ `data.nextCursor`。
- 单任务：返回完整任务对象（含 `progress`、`result`、`delete`、`error`）。
- **未完成任务的实时进度以本接口 + SSE 为准**，前端不得缓存为唯一来源（docs/09 约定 1）。
- 别名：`GET /api/v1/compress/tasks/{id}` 与 `{id}` 同义，实现上转发到本端点（避免两份逻辑）。

#### GET /api/v1/tasks/events（SSE）

见第五章。

### 4.4 指标

#### GET /api/v1/metrics/snapshot

```json
{
  "ok": true,
  "data": {
    "ts": 1730000000000,
    "system": { "cpuPercent": 12.4, "memUsedBytes": 8589934592, "memTotalBytes": 17179869184, "diskReadBps": 1048576, "diskWriteBps": 524288 },
    "process": { "cpuPercent": 3.1, "rssBytes": 134217728, "heapUsedBytes": 62914560, "eventLoopDelayMs": 1.8, "eventLoopUtilization": 0.06, "uptimeMs": 86400000 },
    "tasks": { "active": 1, "queued": 0, "parallel": false }
  },
  "error": null
}
```

#### GET /api/v1/metrics/history

`?window=300&step=5` → `data.samples[]`，每帧同 `snapshot` 结构；环形缓冲只保留最近 5 分钟（docs/07 §三）。

采集频率（契约）：系统指标 **5s**、进程指标 **1s**、前端轮询 **2s**（docs/07 §二）。看板**只允许这 6 张卡片**对应的字段（docs/07 §四）。

### 4.5 黑名单

#### GET /api/v1/blacklist

```json
{
  "ok": true,
  "data": {
    "global": { "locked": true, "enabled": true, "patterns": ["*.jpg", "*.jpeg", "*.png", "*.mp4", "*.zip", "*.7z", "*.rar", "*.gz", "*.docx", "*.xlsx", "Thumbs.db", ".DS_Store", "@eaDir"] },
    "user": { "enabled": true, "patterns": ["*.bak"], "updatedAt": 1730000000000 },
    "effectiveCount": 14
  },
  "error": null
}
```

#### PUT /api/v1/blacklist/user

`{ "patterns": ["*.bak", "*.tmp"], "enabled": true }` → 全量替换（幂等）。校验：单条 ≤ 128 字符、总数 ≤ 200、拒绝绝对路径与 `/`。响应返回替换后的 `data.user`。

#### POST /api/v1/blacklist/preview

`{ "paths": ["/photos"], "extraPatterns": [] }` → `data.skipped[]`（`{ path, pattern, layer }`）与 `data.kept[]`，供压缩设置抽屉显示「X 个文件已跳过（已压缩格式）」（M6 验收）。

### 4.6 元信息

#### GET /api/v1/health

```json
{
  "ok": true,
  "data": {
    "version": "0.1.0",
    "startedAt": 1729900000000,
    "bootId": "<uuid>",
    "storage": { "root": "<storageRoot>", "writable": true, "freeBytes": 21474836480 },
    "formats": { "total": 4, "available": 3, "unavailable": ["tarzst"] },
    "tasks": { "active": 0, "queued": 0, "interruptedSinceBoot": 1 }
  },
  "error": null
}
```

`bootId` 每次进程启动重新生成，用于前端识别"服务已重启、任务可能中断"。

---

## 五、SSE 端点

```
GET /api/v1/tasks/events?channels=tasks,metrics&since=<seq>
Accept: text/event-stream
```

响应头（缺一不可，`X-Accel-Buffering` 是反代下不被缓冲的关键，对齐 docs/10 §二.2 的 sse.ts）：

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

事件类型：

| event | 载荷 | 时机 |
|---|---|---|
| `snapshot` | `{ tasks: Task[], queue: {...}, metrics?: {...}, seq }` | **连接建立后立即发一次**（重连拉快照，docs/05 §三.2） |
| `task` | `{ task: Task, seq }` | 任务进度/状态变化；进度节流 ≥ 100ms |
| `metrics` | `{ sample: {...}, seq }` | `channels` 含 `metrics` 时，2s 一帧 |
| `heartbeat` | `{ ts }` | 每 15s，防中间设备断连 |
| `error` | `{ code, message }` | 订阅目标不存在 / 服务端即将关闭（`SERVICE_UNAVAILABLE`） |

报文样例：

```
id: 1042
event: task
data: {"task":{"id":"<uuid>","status":"running","phase":"compressing","progress":{...}},"seq":1042}

```

契约规则：

1. **进度是"状态"不是"消息"**（docs/05 §三.2）：客户端任何时候断线，重连后先收 `snapshot` 再收增量；丢事件不丢状态。
2. `seq` 单调递增；客户端重连可带 `since=<seq>`。若 `since` 早于服务端保留窗口（默认 1000 条），服务端直接发 `snapshot` 并忽略 `since`。
3. 单个连接最多订阅 1 个频道集合；`channels` 默认 `tasks`。
4. 服务端写失败即剔除该订阅者（自愈），不因单个死连接影响其他订阅者（对齐参考实现 `broadcast()` 的 `deadSubscribers`）。
5. **任务执行与 SSE 无耦合**：零订阅者时任务照常执行、照常写盘（[不变量清单.md](不变量清单.md) INV-02）。
6. 降级：客户端不支持 SSE 时，用 `GET /api/v1/tasks?status=...` 1 秒轮询（docs/09 约定 3）。

---

## 六、下载与 Range

```
GET /api/v1/fs/download?path=/photos/2024/2024.zip
Range: bytes=1048576-2097151
```

### 6.1 完整下载

响应 `200`：

```
Accept-Ranges: bytes
Content-Type: application/zip
Content-Length: 1610612736
Content-Disposition: attachment; filename="2024.zip"; filename*=UTF-8''2024.zip
```

`Content-Type` 取值顺序：格式包的 `mime`（扩展名命中 `/formats` 时） → 系统探测 → `application/octet-stream`。

### 6.2 断点续传

请求带 `Range: bytes=<start>-<end>`（`end` 可省，表示到文件末尾）：

- 可满足 → `206 Partial Content`，附 `Content-Range: bytes <start>-<end>/<total>`。
- 不可满足（`start >= total`）→ `416`，附 `Content-Range: bytes */<total>`，错误体：

```json
{ "ok": false, "data": null, "error": { "code": "RANGE_NOT_SATISFIABLE", "message": "请求区间超出文件大小", "details": { "totalBytes": 1610612736 } } }
```

契约规则：

1. 必须支持 `Range`、`If-Range`、`HEAD`；`HEAD` 返回与 `GET` 相同的头、无 body（docs/09 约定 5）。
2. 流式发送，禁止把大文件整体读入内存；`Content-Length` 必须精确（断点续传依赖它）。
3. `.part` 半成品**不可下载** → `INVALID_STATE`(409)「产物尚未完成」，防止用户拿到损坏压缩包。
4. 压缩任务进行中查询产物 → 同上；未开始的产物路径 `PATH_NOT_FOUND`。
5. 中文/特殊字符文件名按 RFC 5987 输出 `filename*`。

---

## 七、快速上手（换个人也能跑通）

```bash
# 1) 健康检查（免认证）
curl -s http://<nas-host>:<port>/api/v1/health

# 2) 登录，拿 Cookie + Bearer
curl -s -c cookie.txt -X POST http://<nas-host>:<port>/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"***"}'
# 响应体里的 token 即 Bearer；cookie.txt 里是 zc_session

# 3) 列目录（Session 通道，靠 cookie.txt）
curl -s -b cookie.txt 'http://<nas-host>:<port>/api/v1/fs/list?path=/'

# 4) 列目录（Bearer 通道，APK/脚本用）
curl -s -H 'Authorization: Bearer <token>' \
  'http://<nas-host>:<port>/api/v1/fs/list?path=/photos'

# 5) 预检：2 倍空间 + 权限 + 黑名单命中
curl -s -H 'Authorization: Bearer <token>' -X POST \
  http://<nas-host>:<port>/api/v1/compress/preflight \
  -H 'Content-Type: application/json' \
  -d '{"sources":["/photos/2024"],"mode":"single","format":"zip"}'

# 6) 创建任务 → 拿 task.id
curl -s -H 'Authorization: Bearer <token>' -X POST \
  http://<nas-host>:<port>/api/v1/compress/tasks \
  -H 'Content-Type: application/json' \
  -d '{"sources":["/photos/2024"],"mode":"single","format":"zip","options":{"keepOriginal":true}}'

# 7) 实时进度（SSE）
curl -N -H 'Authorization: Bearer <token>' \
  'http://<nas-host>:<port>/api/v1/tasks/events?channels=tasks'

# 8) 断点续传下载
curl -H 'Authorization: Bearer <token>' -H 'Range: bytes=0-1048575' \
  -o part1.bin 'http://<nas-host>:<port>/api/v1/fs/download?path=/photos/2024/2024.zip'
```

---

## 八、错误码枚举

HTTP 状态与错误码是**多对一**关系（同一状态可对应多个码），客户端只认 `error.code`。

| code | HTTP | 含义 | 触发场景 | 客户端建议动作 |
|---|---|---|---|---|
| `BAD_REQUEST` | 400 | 请求不可解析 | JSON 语法错误、缺少必填字段 | 提示并阻止重试 |
| `VALIDATION_FAILED` | 400 | 字段校验失败 | 超限、枚举非法、`newName` 含 `/` | 高亮字段 |
| `INVALID_PATH` | 400 | 路径形态非法 | 不以 `/` 开头、含 `..` 段、含 null 字节、超长 | 拒绝提交 |
| `PATH_OUT_OF_ROOT` | 403 | 越出存储根 | `../`、`%2e%2e`、symlink 指向根外、前缀绕过（`/data-evil` vs `/data`） | 提示"无权访问该路径" |
| `PATH_NOT_FOUND` | 404 | 路径不存在 | ENOENT | 刷新列表 |
| `NOT_A_DIRECTORY` | 400 | 期望目录 | 对文件调 `fs/list` | 提示 |
| `PERMISSION_DENIED` | 403 | 无权限 | EACCES / EPERM | 提示检查 NAS 权限 |
| `AUTH_REQUIRED` | 401 | 未带凭据 | 无 Cookie 且无 Bearer | 跳登录 |
| `AUTH_INVALID` | 401 | 凭据无效 | 密码错、token 未知 | 跳登录 |
| `AUTH_EXPIRED` | 401 | 凭据过期 | session/token 过期 | 先 `token/refresh`，失败再跳登录 |
| `FORBIDDEN` | 403 | 已认证但被策略拒绝 | 保留（单用户预留） | 提示 |
| `TASK_NOT_FOUND` | 404 | 任务不存在 | id 未知或历史已过期 | 回任务列表 |
| `TASK_CONFLICT` | 409 | 与在途任务路径冲突 | 源/目标路径相等或互为父子 | 提示"该路径正在被任务使用" |
| `TASK_NOT_CANCELLABLE` | 409 | 当前状态不可取消 | 已 `done`/`failed`/`aborted` | 刷新任务状态 |
| `INVALID_STATE` | 409 | 状态机不允许该操作 | 非 `waiting_confirm` 时 `confirm-delete`；下载 `.part` | 刷新状态 |
| `TARGET_EXISTS` | 409 | 目标已存在 | 改名/移动/产物命名冲突（**绝不覆盖**） | 提示改名 |
| `CROSS_DEVICE_UNSUPPORTED` | 409 | 跨分区移动 | `EXDEV` | 提示改用复制+删除 |
| `UNSUPPORTED_FORMAT` | 400 | 格式 id 未知 | `/formats` 之外的值 | 刷新格式列表 |
| `FORMAT_UNAVAILABLE` | 503 | 格式当前不可用 | `available() === false`（如 zstd 二进制缺失） | 该选项置灰 |
| `DISK_FULL` | 507 | 空间不足 | 预检 `free < requiredBytes`；运行中 `ENOSPC` | 提示清理空间；任务失败可重试 |
| `QUOTA_EXCEEDED` | 507 | 达到配额 | NAS 卷配额满（`EDQUOT`） | 提示配额 |
| `VERIFY_FAILED` | 422 | 压缩包校验不通过 | `test()` 失败 → **原文件绝不删除** | 展示失败项 |
| `ARCHIVE_CORRUPTED` | 422 | 压缩包无法解析 | `list()`/`test()` 抛错 | 提示重压 |
| `ALL_SOURCES_SKIPPED` | 422 | 无可压缩文件 | 全部命中黑名单 | 提示关闭黑名单或换文件 |
| `SCAN_LIMIT_EXCEEDED` | 400 | 条目/深度超限 | 超过 `limits.maxScanEntries` | 缩小范围重试 |
| `RANGE_NOT_SATISFIABLE` | 416 | Range 越界 | `start >= total` | 用响应里的 `totalBytes` 重试 |
| `NOT_IMPLEMENTED` | 501 | 端点未实现 | `/fs/upload` | 隐藏入口 |
| `SERVICE_UNAVAILABLE` | 503 | 服务不可用 | 启动中/优雅关闭中 | 稍后重试（SSE 会收到 `error` 事件） |
| `RATE_LIMITED` | 429 | 频率限制 | 连续登录失败 | 稍后重试 |
| `INTERNAL_ERROR` | 500 | 未预期异常 | 兜底 | 提示并附 `details.traceId` |

**任务内专用码**（只出现在任务对象的 `error.code` / `delete.error.code` 里，HTTP 层不会返回，但同样属于 `shared/error-codes.js` 枚举，供前后端统一分支）：

| code | 含义 | 出现位置 |
|---|---|---|
| `INTERRUPTED` | 服务重启/崩溃导致任务中断（`details.reason = "SERVER_RESTART"`） | `task.error.code`（`status === 'interrupted'`） |
| `ABORTED` | 执行器响应取消信号后的内部收尾错误（任务终态为 `aborted` 时 `error` 为 `null`，此码仅用于日志/内部传递） | 执行器内部 + `delete.error.code` |

补充规则：

- 4xx 一律为「客户端可修正」；5xx 中只有 `DISK_FULL`/`QUOTA_EXCEEDED`/`FORMAT_UNAVAILABLE`/`SERVICE_UNAVAILABLE` 允许「重试」。
- 所有 code 同时写入 `server/lib/errors.js` 与 `shared/error-codes.js`，两端 import 同一份（docs/12 §四）。
- 新增 code 属于**非破坏性**变更，但要同时更新本表与 `shared/`。

---

## 九、错误码 × 任务状态自洽表

（状态机定义见 [数据模型.md](数据模型.md) 第三章；本表用于证明「枚举与状态机自洽」）

| 场景 | 任务是否创建 | 任务状态 | `task.error.code` | HTTP |
|---|---|---|---|---|
| 路径越界 / 不存在 / 无权限 | ❌ 不创建 | — | — | 403 / 404 / 403 |
| 格式不可用 | ❌ 不创建 | — | — | 503 |
| 与在途任务冲突 | ❌ 不创建 | — | — | 409 |
| 预检空间不足 | ❌ 不创建 | — | — | 507 |
| 全部被黑名单跳过 | ❌ 不创建 | — | — | 422 |
| 运行中写盘 `ENOSPC` | ✅ 已创建 | `failed` | `DISK_FULL` | （任务内） |
| 运行中源文件被删 | ✅ | `failed` | `PATH_NOT_FOUND` | （任务内） |
| 压缩包校验失败 | ✅ | `failed` | `VERIFY_FAILED` | （任务内） |
| 用户取消 | ✅ | `cancelling` → `aborted` | 无（`error` 为 null） | （任务内） |
| 服务重启时在途 | ✅ | `interrupted` | `INTERRUPTED`（details.reason = `SERVER_RESTART`） | （任务内） |
| 压缩成功但删除原文件失败 | ✅ | `done` 且 `delete.status = failed` | `delete.error.code`（如 `PERMISSION_DENIED`） | （任务内） |

> `INTERRUPTED` 也属于错误码枚举（补录于上表，供任务内 `error.code` 使用；HTTP 层不会返回它）。

---

## 十、与既有文档的出入（显式声明）

M0 允许「新增细化」，但**不允许静默偏离**。以下是与 `docs/01~12` 的差异点，逐条给出理由；无差异的项即完全遵循。

| # | 既有文档说法 | 本契约写法 | 性质 | 理由 |
|---|---|---|---|---|
| 1 | docs/11 §三、docs/09 §九列了「三个文档」 | 本项目的 M0 交付为**四份**：API 规范 / 插件契约 / 数据模型 / 不变量清单 | 细化 | docs/11 §三把「不变量清单」单列为交付物且标注"最关键"；task-1 亦要求四份。「三个文档」指前三个文档参与"陌生人可读"测试 |
| 2 | docs/09 §三表用 `/api/v1/compress/events`，§八.4 与 docs/11 M3 用 `/api/v1/tasks/events` | **唯一 SSE 端点 = `/api/v1/tasks/events`** | 冲突消解 | 两处（§八.4 + M3）重复出现，且 docs/12 `routes/tasks.js` 承载 SSE；`/compress/events` 视为同一端点的旧名 |
| 3 | docs/09 §八.3 `{ ok:false, code, message }` | `{ ok, data, error }`，其中 `error = { code, message, details? }` | 措辞统一 | M0 准绳（docs/11 §三）要求 `{ ok, data, error }`；`code/message` 保留但移到 `error` 内层，信息不丢、APK 仍可编程 |
| 4 | docs/09 §三列出 `/api/v1/fs/upload` | 保留但**未实现**（501） | 范围界定 | 原文即"如果将来要"；M0 不冻结上传契约 |
| 5 | docs/07「前端 2 秒轮询 `/api/metrics`，别用 WebSocket 推」 vs docs/11 M7「SSE 推送（与任务系统复用）」 | 双通道：`/metrics/snapshot` 轮询 + `/tasks/events?channels=metrics` SSE；**前端默认 2s 轮询** | 冲突消解 | docs/07 是"轮询优先"的结论，M7 要求复用任务 SSE；两者都保留，默认行为按 docs/07，保证看板独立性 |
| 6 | docs/01 §一「库选型：p-queue 并发上限 = CPU-1」 vs docs/05「串行 + 并行开关占位」/docs/11 M3「串行」 | v1 **强制串行**；配置项与 UI 开关保留但置灰 | 冲突消解 | docs/05、docs/11 是后端到端验收项（串行、后续任务排队）；p-queue 作为并行放开的预留 |
| 7 | docs/06 §一「进 .trash 或系统回收站」 | 默认 `storage/trash/<batchId>/`（可配 `storage.trashDir`）；不接系统回收站 | 收敛 | 跨平台可控、可测（M5 要求"回收站里能找到原文件"）；系统回收站在 NAS/容器下行为不可测 |
| 8 | docs/01 §四.1「产物放同目录」 vs docs/06 §三「和源文件同目录或指定目录」 | 默认同目录；`options.outputDir` 可选指定；`storage/` 只放运行态数据 | 细化 | 二者兼容：默认取同目录，指定目录为可选能力；避免产物混进 `storage/` |
| 9 | docs/12 `shared/task-status.js` = `queued/running/done/failed/aborted`，docs/05/11 又要求「中断」 | 枚举扩为 7 值：`queued/running/cancelling/done/failed/aborted/interrupted` | 扩展 | 「中断」是 M3 硬性验收项，"取消"与"重启中断"是两种终态；`cancelling` 是取消过渡态（对齐参考实现 `cancelTask`） |
| 10 | docs/04「两种模式：单独压缩 / 打包为一个」 | `mode` 枚举值 `single` \| `bundle`（中文文案不变） | 命名落地 | docs/12 `shared/compress-modes.js` 已给出 `single/bundle` |
| 11 | docs/12 目录里没有 `trash/`、`task-history.jsonl` | 增补 `storage/trash/`、`storage/task-history.jsonl` | 新增 | M5（回收站可恢复、删除有日志）与 M3（任务历史可查最近 N 条）需要落点 |
| 12 | docs/09 §三 `compress/*` 含"查询任务" | 单任务查询**唯一实现**在 `/tasks/{id}`，`/compress/tasks/{id}` 为别名 | 去重 | 避免同一逻辑两处实现导致漂移；对外两条路径都可用，不破坏原文 |

无出入且严格遵循的关键结论：`/api/v1/` 前缀、UUID 任务 ID、`{ok,data,error}`、SSE 单向、Range、双认证、"交互归前端、业务归后端"（docs/09 §五）。
