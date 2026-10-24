# MT 管理器 APK 逆向分析（2/4）—— 压缩相关实现

> 证据分级：`[代码]` = dex 里有该类名/方法名字符串 · `[字符串]` = dex 或 arsc 里有该文案 · `[推断]` = 无直接证据的推理
> 方法：dex 可打印串扫描 + `resources.arsc` 中文文案提取。宿主类名全混淆，故**拿不到方法体**，本文件是"字符串 + 文案"级别的逻辑还原，凡无证据处一律标 `[未找到]`，不推测。

## 结论先说

**MT 的压缩栈是「多库组合」而非自研**，按格式分层：

| 格式 | 实现 | 证据 |
|---|---|---|
| zip / 7z / tar / gz / bz2 / xz / lzma / lz4 | **`net.sf.sevenzipjbinding`**（7-Zip 的 Java 绑定，走 native） | `[代码]` `IOutCreateArchiveZip` / `IOutCreateArchiveTar` / `IOutCreateArchiveBZip2` / `IOutCreateArchiveGZip` / `IOutCreateArchive7z` / `IInArchive` / `IOutFeatureSetSolid` / `IOutFeatureSetEncryptHeader` / `IOutFeatureSetMultithreading` / `IOutFeatureSetLevel` |
| **zstd** | **`com.github.luben.zstd`（zstd-jni 1.5.7-7，自带 so）** | `[代码]` `com.github.luben.zstd`、`Zstd`、`ZstdCompressCtx`、`ZstdInputStream`、`ZstdOutputStream`、`ZstdDirectBufferCompressingStream`；`[字符串]` `libzstd-jni-1.5.7-7` |
| tar 系列（`.tar.gz/.tar.bz2/.tar.xz/.tar.zst/.tar.lz4/.tar.zstd`） | tar 容器 + 各压缩器组合 | `[代码]` `IOutCreateArchiveTar` + 各格式枚举 |
| zip（部分路径） | **Java 标准库** `java.util.zip.ZipOutputStream` / `Deflater` / `GZIPOutputStream` | `[代码]` 全部出现在 4 个 dex 里 |
| rar | 只读（无 `IOutCreateArchiveRar`） | `[代码]` 有 `rar`/`.rar` 字符串但无 rar 输出接口 → `[推断]` 仅解压 |

## 一、支持的格式与能力边界

### 1.1 格式枚举（`[代码]`，来自 sevenzipjbinding `ArchiveFormat` 与 dex 扩展名字符串）

压缩（写）：`zip`、`7z`、`tar`、`gz`(gzip)、`bz2`(bzip2)、`xz`、`lzma`、`zstd`、`lz4`
解压（读）：上述 + `rar`（`[推断]`，见上）+ 分卷 rar（`[代码]` 有 `.*\.part[0-9]+\.rar`、`.part1.rar` 正则）

MIME 识别：`[代码]` `application/zstd`、`application/lzma`

tar 组合扩展名（`[代码]`，出现在 classes2 与 classes4）：`.tar.gz` / `.tar.bz2` / `.tar.xz` / `.tar.zst` / `.tar.zstd` / `.tar.lz4`

### 1.2 压缩级别（6 档，`[字符串]` arsc 中文文案原文）

```
仅存储   极速压缩   快速压缩   标准压缩   最大压缩   极限压缩   APK模式
```

- 「极限压缩」有专门开关与说明（`[字符串]` 原文）：**"极限压缩：使用极限压缩算法对必要的数据重新压缩，以获得更小的体积，该处理步骤需要等待较长的时间"**，设置项名为「启用极限压缩」
- 「APK 模式」（`[字符串]`）：**"对安装包内不规范的文件以 APK 模式进行重新打包并执行 Zipalign 对齐优化，优化后安装包可能会增大"**——即 APK 专用模式（zip + zipalign）
- 压缩级别 UI 有说明文案 `[字符串]`：`压缩级别 Q%s`

### 1.3 压缩策略模式（3 种，`[字符串]`）

```
大小优先   Q大小优先：尽可能对所有文件以压缩方式进行打包以减小体积
速度:（对应"速度优先"，[字符串] 存在 "速度:" 作为过滤标签，压缩侧策略命名 [未找到] 明确对应）
任意大小
```

> ⚠️ 「速度优先」在 arsc 里**只作为搜索过滤标签**出现（`速度: 任意时间 上月 上周…`），**不是压缩策略名**。压缩策略三选一的另外两个名字 `[未找到]` 明确证据，只确认了「大小优先」及其说明。此处不猜。

### 1.4 高级特性

