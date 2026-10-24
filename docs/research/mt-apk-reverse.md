# MT 管理器 APK 逆向分析（v2.26.10）

> 目标：逆向压缩相关实现作学习参考；并再次核实「MT 插件」路线的可行性。
> 方法：`7z` 解包 → `apktool` 解资源 → `jadx 1.5.6` 反编译 dex → 字符串与类结构分析。
> 结论分级：**【代码】** 有类/方法级证据 · **【资源】** 有字符串证据 · **【推断】** 基于前述证据的推理

---

## 一、侦察结果

| 项 | 结果 |
|---|---|
| 包名 | `bin.mt.plus` |
| 体积 | 36 MB |
| dex | 5 个（`classes` ~ `classes5`），未压缩共约 38 MB |
| **反编译是否成功** | ✅ **成功**，jadx 产出 **25,820 个 java 文件**（205 MB）。`libmtprotect.so` 存在但**未阻止静态反编译** |
| 混淆程度 | 业务类名被混淆为 `l/C14732.java` 形式（无类名语义），**需靠字符串常量反查** |
| 中文文案位置 | 不在 dex，在 `res/values-zh-rCN/strings.xml`（3,000+ 条） |

**原生库**：

| 库 | 推测用途 |
|---|---|
| `libmt1/2/3.so` | 自有 native 实现（文件操作/压缩加速） |
| `libmtprotect.so` | 代码保护（未阻断反编译） |
| `libhook.so` + `liblsplant.so` | **hook 框架**（lsplant 是 ART hook 库）→ MT 的「注入」功能 |
| `libffmpegJNI.so` | 媒体处理 |

**权限（节选）**：`MANAGE_EXTERNAL_STORAGE`、`ACCESS_SUPERUSER`（root）、`INTERNET`、`REQUEST_INSTALL_PACKAGES`。

**对外 action**：`VIEW` / `SEND` / `EDIT` / `GET_CONTENT`（文件关联）、`bin.mt.file.action.INSTALL_CALLBACK`。

---

## 二、压缩实现（学习重点）

### 2.1 用的库【代码】

| 库 | 用途 |
|---|---|
| **`net.sf.sevenzipjbinding`** | 7-Zip 的 Java 绑定 —— 支持 7z / zip / rar / tar / gz / xz / bz2 / iso 等**几乎所有格式**，且支持加密与分卷 |
| **`com.github.luben.zstd`**（zstd-jni） | zstd 压缩/解压 |

**这意味着 MT 的压缩能力本质是「7-Zip 引擎 + zstd」，不是自研格式实现。**

> **对 ZipCalm 的启示**：我们的 `docs/18` 功能①（7z/rar）如果走「调 `7z` 二进制」路线，能力上限与 MT 相当；若想零依赖，则要接受「只支持 zip/tar 系列」的边界。**不存在"用纯 Java 库全格式覆盖"的便宜路径** —— MT 也是靠 native 绑定。

### 2.2 功能范围【资源】

从中文资源反查到的能力（每条都有字符串证据）：

| 能力 | 证据字符串 |
|---|---|
| **分卷压缩** | `分卷大小` / `分卷大小至少 64 KB` / `不支持修改分卷压缩包` |
| **压缩级别** | `压缩级别` |
| **压缩策略** | `大小优先：尽可能对所有文件以压缩方式进行打包以减小体积` |
| **压缩包测试（CRC）** | `已有压缩文件测试正在进行` / `测试发现压缩文件错误` / **`压缩文件在测试过程中发生变化，请重新测试`** |
| **不解压浏览** | `浏览压缩包` |
| **常用密码管理** | `常用密码` / `常用密码管理` / `常用密码自动尝试` |
| **格式不支持时的处理** | `不支持测试此压缩文件` |

### 2.3 两个值得直接借鉴的设计

**① 常用密码自动尝试**【资源】

原文（`strings.xml`）：

