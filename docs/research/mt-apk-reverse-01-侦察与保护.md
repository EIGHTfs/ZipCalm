# MT 管理器 APK 逆向分析（1/4）—— 侦察结果与保护情况

> 目标物：`参考项目/MT管理器_2.26.10.apk`（36 MB，versionName 2.26.10，compileSdk 36）
> 本文件只讲**结构 / 保护情况 / 能否静态分析**。
> 证据分级：`[代码]` = dex 里有该类名/方法名字符串 · `[字符串]` = dex/arsc 里有该文案 · `[推断]` = 无直接证据的推理
> 调研日期：2026-10-24 · 只读分析，未修改 APK 与他人工作区

## 结论先说

**APK 不是"dex 是壳、无法分析"那种保护，而是"重度类名混淆 + 字符串/资源未加密"。**
- ❌ 没有 dex 壳：`classes*.dex` 里字符串全明文可读，`apktool` 直接解码成功（rc=0）
- ❌ 没有资源加密：`resources.arsc` 字符串池 UTF-8 明文，中文 UI 文案全部可读
- ✅ 有重度混淆：**宿主自身类名全部混淆为 `l.XXXX`**（如 Application 类 `l.᩵۬ۚ`），`libmtprotect.so`（3.1 MB）负责运行时保护/自校验
- ✅ **结论：可以做有效静态分析**，但只能拿到「字符串证据」级别的逻辑，拿不到可读的宿主方法体（类名全混淆，靠字符串与 arsc 文案反推逻辑）

## 一、APK 结构（7z 实测）

| 项 | 实测值 |
|---|---|
| dex | `classes.dex` 9.16 MB / `classes2.dex` 8.76 MB / `classes3.dex` 8.17 MB / `classes4.dex` 8.98 MB / `classes5.dex` 3.76 MB，共 5 个、约 38.8 MB 未压缩 |
| `AndroidManifest.xml` | 41828 字节（二进制 AXML），**未混淆的入口名可读**（见下） |
| `lib/` | 3 个 ABI：arm64-v8a / armeabi-v7a / x86 |
| `resources.arsc` | 2872024 字节，**UTF-8 明文** |
| assets | `assets/0`~`assets/9`、`assets/android_dex`、`assets/compile_dex`、`assets/icons`、`assets/Log.smali`、`assets/Hex.class`、`assets/killer_*`、`assets/libwbsafeedit*`、`assets/markdown-preview/*`、`assets/filetransfer.apk`、`assets/eruda.js` 等 |

### 原生库（`lib/arm64-v8a/`，arm64 为主）

| 库 | 大小 | 用途（`[推断]`，依据命名与配套 dex 字符串） |
|---|---|---|
| `libmtprotect.so` | 3151200 | **加固/保护**（dex 类名混淆即其产物），非压缩相关 |
| `libzstd-jni-1.5.7-7.so` | 603960 | **zstd 原生实现（luben zstd-jni 1.5.7-7）** |
| `libffmpegJNI.so` | 1235192 | 媒体处理 |
| `libumeng-spy.so` | 239848 | 友盟统计 |
| `libhook.so` / `liblsplant.so` | 251656 / 111824 | ART hook 框架（Xposed/LSPosed 风格，供用户自行注入） |
| `libpl_droidsonroids_gif.so` | 42400 | GIF 解码 |
| `libterm.so` | 10848 | 终端（libterm，对应终端功能） |

> **重点结论（`[代码]`+`[字符串]`双证）**：MT **自带 `zstd-jni` 原生库**，与 dex 里的 `com.github.luben.zstd.*`（`Zstd`、`ZstdCompressCtx`、`ZstdDictCompress`、`ZstdInputStream`、`ZstdOutputStream`、`ZstdDirectBufferCompressingStream` 全套）**完全对应**。这意味着：ZipCalm 若做 MT 插件，**zstd 压缩在 MT 侧已有现成能力，甚至不必自带 so**（详见 3/4 文档的插件扩展点分析）。

### dex 混淆与保护实况

- `apktool_3.0.3.jar d -s` 解码成功，得到 5 个 dex + 明文 manifest（`-s` 跳过资源反编译，只取 manifest）
- 类名形态：宿主全部 `l.` + 2~4 个 Unicode 私用区字符（如 `l.۠ܰۚ`、`l.᩵۬ۚ`）——**R8/自定义混淆产物，无法从类名推断职责**
- **但第三方库类名保留原样**（未混淆），这是本次分析的主要抓手：
  - `com.github.luben.zstd.*`（zstd-jni）
  - `net.sf.sevenzipjbinding.*`（7-Zip 绑定，见 2/4 文档）
  - `jcifs`/`smbj` 系（SMB 协议栈，见 3/4 文档）
  - `org.bouncycastle.*`、`com.alipay.sdk.*`、`com.tencent.*`
  - **`bin.mt.plugin.api.*`（插件 API，原样保留）**

## 二、AndroidManifest：权限与对外入口

`bin.mt.plus`，`application` 类名已混淆（`l.᩵۬ۚ`），`appComponentFactory` 亦混淆。**未混淆的入口名**（MT 故意保留，供外部调用）：

### 关键权限（`[代码]`）

```
INTERNET / ACCESS_NETWORK_STATE / ACCESS_WIFI_STATE / CHANGE_WIFI_MULTICAST_STATE
READ_EXTERNAL_STORAGE / WRITE_EXTERNAL_STORAGE / MANAGE_EXTERNAL_STORAGE
ACCESS_SUPERUSER（root）
REQUEST_INSTALL_PACKAGES / REQUEST_DELETE_PACKAGES / QUERY_ALL_PACKAGES
SYSTEM_ALERT_WINDOW / FOREGROUND_SERVICE(+SPECIAL_USE / MEDIA_PROJECTION)
REQUEST_IGNORE_BATTERY_OPTIMIZATIONS / WAKE_LOCK / VIBRATE
moe.shizuku.manager.permission.API_V23 / com.rosan.dhizuku.permission.API
usesCleartextTraffic="true"
```