| 特性 | 有或无 | 证据 |
|---|---|---|
| **固实压缩（solid）** | ✅ **有** | `[代码]` `IOutFeatureSetSolid`；但 arsc 中文搜「固实」= 0 处 → 界面可能不叫"固实"（`[推断]` 叫别的名字或未汉化） |
| **分卷** | ✅ **有** | `[字符串]`「分卷大小 / 自定义 / 分卷大小至少 64 KB / 无 / 请输入分卷大小」；`[代码]` `.part1.rar`、`.*\.part[0-9]+\.rar` |
| **文件名加密** | ✅ **有** | `[字符串]`「同时加密文件名」+ `[代码]` `IOutFeatureSetEncryptHeader`（7z 头加密） |
| **多线程压缩** | ✅ **有** | `[代码]` `IOutFeatureSetMultithreading` |
| **单独压缩每个文件/文件夹** | ✅ **有** | `[字符串]`「单独压缩每个文件/文件夹」 |
| **压缩包测试（test）** | ✅ **有** | `[字符串]`「正在测试压缩文件 / 测试完成，未发现错误 / 不支持测试此压缩文件 / 该压缩文件正在测试 / 测试发现压缩文件错误」 |
| **压缩包内更新** | ⚠️ 有限制 | `[字符串]`「不支持修改分卷压缩包」+「该类型存档文件不支持更新操作，您的修改已被忽略」 |
| 加密算法 | AES（ZipCrypto / AES-256 两种路径） | `[代码]` `ICryptoGetTextPassword`（sevenzipjbinding 密码回调）+ arsc 大量 `AES` 相关串；**具体 zip 用 ZipCrypto 还是 AES-256 `[未找到]` 明确分流证据** |

## 二、压缩实现路径（库与调用方式）

`[代码]` + `[推断]`：

```
用户选文件 → MT 压缩对话框（格式/级别/密码/分卷/加密文件名/单独压缩）
  → sevenzipjbinding（多数格式，含 7z/zip/tar/gz/bz2/xz/lzma/lz4）
       IInArchive（读） / IOutArchive + IOutCreateArchive*（写）
       IOutFeatureSetLevel（级别）/ SetSolid（固实）/ SetMultithreading / SetEncryptHeader
       ICryptoGetTextPassword（密码回调）
  → 或 java.util.zip.ZipOutputStream/Deflater/GZIPOutputStream（zip/gz 的轻量路径）
  → 或 com.github.luben.zstd（zstd，含 ZstdCompressCtx 高级 API + ZstdInputStream/OutputStream 流式）
  → XZ 另有一条 native 路径：[代码] NativeXZInputStream / NativeXZOutputStream
     （注意：类名在 net.sf.sevenzipjbinding 包下，是 sevenzipjbinding 自带的 native XZ 加速，非 MT 自研）
```

- **不是调用外部二进制**：全在进程内（JNI + Java），无 `Runtime.exec` 调 7za 的证据 → `[推断]`（未找到 exec 相关串）
- **XZ 有 native 与纯 Java 双路径**：`[字符串]` `Failed to create native XZ encoder`、`Native XZ encoder is unavailable`、`nativeCreateUltraDeflateCompressor` 等 → 说明**带 native 加速 + 纯 Java 兜底**
- **多格式统一抽象**：`[代码]` `compressStream` / `decompressStream` / `decompressStreamNative` 三个方法名（在宿主混淆类里，但方法名被 R8 保留——`[推断]` 这是 MT 的统一压缩入口抽象）

## 三、进度与取消

### 3.1 进度模型

- **`[字符串]`「总进度」**（与「正在传输」并列）→ 有**总进度**概念
- **`[代码]` `net.sf.sevenzipjbinding.IProgress`**（sevenzipjbinding 标准进度回调，提供 `setTotal/setCompleted`，即**字节级**进度）
- **`[代码]` `ProgressDialog` / `DualProgressDialog` / `LoadingDialog`**（`bin.mt.plugin.api.ui.dialog` 下的插件对话框；宿主侧进度 UI `[未找到]` 具体类名，因混淆）
- `[字符串]`「正在压缩」「正在写出文件 %d个文件」「剩余项:」→ **同时展示"文件级进度"（第几个/共几个）与"当前文件内进度"**
- `[字符串]`「已存在项 / 待写入项」→ 冲突处理阶段也有进度计数

**结论**：进度是**双层的**——总进度（整体字节/文件数）+ 当前项进度。`[推断]` 基于 IProgress 是字节级。

### 3.2 取消