> 将常用密码添加到此处，解压加密的压缩文件时将**自动按顺序尝试这些密码**，若全部失败再手动输入；压缩文件时也可快速选择这些密码进行输入。

> 当前暂无记录，**最近一次压缩文件密码成功匹配记录**将会显示在此处。

**设计要点**：
- 维护一个「常用密码」列表（用户自建）
- 解压加密包时**按顺序自动试**，全失败才让用户手输
- **记住最近一次成功的密码**，下次优先试
- 压缩时也能快速选密码

> 这比「每次手输」体验好得多，且**避免了"忘记密码"**这个最致命的场景。`docs/18` 功能②（压缩包密码）应当采用这个设计。

**② 压缩包测试的「期间变化」检测**【资源】

`压缩文件在测试过程中发生变化，请重新测试` —— 说明 MT 在**测试期间会检测包是否被外部改动**。

> 这与我们在 `docs/audit/M5-审查与修复.md` 里发现的 **P-06**（校验通过 → 删除前源文件变动无 re-check）是同一类问题。MT 的做法印证了：**校验不是一次性动作，期间的一致性要单独校验**。

### 2.4 业务代码的可分析性【代码】

引用 `sevenzipjbinding` 的类都被混淆（`l/C14732` / `l/C14742` / `l/C19667` / `l/C10836` 等，22~85 行），**只作回调包装**，主体调度逻辑因混淆 + native 调用而难以还原为可读流程。

**结论**：**能学到「用了什么库、支持什么功能、有哪些交互设计」，但学不到「具体实现代码」** —— 业务层被混淆，核心在 native 库。

---

## 三、插件可行性再核实（**结论：不可行，双重阻断**）

上一轮结论是「v3 插件 API 没有文件菜单扩展点」。这次从 APK 里逐类核对，得到更硬的证据。

### 3.1 插件 API 全貌【代码】

`bin/mt/plugin/api/` 共 **84 个类**，`PluginContext.SDK_VERSION = 3`。按包分组：

| 包 | 类数 | 内容 |
|---|---|---|
| `api/` | 3 | `PluginContext`（接口）、`LocalString`、`R` |
| **`api/editor/`** | **11** | **文本编辑器扩展点**：`BaseTextEditorBaseMenu` / `BaseTextEditorFloatingMenu` / `BaseTextEditorToolMenu` / `BaseTextEditorFunction` + `TextEditor` / `BufferedText` 等 |
| **`api/translation/`** | 4 | 翻译引擎扩展点（`BaseTranslationEngine` / `BatchTranslationEngine` 等） |
| `api/regex/` | 5 | 正则（`Pattern` / `Matcher` / `Regex`） |
| `api/ui/` | 40 | UI 组件 + builder + dialog + **menu**（`PluginMenu` / `PluginMenuItem` / `PluginPopupMenu` / `PluginSubMenu`） |
| `api/preference/` | 1 | 偏好设置 |
| `api/drawable/` | 5 | 图标加载 |
| `api/util/` | 8 | 异步任务、回调、UI 更新 |

**扩展点只有三类：编辑器（editor）、翻译（translation）、正则（regex）。**

**没有**：`api/file/`、`api/archive/`、`api/compress/` —— **不存在文件管理器或压缩的扩展点**。

### 3.2 `PluginContext` 的能力边界【代码】

完整方法清单（接口，93 行）：

```
剪贴板     getClipboardText / setClipboardText / hasClipboardText
资源       getAssetsAsStream / getAssetLocalString
文件       getFilesDir()            ← 仅插件自己的私有目录
插件信息   getPluginId / getPluginName / getPluginVersionName / getPluginSdkVersion
偏好       getPreferences()
国际化     getString / getStringArray / getStringList / getCountry / getLanguage
日志       log(...) / openLogViewer()
UI         showToast / cancelToast / openPreference / openBrowser / openBuiltinBrowser
```

**关键缺失**：