### 对外暴露的 Activity（intent-filter）

| 组件 | Action | 说明 |
|---|---|---|
| `bin.mt.plus.Main`（3 个 icon alias） | `MAIN`/`LAUNCHER` | 主入口 |
| **`bin.mt.plus.OpenFileActivity`** | `VIEW`/`EDIT` + scheme `file`/`content` + mime `text/* image/* audio/* video/* application/*`；**另有 `SEND`** | **被其他 App「用 MT 打开」** |
| `bin.mt.plus.OpenTextActivity` | `VIEW`/`EDIT` + `text/*` | 被「用 MT 编辑文本」 |
| `bin.mt.plus.ImageViewerActivity` / `MusicPlayerActivity` / `VideoPlayerActivity` | `VIEW`/`EDIT` + 对应 mime | 分类型打开 |
| `l.֡᩺ۚ` | `GET_CONTENT` + `*/*` + `OPENABLE` | 作为**文件选择器**被别的 App 调用 |
| `com.tencent.tauth.AuthActivity` | scheme `tencent101492915` | QQ 登录 |
| **`l.۠ܰۚ`** | `VIEW` + scheme **`mtplugin`** + `BROWSABLE` | **插件安装/推送入口**（对应 manifest 里的 `bin.mt.plugin.PusherReceiver` activity-alias） |
| `bin.mt.plus.WXPayEntryActivity` / `wxapi.WXEntryActivity` | 微信支付/分享 | |

### 组件与 provider

- `provider bin.mt.plus.fp`（`grantUriPermissions=true`，未导出）—— 文件分享 provider
- `provider bin.mt.plus.shizuku`（`exported=true`，`INTERACT_ACROSS_USERS_FULL`）—— Shizuku
- `provider bin.mt.plus.androidx-startup`
- `provider bin.mt.plus.html-preview`（未导出）
- **5 个 `foregroundServiceType=specialUse` 的 service**：`TaskManager` / `StreamingServer` / `WebManager` / `McpServer` / `FTPServer` + `Terminal` + 2 个 media 服务
- **activity-alias 揭示的工具入口**（未混淆名，`taskAffinity` 多为 `bin.mt.plus.Tool`）：`SmaliQueryActivity` / `RemoteManageActivity` / `ApkMcpActivity` / `ColorPickerActivity` / `SignatureKeyActivity` / `ActivityRecordActivity` / `StreamMediaActivity` / `CommonPasswordActivity` / `ScriptExecutor`
- `receiver` action `bin.mt.file.action.INSTALL_CALLBACK`
- **`assets/0`~`assets/9` 是加密/压缩资源**（`assets/0` 22792B→ 未压缩 22792B 即已压缩态；`assets/6`/`assets/7`/`assets/icons` 是已存储态），头部字节非标准格式 → `[推断]` MT 自定义资源包，与压缩功能无关（`[未验证]`：未解出内容）

## 三、能否反编译的结论

| 手段 | 结果 |
|---|---|
| `7z l` / `7z x` | ✅ 完整列出/提取，`classes*.dex` 可直接取出 |
| `apktool d -s`（只解 manifest+dex） | ✅ 成功，manifest 明文可读 |
| **dex 字符串扫描（本报告主要方法）** | ✅ **有效**，字符串全明文 |
| `resources.arsc` 字符串池 | ✅ 明文 UTF-8，中文文案全可读 |
| `jadx` 反编译 | ⚠️ **可跑但价值低**：宿主类名全混淆，方法体不可读；**第三方库类名保留**（可用于读库源码）。本次未跑全量 jadx（逻辑已由字符串+arsc 取得，见 2/3/4 文档） |
| 类名/方法名/调用链 | ❌ 不可用（`l.XXXX` 混淆） |
| `libmtprotect.so` | ❌ 未分析（3.1 MB，运行时保护；**与压缩功能无关，放弃深挖**） |

**方法说明（供复现）**：
1. `7z x <apk> -o<dir>` 取 dex + manifest + arsc
2. `java -jar apktool_3.0.3.jar d -f -s -o <dir> <apk>` 解 manifest
3. Python 正则扫 dex 可打印串：`re.findall(rb'[\x20-\x7e]{4,}', data)`
4. `resources.arsc` 用 `data.decode('utf-8','ignore')` 后按关键词取上下文片段（UTF-16LE 无效，实测为 UTF-8）

> ⚠️ **路径坑（本机实测）**：含中文的路径传给 `java -jar` 会失败（报 `?????` 路径错误）。**必须先把 jar/apk 复制到纯 ASCII 路径（如 `/tmp/mtdec/`）再执行**。这是本次唯一踩的坑。

## 四、未验证项

1. `assets/0`~`assets/9`、`assets/android_dex`、`assets/compile_dex` 的内容与格式 —— 未解出，`[未验证]`
2. `libmtprotect.so` 的保护机制与是否影响 dex 运行时解密 —— 未分析（与压缩无关）
3. `libmt1.so`/`libmt2.so`/`libmt3.so` 的导出符号中是否有压缩相关 native 实现 —— **未做符号扫描**（`nm`/`readelf` 不可用），`[未验证]`；但因 dex 已确认压缩走 Java 层（sevenzipjbinding + zstd-jni），`[推断]` 与这几个 so 无关
4. jadx 全量反编译未跑 —— 因宿主类名混淆，预期收益低；若需读 `net.sf.sevenzipjbinding` / `com.github.luben.zstd` 的**库源码**，可单独对这两个包跑 jadx（它们类名未混淆）
