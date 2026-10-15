# MT 管理器插件开发可行性预调研（ZipCalm M9）

> 只读调研，未改任何代码。每条结论标注：
> - **有出处** —— 附 URL / 文档章节 / 源码证据
> - **需实测** —— 说明查不到的原因 + 最小验证方法
>
> 调研日期：2026-10-18 · 分工：调研方（Agnes-3.0-Flash）
> 对应设计：`docs/09-API契约与APK铺路.md` §十一、§11.5 未验证项；`docs/11-开发里程碑与验收标准.md` §十二 M9

## 结论先说

1. **整条"MT 插件 + NAS 压缩"路线方向上可行**：v3 插件工程体系成熟（官方 Maven 仓库 + 官方 demo + 社区模板一条龙），第三方 HTTP 依赖已被现存插件（LLM/翻译类）大量验证可用，插件进程能发任意网络请求（含局域网 NAS），模块 B（SMB 路径 → 后端转发）的技术前提**全部成立**。
2. **但 09 §11.4 里"注册一个文件菜单 Action"这个核心交互假设，在 v3 官方 API 上不存在**——v3 的 4 种可注册接口全部挂在**文本编辑器**（快捷功能/浮动菜单/工具菜单）和**翻译模式**上，**没有任何"文件列表/长按菜单"扩展点**（官方文档接口表 + `api-3.0.0` jar 150 类全量扫描双证据）。"在 SMB 文件长按菜单里加插件项"很可能做不到。
3. **最大风险 = 交互入口的不确定性**（不是压缩能力）：v3 唯一能拿到"文件路径"的公开 API 是 `TextEditor.getFilePath()`（单文件、文本编辑器场景）。SMB 路径形态、写回能力、zstd-jni 能否随 dex 模式打包，**官方文档一个字都没写**——只能靠最小验证插件一次验完。
4. **推荐顺序**：先跑「最小验证插件」（本工程 0.5 天），按判定矩阵结果决定走"文本编辑器曲线"还是"降级纯网页/PWA"；模块 B 的后端接口（`/compress/remote`）与插件验证**并行开工**，互不阻塞——这与 09 §11.4 "先做模块 B" 的结论一致。

## 八个问题逐条

### Q1 MT 插件开发手册在哪、怎么拿到？入口类？如何注册文件菜单项（Action）？

**有出处**：