- ❌ **没有任何用户文件访问能力** —— 唯一与文件相关的是 `getFilesDir()`（插件自己的目录）
- ❌ 没有「读取用户选中的文件/目录」的接口
- ❌ 没有启动进程 / 执行命令的能力
- ❌ 没有文件管理器菜单、工具栏、长按菜单的扩展点

### 3.3 为什么这是决定性的

原设想的核心切入点是「MT 原生不支持压缩 SMB 上的文件，插件把这个灰按钮点亮」。这个设想需要**同时**满足两个条件：

| 条件 | 实际 | 结论 |
|---|---|---|
| ① 能在文件管理器里加入口（菜单/按钮） | 扩展点只有 editor / translation / regex | ❌ **不满足** |
| ② 能拿到用户选中的文件路径并读写 | `PluginContext` 无文件访问能力 | ❌ **不满足** |

**即使将来 MT 开放了文件菜单扩展点，只要 `PluginContext` 不提供文件访问，插件仍然做不了这件事** —— 所以这不是"等 API 升级就好"的问题，而是插件沙箱模型本身的限制。

### 3.4 顺带核实：SMB 是 VIP 功能【推断 + 待验证】

- `smb://` 是 MT 内部使用的路径形态（远程路径表示）
- SMB 挂载属 **VIP 付费功能**
- **未直接验证到**：SMB 相关字符串未在中文资源中命中（可能在 VIP 模块的资源或运行时下发的配置里）

> 该项保持「待验证」，不作为结论使用。

---

## 四、对 ZipCalm 的借鉴点

| MT 的做法 | 是否借鉴 | 理由 |
|---|---|---|
| 用 sevenzipjbinding 全格式覆盖 | ❌ 不借鉴 | 需要 native 绑定，与「零依赖优先」冲突；我们走「Node 内置 + 可选外部二进制」 |
| **常用密码自动尝试 + 记住最近成功密码** | ✅ **强烈建议借鉴** | 直接解决「忘记密码 = 数据不可读」这个最致命场景，`docs/18` 功能②应采用 |
| **压缩包测试期间的变化检测** | ✅ 借鉴 | 与我们的 P-06 同类问题，印证「一致性要单独校验」 |
| 不解压浏览压缩包内容 | ✅ 可借鉴（后续功能） | 用户能先看内容再决定是否解压 |
| 分卷压缩 | ⚠️ 可选 | 大文件分发有用，但增加实现复杂度；非当前需求 |
| 压缩级别 + 大小优先策略 | ✅ 部分借鉴 | 我们已有 `levelRange` / `defaultLevel`，可加「策略」说明 |
| 混淆 + native 保护核心逻辑 | — | 商业软件做法，开源项目不需要 |

---

## 五、未验证项与方法限制

| 项 | 状态 |
|---|---|
| 业务层具体实现流程 | ❌ 不可得 —— 类名混淆 + 核心在 native |
| SMB 路径的完整支持范围 | ⚠️ 待验证 —— 需真机 + VIP 账号实测 |
| 分卷压缩的具体参数约束 | ⚠️ 仅知「至少 64 KB」，其余未深挖 |
| `libmtprotect.so` 是否含运行时完整性校验 | ⚠️ 未分析（不影响本次结论） |
| 插件 API 的运行时加载机制 | ⚠️ 未深挖（结论已由「扩展点清单 + PluginContext 能力」确定，不需要） |

**方法限制**：纯静态分析，未在真机运行；混淆导致部分调用链不可读；native 逻辑未反汇编。

---

## 六、结论

1. **压缩实现可学的是「库选型 + 功能设计」，不是代码** —— MT 用 7-Zip JBinding + zstd-jni，业务层混淆 + native 保护
2. **最值得抄的是「常用密码自动尝试」** —— 直接消灭「忘记密码」这个不可逆风险
3. **MT 插件路线彻底不可行** —— 双重阻断：无文件菜单扩展点 + `PluginContext` 无文件访问能力。这不是"等 API 升级"，是沙箱模型限制
4. **M9 继续走 PWA** —— 与上一轮结论一致，本轮提供了更硬的证据