- `[字符串]`「再按一次取消操作」「正在取消操作」→ **可中途取消，且是"双击返回/再按一次确认"防误触**
- **取消后临时文件处理：`[未找到]` 明确证据**。arsc 无"已删除临时文件/残留"类文案 → `[推断]` 取消即中止并清理未完成的输出文件（无 UI 提示），但**这是推断，无证据**
- **回收站机制（重要，与 ZipCalm 相关）**：`[字符串]`「启用回收站功能 / 自动清理回收站文件 / 请将文件移出回收站后再打开 / 显示删除警告」+「删除文件时如果未选择移动到回收站，将显示红色警告」→ **MT 有全局回收站，删除类操作走回收站**（ZipCalm 的 `deleteOriginal` 设计可对照）

## 四、密码 / 加密

### 4.1 密码输入与传递

- `[代码]` `ICryptoGetTextPassword` —— sevenzipjbinding 的标准密码回调接口（MT 实现它以回传用户输入的密码）
- `[字符串]`「密码（不加密请留空）」「请输入密码」「正在加密文件」「同时加密文件名」
- `[字符串]`「您输入的密码不会被记录，请务必牢记」→ **单次压缩密码不持久化**

### 4.2 密码错误区分

- `[字符串]`「密码错误或文件已损坏」→ **密码错误与文件损坏共用同一错误提示，不区分**（这点对 ZipCalm 是直接可借鉴的简化：不必做精细区分）
- `[代码]` `ICryptoGetTextPassword` 的调用时机是 sevenzipjbinding 需要密码时回调 → `[推断]` 密码错误后 sevenzipjbinding 会再次回调（重试），MT 侧表现为再次弹密码框

### 4.3 常用密码本（亮点设计，`[字符串]` 原文）

```
"将常用密码添加到此处，解压加密的压缩文件时将自动按顺序尝试这些密码，
 若全部失败再手动输入；压缩文件时也可快速选择这些密码进行输入。
 当前暂无记录，最近一次压缩文件密码成功匹配记录将会显示在此处。"
配套：常用密码管理 / 该密码已存在 / 最近匹配记录 / 发现重复密码 / 密码不能为空
     已自动输入压缩包密码（解压时自动填入成功的那个）
```

**这是一条明确的"学习点"**：常用密码本 = 解压时按序自动尝试 + 成功即记住 + 下次自动填入。工程上零成本，体验收益大。

### 4.4 加密范围

- `[代码]` `IOutFeatureSetEncryptHeader` → **7z 支持"加密文件名/目录结构"**（不只是内容）
- `[字符串]`「同时加密文件名」→ 用户可选项

## 五、路径处理（详见 3/4 文档的 SMB 专篇）

压缩相关的路径要点（`[字符串]`，arsc 原文，极关键）：

```
"压缩级别 Q%s 当前目录权限不足，请将压缩文件复制到内部存储后再操作"
"%s 当前目录权限不足，无法直接解压，可先解压到其它文件夹再复制过来"
"已保存到\"内部存储/MT2/MTkeytool.zip\""
"外置存储" / "您选择的目标存储设备有误" / "您打开的不是该储存设备的根目录"
"由于系统限制，您需要通过授权来让 MT 管理器获得该目录的完整访问权限"
```

→ **MT 对"当前目录没有写权限"的处理是：提示用户先复制到内部存储，再操作**。这与 ZipCalm 设想的"SMB 上直接压"是**相反的策略**（MT 选择绕开，而不是在远程侧压）。

## 六、对 ZipCalm 的直接借鉴（详表见 4/4 文档）

1. 压缩级别 6 档命名（仅存储/极速/快速/标准/最大/极限）+ APK 专用模式
2. 策略三选（大小优先 等）+ 单独压缩每个文件
3. 常用密码本（自动按序尝试 + 成功记忆 + 自动填入）
4. 密码错误与文件损坏**不区分**，统一文案
5. 双层进度（总进度 + 当前项）+ 冲突计数（已存在项/待写入项）
6. 压缩包测试（test）作为独立功能
7. 分卷下限 64 KB 的硬约束
8. 取消需"再按一次"确认，防误触
9. 删除走回收站（可对照 `deleteOriginal`）

## 七、未验证项

1. **宿主方法体全部不可读**（类名混淆）→ 所有"逻辑"均为字符串/文案/库 API 反推，**没有一处是读了 MT 自己的实现代码得出的**
2. 压缩策略除「大小优先」外的另外两个选项名 `[未找到]`
3. zip 加密是 ZipCrypto 还是 AES-256 的**分流条件** `[未找到]`
4. 取消压缩后临时文件是否清理 `[未找到]`
5. 「极限压缩」具体算法（`[推断]` 可能是 7z 的更大字典/更高 effort，或对已压缩数据重压）`[未找到]` 明确证据
6. 多线程压缩的线程数是否可配 `[未找到]`
7. 进度是字节级还是文件级的**确证**（IProgress 存在 → `[推断]` 字节级，但 MT 实际用哪套 `[未找到]`）