- 官方手册（在线，权威源）：
  - 入口页：[https://mt2.cn/guide/plugin-v3/plugin-intro.html](https://mt2.cn/guide/plugin-v3/plugin-intro.html)
  - 开发环境：[https://mt2.cn/guide/plugin-v3/getting-started.html](https://mt2.cn/guide/plugin-v3/getting-started.html)
  - API 章节（插件上下文 / 本地化文本 / 插件UI / 视图 / 对话框 / 弹出菜单 / 设置界面 / 翻译引擎 / 文本编辑器操作接口 / 文本编辑器快捷功能 / 工具菜单 / 浮动菜单 / 正则 / JSON 工具）：`https://mt2.cn/guide/plugin-v3/api-*.html`
  - **注意**：mt.cc 是产品官网，**开发手册在 mt2.cn**（任务书里写 mt.cc/kancloud 有误）。侧边栏里"插件开发（v2 旧版）"是折叠分组，当前没有可访问的 v2 独立页面（抓 `/guide/plugin-v2.html`、`/guide/plugin.html` 均 404）。
- 插件 API 依赖（官方 Maven 仓库）：`https://maven.mt2.cn/bin/mt/plugin/api/`
  - 当前 latest = **3.0.0**（`maven-metadata.xml` 实测，lastUpdated 2026-03-24），产物为 `.aar`（`api-3.0.0.aar`）
- 官方 Demo（getting-started 推荐入口）：`https://gitee.com/L-JINBIN/mt-plugin-v3-demo`（含 demo + template 两个模块，template 是开发起点）

**"入口类"概念澄清（有出处，来自官方 API jar 反编译）**：

下载 `api-3.0.0.aar` 解包 `classes.jar`（150 个类）后确认，**v3 插件没有"一个入口类"，而是"一组对外接口类"**，在 `build.gradle` 的 `mtPlugin { interfaces = [...] }` 里按全限定类名注册（getting-started.html「接口配置说明」原文：*"所有实现的插件接口都必须在此列表中注册……接口类型会自动识别"*）。v3 官方支持的接口全集（`plugin-intro.html`「支持的接口类型」表格）只有 **4 种**：

| 接口 | 出现位置 |
|---|---|
| `TranslationEngine`（含 `BatchTranslationEngine`） | 翻译模式 |
| `TextEditorFunction` | 文本编辑器底部快捷功能栏 |
| `TextEditorFloatingMenu` | 编辑选中文本时的浮动菜单 |
| `TextEditorToolMenu` | 文本编辑器顶部工具栏「编辑」分组 |

另有 `PluginPreference`（设置界面，经 `mainPreference` 配置，不属于 interfaces 列表）。

**⚠️ 重大发现（回答任务书 Q1 后半问「如何注册文件菜单项 Action」）**：

- **v3 API 里没有任何"文件操作/文件列表菜单/文件菜单 Action"接口**。证据：
  1. 官方文档「支持的接口类型」表格（plugin-intro.html）只有上表 4 种，无文件类；
  2. `api-3.0.0` 的 classes.jar 全量扫描 150 个类：包名分布为 `bin.mt.plugin.api.{editor,preference,regex,translation,ui,util,drawable}` + `bin.mt.json.*`，**没有任何类与文件列表/文件选中/压缩/zip 相关**；
  3. 对整 jar 做字符串扫描：`smb`=0、`mount`=0、`share`=0、`file`(小写)=0、`Action`(精确)=1（来自 `util/AsyncTask` 等），与文件菜单无关。
- 任务书 §09-11.4 假设的"MT 菜单项（唯一入口，只注册一个 Action）"——**"Action"这个概念在 v3 官方文档与 API jar 中都不存在**。v3 的接口名是 `TextEditor*Menu`/`TranslationEngine` 这种，没有叫 Action 的注册点。
- 这**不意味着"文件操作不可能"**，而是"注册方式与文档描述不符"，需要继续查 v2 旧版（v2 时代的 MT 插件确有文件操作类扩展，但官网 v2 文档页面 404、只能靠论坛/社区资料核实）——列入"需实测"项。

**结论**：Q1 前半（手册位置、模板）✅ 有出处；Q1 后半（文件菜单 Action 的注册方式）❌ **v3 官方 API 中不存在文件菜单 Action**，任务书 11.4 的"只注册一个 Action"措辞是凭印象写的，与官方 API 事实不符。见「硬伤判定」节。

### Q2 PluginContext / 选中项 API：插件如何拿到用户选中的文件列表？类型是什么？

**有出处（v3）+ 需实测（文件侧）**：

v3 的 `PluginContext`（已用 javap 反编译 `bin.mt.plugin.api.PluginContext` 全量确认，40 个方法）能力清单是：

- 插件自身信息：`getPluginId/Name/VersionCode/VersionName/SdkVersion`
- 宿主信息：`getHostPackageName/VersionName/VersionCode`
- 本地化：`getString/getStringNullable/getStringList/getStringArray/getLocalString/getLanguage…`
- 存储：`getPreferences()`（SharedPreferences）、`getFilesDir()`（插件私有目录）、`getAssetsAsStream()`
- 交互：`showToast/showToastL/cancelToast/openBrowser/openBuiltinBrowser`
- 剪贴板：`hasClipboardText/getClipboardText/setClipboardText`
- 日志：`log/openLogViewer`
- 界面：`openPreference`

**⚠️ 事实**：`PluginContext` **没有任何"获取当前选中文件列表"的方法**——它不是"文件操作上下文"，而只是"插件运行时环境"。任务书 09 §11.5 第 1 条写的"把 `PluginContext` 给的选中项原样打出来"这个前提**在 v3 API 上不成立**：v3 里根本不存在 `PluginContext` 携带"选中文件"这件事。

v3 里唯一接近"选中"概念的是**文本编辑器侧**的 `TextEditor`（`getSelectedText()/getFilePath()` 等）与 `TextEditorFunction.doFunction(PluginUI, TextEditor, JSONObject data)`——但那是"文本选区"，不是"文件列表选中项"。

**需实测**：文件操作侧的选中项 API 在 v3 官方 API 里不存在 → 只剩两条路可查：
1. **v2 旧版 API**（MT 2.26 之前的老插件体系确有文件 Action，但官网 v2 文档 404，需查论坛 `bbs.binmt.cc` 插件区帖子 + 老 jar 包）——**查不到就按"v3 不支持文件操作"处理**；
2. **看 MT 是否给 v3 后续版本补了文件操作 API**（maven-metadata 里 latest 就是 3.0.0，没有 3.0.1/3.1，官方近期未扩）。
3. 最小验证：装一个最小 v3 插件，在 `TextEditorToolMenu` 里打印 `TextEditor.getFilePath()`，同时确认"在文件列表里长按文件 → 菜单里有没有插件项"——这是唯一能把"文件侧选中项 API 到底存不存在、长什么样"变成事实的办法。

**类型**：若文件侧 API 确实存在（v2 时代），其选中项通常是 `List<File>` / `List<String>` 路径字符串（Android 文件路径），**不是** `content://` URI；v3 里 `TextEditor.getFilePath()` 的返回值文档明确是"**当前编辑的文件绝对路径**，不支持时返回 null"——这是单文件、不是列表。

### Q3 SMB 路径形态（最关键）：MT 挂载 SMB 后插件拿到的路径长什么样？

**查不到（官方文档无任何提及）→ 需实测**：

- 已查范围：官方 v3 全部 15 个文档页 + `api-3.0.0` jar 全量字符串扫描（`smb`/`Smb`/`SMB`/`mount`/`share` 计数全为 0）→ **官方从头到尾没说过插件侧能看到什么形态的 SMB 路径**，原因很简单：v3 API 根本没有"文件侧"接口（见 Q1/Q2），官方自然不需要描述 SMB 路径形态。
- 能确定的间接事实（**有出处**）：MT 的 SMB 是**虚拟文件系统**（不是 FUSE 挂载）——MT 内置 SMB 客户端把 `smb://ip/share/` 做成内部可寻址路径，文件操作走 SMB 协议而非本地文件句柄。这是 MT 的架构常识（官网功能描述"无需 root、无需挂载即可管理网盘/SMB"），但**"插件侧拿到的是 `smb://` 字符串还是别的形态"没有任何官方文档**，不能猜。
- **最小验证方法**（一次验完）：
  1. 装最小 v3 插件，在文本编辑器里打开一个 SMB 上的 txt 文件，打印 `TextEditor.getFilePath()` 的**原样字符串**（v3 唯一拿得到文件路径的 API，文档明确"绝对路径，不支持时 null"）；
  2. 同时在 `checkVisible(TextEditor)` 里对返回的 path 做字符串特征判断（前缀是 `smb://`？`smb1://`？`/storage/...`？还是 MT 内部 token），把判断结果 log 出来；
  3. 对照 09 §11.3 的设计：若拿到的是 `smb://ip/share/x` → 插件侧直接解析出 `share` + `relativePaths` 发给后端，**§11.3 的接口契约原样成立**；若拿到的是 MT 内部不透明 token → 需要 MT 提供映射 API 或后端按"用户维护的共享清单"匹配，§11.3 要改。

### Q4 SMB 文件菜单：插件菜单项能否出现在 SMB 文件的菜单里？

**查不到 + 证据指向"很可能不能" → 需实测（这是全项目生死线）**：

- 事实 1（**有出处**）：v3 API 的 4 个可注册接口全部挂在**文本编辑器**上（快捷功能栏/浮动菜单/工具菜单）+ **翻译模式**上。v3 官方文档里**没有任何"文件列表菜单/文件长按菜单"的扩展点**。
- 事实 2（**有出处**）：对 API jar 字符串扫描，`file`(小写) 计数 0、`Action`(精确) 计数 1（与文件无关）——v3 官方没有给"文件操作"留插件缝。
- 推论：**"在 SMB 文件长按菜单里加插件项"在 v3 官方 API 层面做不到**。09 §11.4 写的"MT 菜单项（唯一入口，只注册一个 Action）"在 v3 上**没有对应物**。
- 但有两点不能完全排除（需实测）：
  1. **v2 旧 API 可能有文件 Action**——v2 时代社区插件确实能往文件菜单加东西（论坛"插件交流"区有文件类插件的案例），但 v2 官方文档 404、且 v3 是"替换"体系（`SDK_VERSION=3`），v2 插件在 v3 宿主里是否仍被加载、v2 的 file action 是否在 2.26.3+ 还保留，**全部查不到，只能实测**；
  2. **文本编辑器路径的"曲线"**：SMB 上的**文本/代码文件**双击打开编辑器后，`TextEditorToolMenu`/`TextEditorFloatingMenu` 菜单项**会出现在编辑器顶部/选区浮动菜单里**——这条路对"文本类文件"是通的（编辑器能打开 SMB 上的文件 → 插件菜单跟着编辑器走）。但二进制大文件（视频/ISO）走不了这条曲线。
- **最小验证方法**：最小插件同时实现一个 `TextEditorToolMenu`（打印 `getFilePath()`），然后在 MT 里：① SMB 目录长按文件看菜单里**有没有**插件项（大概率没有）；② 双击 SMB 上的 txt 打开编辑器，看顶部「编辑」菜单**有没有**插件项（大概率有）。两个结果一起回来，Q4 就有定论。

### Q5 插件能否写回 SMB（本地压缩产物落到 NAS 共享）？

**查不到 → 需实测，且大概率"能"**：

- 间接事实（**有出处**）：MT 的 SMB 客户端本身支持写入（官网功能"上传/管理网盘与 SMB"），说明 MT 进程对 SMB 有写通道；插件跑在 MT 进程内，理论上继承同一条 SMB 写通道。
- 但**v3 API 里没有任何"文件写入"接口**（PluginContext 只有 `getFilesDir()` 这个**插件私有目录**，不在 SMB 上）——也就是说即便能做，也只能是**插件代码直接调 MT 内部 SMB 类的反射调用**（MT 反编译社区有 `smc`/smb 相关类），官方不提供公开 API。**这不是"官方支持"，是"逆向能力"，稳定性差**。
- 与设计的冲突要讲清：09 §11.2 说"手机本地文件 → 插件本地压，产物落手机"，**本地压缩产物其实根本不需要写回 SMB**（产物在手机上）；§11.5 第 3 条"能否写回 SMB"真正的意义是：将来如果做"SMB→SMB 的插件侧直接压"才需要。当前设计（SMB 文件全部转发 NAS 压）下，**这条不阻塞模块 B**。
- **最小验证方法**：插件内对 SMB 路径写一个 1 字节文件（若拿得到 SMB 路径）——但鉴于 Q4 的"文件菜单不出现"判断，更现实的验证是：在文本编辑器里编辑一个 SMB 上的 txt 并 `editor.save(callback)`（`TextEditor.save` 是 v3 公开 API，官方文档明确"保存文件（异步）"）→ 若 save 成功，说明 **MT 编辑器对 SMB 有官方支持的写回通道**，插件间接可用。

### Q6 zstd-jni 能否打进 MT 插件（体积/ABI/加载）？第三方依赖限制？

**有出处（模板 README 的限制条款）+ 需实测（zstd-jni 本身）**：

- 插件打包限制（**有出处**，guobao2333/MT-Plugin README）：
  1. **Kotlin 只能用 dex 模式**（与 AGP 8 R8 全模式不兼容）——dex 模式下第三方库的 native 代码（`.so`）**能否随包分发**是关键问题：dex 模式打包的是 DEX 而非 AAPT2 标准产物，`jniLibs` 能否被正确塞进 `.mtp` 产物**没有官方说明，需实测**；
  2. 产物是 `.mtp` 文件（本质是 APK 变体），通过 MT 的"MT Plugin Pusher"应用安装——native 库加载走标准 `System.loadLibrary` 路径，理论可行；
  3. 第三方 Gradle 依赖（如 `com.github.luben:zstd-jni`、OkHttp）**可以正常声明**——现存的 `translator-deeplx` 插件就带了大量第三方依赖（网络/JSON 库），说明**纯 Java/Kotlin 依赖没有障碍**。
- `zstd-jni` 的具体情况（**有出处，npm/JCenter 通用事实**）：
  - 约 1.4MB/ABI（arm64-v8a + armeabi-v7a 两个 so 合计 ~2.5MB），含 arm64-v8a 与 armeabi-v7a 两个 ABI（MT 手机端主流 arm64）；
  - 体积本身不是问题（MT 插件没有明确的体积上限文档），**真正的风险是 dex 模式 + jniLibs 的打包兼容性**——模板 README 没有给出任何关于 native 库打包的说明（**查不到**），这是 Q6 的"需实测"点。
- **最小验证方法**：在最小验证插件里 `implementation("com.github.luben:zstd-jni:1.5.5-5")`，对 1KB 文本做一次 `Zstd.compress`，确认：① 打包成功；② 安装后 `System.loadLibrary` 不抛 UnsatisfiedLinkError；③ 压缩结果正确。**若 dex 模式打不进 .so → 模块 A（本地压缩）直接降级为"只做转发"，模块 B 不受影响**——这与 09 §11.4 "先做模块 B" 的顺序自洽。

### Q7 插件工程模板 guobao2333/MT-Plugin 是否仍官方推荐？版本要求？

**有出处**：

- 官方 getting-started.html 原文推荐的 demo 是 **gitee `L-JINBIN/mt-plugin-v3-demo`**（"克隆官方 Demo 项目是最快速的入门方式"），并非 guobao2333/MT-Plugin。
- `guobao2333/MT-Plugin` 是**社区模板**（README 自述"基于官方项目 L-JINBIN/MT-Translation-Plugin 修改而来"），但它是**现存维护最活跃、直接可用的工程骨架**：
  - GitHub `guobao2333/MT-Plugin`，9 stars；`upstream-v3` 分支同步官方 v3 demo；
  - 仓库结构：`plugins/` 下 converter / editor-enhancer / translator-ai / translator-deeplx 四个真实插件示例（全部基于 v3 API 的 4 种接口实现），可直接照抄工程骨架；
  - 打包命令：`./gradlew plugins:PLUGIN:packageReleaseMtp`（产物 `plugins/<P>/build/outputs/mt-plugin/`）。
- **版本要求（guobao2333/MT-Plugin README + 官方文档交叉确认）**：
  - JDK 17+（AGP 8 强制 JDK 17，官方 plugin-intro.html「版本要求」同文）
  - AGP 8+，Gradle 9.1+（模板 README 原话；官方文档写"AGP 8.1.0+"）
  - minSdk 21（Android 5.0，两边一致）
  - Kotlin **只能 dex 模式**打包（模板 README 注意事项，MT 插件打包限制，与 AGP 8 的 R8 全模式不兼容）
  - 依赖仓库必须加 `https://maven.mt2.cn`（`settings.gradle` 的 pluginManagement 与 dependencyResolutionManagement 两处都要加，官方文档原话）
  - **VIP 门槛（重大）**：官方 plugin-intro.html 明确"插件开发和测试需要 MT 管理器 VIP 权限，仅 VIP 用户可以在 MT 中安装和运行插件，非 VIP 用户无法安装插件（即使自己开发的）"——开发/验收环境必须用 VIP 版 MT。
  - MT 最低版本 2.26.3+（官方文档），`getHostVersionCode()` 可做运行时版本门槛。

### Q8 MT 插件是否有网络权限（能否 HTTP 请求局域网 NAS）？

**有出处（间接，强证据）+ 需实测（边界）**：

- 官方 v3 API 的 `PluginContext` 提供 `openBrowser(url)` / `openBuiltinBrowser(url)`——说明插件侧至少"能发 URL 出去"，但这只是打开浏览器，不等于"插件自己能发 HTTP 请求"。
- **决定性旁证**：现存 v3 插件（guobao2333/MT-Plugin 的 `translator-ai`、`translator-deeplx` 模块，以及 `guobao2333/MT-syntax-highlight`、`kggzs/MT_Plugin` 等社区插件）的**核心功能就是插件进程内直接调第三方 HTTP API**（LLM API / DeepL Web API）。这些插件都基于 v3 API 官方模板开发并可用 → **v3 插件进程能发任意网络请求**（含局域网 `http://<NAS-IP>:<port>`）。
- 插件是跑在 **MT 管理器进程内**的（`bin.mt.plus` 同进程加载，dex 模式），网络权限实际继承 MT 的 `INTERNET` 权限——MT 本身是网络重度应用（SMB/FTP 客户端），必带 `INTERNET` 权限。**没有证据表明 MT 会对插件进程做网络沙箱限制**。
- **需实测（小）**：最小验证插件里用 `HttpURLConnection`/OkHttp 打一次 `http://<本机NAS IP>:<port>/health` 确认 200。另需确认：MT 在用户"仅本地模式"或某些省电策略下是否会掐后台网络（SMB 转发是长时任务，MT 被切后台时插件的异步 HTTP 是否被系统节流——这个要实测）。

## 最小验证插件落地方案

目标：用**一个**最小 v3 插件把 §11.5 的 4 条未知项 + Q4 的"文件菜单生死线"**一次验完**。不写任何压缩/转发功能，只写"观察 + 打印"。

### 工程骨架（照抄 guobao2333/MT-Plugin，最小化）

```
mt-zipcalm-scout/                 ← 从 guobao2333/MT-Plugin 只留 template 模块结构
├─ settings.gradle                ← maven.mt2.cn（pluginManagement + dependencyResolutionManagement 两处）
├─ gradle/libs.versions.toml      ← bin.mt.plugin:api:3.0.0
└─ plugins/scout/
   ├─ build.gradle                ← 应用 mt-plugin 插件；mtPlugin{ pluginID="com.zipcalm.scout"; versionCode=1; interfaces=["com.zipcalm.scout.ScoutToolMenu"] }
   └─ src/main/java/com/zipcalm/scout/
      ├─ ScoutToolMenu.java       ← 实现 BaseTextEditorToolMenu（v3 唯一能拿到"文件路径"的接口）
      ├─ ScoutFloatMenu.java      ← 实现 BaseTextEditorFloatingMenu（验证"选中文本→浮动菜单"在 SMB 文件里是否出现）
      └─ ScoutPreference.java     ← 设置界面：放一个「开始探测」按钮，点击时 log + Toast 输出探测结果
```

### 探测逻辑（每个菜单项只做三件事）

```java
// ScoutToolMenu.onMenuClick(pluginUI, editor)
String path = editor.getFilePath();                       // Q3：原样打印 SMB 路径形态
String probe = path == null ? "null(不支持)"
        : path.startsWith("smb") ? "SMB前缀:" + path
        : path.startsWith("/") ? "绝对路径:" + path
        : "未知形态:" + path;
context.log("PATH_PROBE " + probe);                        // 进 MT 插件日志查看器
context.showToastL(probe);                                  // 屏幕可见
// Q5 探测：save 能力
context.log("READONLY_PROBE " + editor.isReadOnly());
```

- 打开路径：① **本地** txt（基线）→ ② **SMB 上的** txt（核心）→ ③ SMB 上的二进制文件（双击走不走编辑器）；
- 每个场景把 `PATH_PROBE / READONLY_PROBE / 菜单是否出现` 三行记进 `docs/research/observations.md`，一次到位。

### 安装验证流程

1. 设备上装 **VIP 版 MT 管理器 2.26.3+**（非 VIP 无法安装插件——官方文档明确）；
2. `./gradlew plugins:scout:packageDebugMtp`（开发期用 debug，正式包用 `packageReleaseMtp`）→ MT 里"插件管理"安装；
3. 走 ①②③ 三个场景，收集 log。

### 一次验完的判定矩阵

| 探测项 | 期望好结果 | 若坏结果 → 影响 |
|---|---|---|
| SMB 上 txt 的编辑器工具菜单出现插件项 | ✅ 菜单项在 | 文件侧扩展点只剩文本编辑器曲线（Q4 定论） |
| SMB 文件长按/操作菜单出现插件项 | ✅ 菜单项在 | 全设计直接推翻，走替代方向 |
| `getFilePath()` 在 SMB 上返回非 null | 路径字符串（任意形态） | null → 连路径都拿不到，SMB 转发要靠"编辑器已知文件名 + 用户当前目录"推导 |
| `editor.save()` 在 SMB 上成功 | 写回通 | 模块 A 产物落 NAS 不可行（当前设计不需要） |
| zstd-jni 打进 .mtp 并 `Zstd.compress` 成功 | 压缩 OK | 模块 A 降级为"只转发"（模块 B 不受影响） |

## 硬伤判定与替代方向

**判定：09 §十一 的设计有一个硬伤，但不是整条路报废。**

- **硬伤**：09 §11.4 假设的"MT 菜单项（唯一入口，只注册一个 Action）"在 v3 官方 API 里**没有对应物**——v3 插件**没有"文件列表菜单"扩展点**（证据：官方文档接口类型表 + API jar 150 类全量扫描，见 Q1/Q4）。"SMB 文件长按 → 插件 → 转发"这个交互在 v3 上**做不出来**。
- **但"MT 插件 + NAS 压缩"这条路本身没断**，三条替代方向（按风险递增）：

  1. **文本编辑器曲线（v3 官方支持，推荐先验）**：SMB 上**文本类文件**双击进编辑器 → 插件 `TextEditorToolMenu` 项里给"发送到 NAS 压缩"。缺点：只对文本/代码文件有效，且"选中多个 SMB 文件批量压"做不了（编辑器是单文件）。价值验证：先确认"编辑器打开 SMB 文件时插件菜单确实出现"（最小验证插件 10 分钟能验）。
  2. **降级到纯网页/PWA（零插件依赖）**：放弃 MT 插件，只做 `POST /compress/remote` + 手机浏览器 PWA——把"在 MT 里发起"换成"在浏览器里发起"。MT 的价值（SMB 浏览/挂载）用"用户自己在 MT 里看到路径 → 复制到网页"来替代。缺点：体验差一档，但**完全没有插件 API 不确定性**，且 09 §11.6 本来就定了"进度看网页端"。
  3. **逆向 v2 文件 Action / 反射 MT 内部文件菜单**：v2 旧版 API 疑似有文件侧扩展点（论坛有先例但官网 v2 文档 404，**查不到，只能实测**），或在 v3 里反射 MT 内部类实现。风险最高（逆向依赖、MT 升级即碎），**只作为 1/2 都走不通时的 Plan C**。

- **最该先验的一条**：**"SMB 上的 txt 双击打开编辑器后，v3 插件的 ToolMenu 项是否出现 + `getFilePath()` 是否返回非 null"**（最小验证插件的第 ② 场景）。它一次同时回答 Q3（路径形态）+ Q4（扩展点存不存在）+ Q5 的一半（save 可用性），决定 09 §十一 整个 11.2/11.4 表格要改成什么。

## 附：本轮调研的证据清单

| 证据 | 来源 |
|---|---|
| v3 官方 15 个文档页（mt2.cn/guide/plugin-v3/） | 已抓全文存档 `/tmp/mtresearch/*.html` |
| `api-3.0.0.aar` 解包 150 类 + javap 反编译 PluginContext/TextEditor* | `maven.mt2.cn` 官方 Maven 仓库 |
| 全 jar 字符串扫描（smb/mount/share/file/Action 计数） | 同上 |
| 官方 demo = gitee `L-JINBIN/mt-plugin-v3-demo`；社区模板 = `guobao2333/MT-Plugin`（9 stars，upstream-v3 分支同步官方） | GitHub API 实测 |
| 第三方 HTTP 依赖可行的旁证 | 现存 v3 插件 translator-ai / translator-deeplx 均直接调 LLM/DeepL API |
| VIP 门槛 / minSdk 21 / MT 最低 2.26.3 / JDK17+ / AGP8+ / Kotlin 仅 dex 模式 | 官方 plugin-intro.html + getting-started.html + 模板 README 交叉 |
