# MT 管理器 APK 逆向分析（3/4）—— SMB 与远程路径处理

> 证据分级：`[代码]` = dex 类名/方法名串 · `[字符串]` = dex/arsc 文案 · `[推断]` = 推理
> **这份直接决定 ZipCalm「MT 插件 + SMB 转发」路线是否成立**，所以每条都带证据，不猜。

## 结论先说

1. **SMB 路径形态 = `smb://` 字符串**（`[代码]` dex 里 `smb://` 明文，含 `smb:////` 变体）。MT 用 **SMBJ**（完整 SMB1/2/3 协议栈，Java 实现，非 jcifs）。
2. **SMB 在 MT 里是 VIP 功能**（`[代码]` arsc 里 `SMB (VIP)`、`FTPS (VIP)`、`SFTP (VIP)`、`WebDav (VIP)`）。
3. **MT 对 SMB 上的压缩选择"绕开"而非"远程压"**：明确提示"当前目录权限不足，请将压缩文件复制到内部存储后再操作"（`[字符串]` arsc 原文）。**这正好印证了 ZipCalm 的切入点判断**：MT 原生不压 SMB 文件，用户被引导去"先复制到本地"——而 ZipCalm 想做的正是"直接让 NAS 自己压"，省掉那次复制。
4. **但插件能不能读到 SMB 路径 = 仍未验证**（见下）。宿主插件 API（`bin.mt.plugin.api`）原样打进 dex，接口面与官方 v3 文档完全一致，**没有任何文件侧 API**——这一条从宿主侧独立复核了上一轮结论。

## 一、SMB 协议栈实况

### 1.1 用的是 SMBJ（`[代码]`）

dex 里有完整的 SMBJ 符号集：

```
SMB2_NEGOTIATE / SESSION_SETUP / TREE_CONNECT / CREATE / READ / WRITE / CLOSE / QUERY_DIRECTORY
SMB2_IOCTL / LOCK / FLUSH / CHANGE_NOTIFY / ECHO / CANCEL / LOGOFF / OPLOCK_BREAK
SMB2_SHAREFLAG_*、SMB2_GLOBAL_CAP_DFS / ENCRYPTION / LEASING / MULTI_CHANNEL / LARGE_MTU
SMB1 兼容层：SMB_COM_NEGOTIATE / SESSION_SETUP_ANDX / TREE_CONNECT_ANDX / NT_CREATE_ANDX /
            READ_ANDX / WRITE_ANDX / QUERY_INFORMATION / FIND_CLOSE2 / TRANSACTION2
SmbComOpenAndX / SmbComReadAndX / SmbComWriteAndX / SmbComNTCreateAndX / SmbComTreeConnectAndX
Smb2NegotiateResponse / Smb2SessionSetupRequest / Smb2TreeConnectRequest
SMB 版本协商串：SMB 2.002 / SMB 2.1 / SMB 3.0 / SMB 3.02 / SMB 3.11 / SMB1_ONLY / SMB2_ONLY / SMB3_ONLY
签名与加密：SMBSigningKey / SMBAppKey / SMBC2SCipherKey / SMBS2CCipherKey / SMB2AESCCM / SMB2AESCMAC
            SMB2_SESSION_FLAG_ENCRYPT_DATA / IS_GUEST / IS_NULL
错误态：SMB protocol probing failed / SMB server requires signing / SMB protocol context is stale
       SMBv1 is not supported by SMBJ
传输中断态（写路径，很关键）：SMB write canceled / SMB write failed / SMB write interrupted /
                              SMB write timed out / SMB write returned no progress
流式读：SmbFileInputStream skip failed
```

**版本支持上限 SMB 3.1.1 + AES 加密 + 多通道**。`[推断]`：这是 SMBJ 库（`com.hierynomus.smbj`）的典型符号集，MT 直接集成而非自研。

### 1.2 路径形态（`[代码]`）

```
smb://          （主形态，出现在 classes.dex / classes2 / classes4 / classes5）
smb:////        （classes4，[推断] 兼容性变体/边界处理）
ftps:// / ftps@ （classes4）
ftp://          （classes / classes2 / classes3 / classes4）
cifs/ 、cifs/%s  （classes3，[推断] 内部别名或旧路径兼容）
webdav / webdav@（classes4 / classes5）
```

**结论：MT 挂载 SMB 后，插件侧能看到的路径形态就是 `smb://` 字符串**（若插件能拿到路径的话）。这与 ZipCalm 09 §11.5 第 1 条的假设方向一致。

### 1.3 远程协议全家桶（`[代码]` arsc 里的 VIP 标记）

```
FTPS (VIP)   SFTP (VIP)   SMB (VIP)   WebDav (VIP)
```

→ **四类远程协议全是 VIP**。非 VIP 用户连 SMB 挂载都用不了。这对 ZipCalm 是**用户门槛事实**（目标用户需有 MT VIP）。

## 二、远程文件的操作能力（MT 原生能做什么）

### 2.1 读

- `[代码]` `SmbFileInputStream`（带 skip）→ **流式读 SMB 文件**
- `[代码]` `SMB_COM_QUERY_INFORMATION` / `SMB2_QUERY_DIRECTORY` → 列目录、取文件属性

### 2.2 写

- `[代码]` `SMB_COM_WRITE_ANDX` / `SmbComWriteAndX` / `SMB2_WRITE` / `SMB2_SET_INFO` → **MT 原生能写 SMB**
- `[代码]` `SmbComCreateDirectory` / `SMB_COM_CREATE_DIRECTORY` → 建目录
- `[代码]` `SmbComDelete` / `SMB_COM_DELETE` → 删
- `[代码]` `SmbComRename` / `SMB_COM_RENAME` → 改名
- `[代码]` `SmbComLockingAndX` → 文件锁

**→ 写回 SMB 在 MT 原生层面完全可行（宿主有完整 SMB 写栈）**。ZipCalm 09 §11.5 第 3 条"能否写回 SMB"，从宿主能力看是**能**，但**插件能否调用到这条栈是另一回事**（见第四节）。

### 2.3 上传/下载与传输控制（`[字符串]` arsc）

```
"启用多线程传输 可以提升上传、下载、删除文件的速度，但有些服务器并不支持该技术，开启后会导致一些问题，请自行测试"
"主动 传输模式 被动"                          （FTP 主被动）
"以下文件已被修改，是否上传更新？"
"压缩传输 自定义 UA"                          （[推断] HTTP 传输的压缩开关）
"无 WiFi 网络"
"总进度 正在传输"
```

**"压缩传输"这一条是 ZipCalm 可借鉴点**：MT 在 HTTP 传输链路上可选压缩，减少流量。

## 三、MT 对 SMB 上压缩的真实策略（最关键）

`[字符串]` arsc 原文（一字不改）：

```
"压缩级别 Q%s 当前目录权限不足，请将压缩文件复制到内部存储后再操作"
"%s 当前目录权限不足，无法直接解压，可先解压到其它文件夹再复制过来"
```

`[字符串]` 相关配套：

```
"无法访问文件所在目录，已将该文件复制到临时目录"
"E无法访问文件所在目录，已将该文件复制到临时目录 无法复制到相同目录 无法移..."
```

**MT 的逻辑很明确**：
- 在 SMB（或其他无写权限目录）上点压缩 → **不直接压**，而是提示"请先把压缩文件复制到内部存储再操作"
- 解压同理：先解压到别的文件夹，再复制过来
- 打不开的文件 → 自动复制到临时目录再打开

**这就是 ZipCalm 切入点的最强证据**：MT 不是"技术上不能压 SMB"（它有完整 SMB 读写栈），而是**产品上选择绕开**（避免把几十 GB 数据经手机过一遍）。ZipCalm 的"发给 NAS 自己压"与这个思路**同向且更进一步**——用户侧零复制。

> ⚠️ 但注意：这也意味着**"MT 原生压缩 SMB 是灰的"这个说法需要修正**。从证据看，MT 的压缩菜单项在 SMB 目录下**未必是灰的**，更可能是**点了之后弹"权限不足，请复制到内部存储"的提示**（`[推断]`，未在 arsc 找到"灰色/不可用"类文案佐证）。ZipCalm 09 §11.2 写的"MT 原生压缩 SMB 文件是灰的"这一前提，`[未验证]`，建议真机确认。

## 四、插件扩展点再核实（本次重点）

### 4.1 宿主 dex 里原样包含整套插件 API

`[代码]` `classes.dex` 里出现（未混淆，类名与官方 jar 逐字一致）：

```
bin/mt/plugin/api/PluginContext、LocalString、R
bin/mt/plugin/api/drawable/{MaterialIcons,VectorDrawableLoader}
bin/mt/plugin/api/editor/{TextEditor,TextEditorBaseMenu,TextEditorFunction,
                          TextEditorFloatingMenu,TextEditorToolMenu,
                          BaseTextEditorFunction,BaseTextEditorFloatingMenu,
                          BaseTextEditorToolMenu,BufferedText}
bin/mt/plugin/api/preference/PluginPreference(+Builder/Input/Switch/List/Text/Header…)
bin/mt/plugin/api/regex/{Regex,Pattern,Matcher}
bin/mt/plugin/api/translation/{TranslationEngine,BatchTranslationEngine,
                               BaseTranslationEngine,BaseBatchTranslationEngine}
bin/mt/plugin/api/ui/{PluginUI,PluginView,PluginViewGroup,PluginButton,PluginTextView,
                      PluginEditText,PluginCheckBox,PluginSwitchButton,PluginSpinner,
                      PluginProgressBar,PluginRadioButton,PluginRadioGroup,PluginImageView,
                      PluginFrameLayout,PluginLinearLayout,PluginCompoundButton…}
bin/mt/plugin/api/ui/builder/*（16 个 builder）
bin/mt/plugin/api/ui/dialog/{PluginDialog,LoadingDialog,ProgressDialog,DualProgressDialog,
                             BaseCancelableDialog}
bin/mt/plugin/api/ui/menu/{PluginMenu,PluginMenuItem,PluginSubMenu,PluginPopupMenu}
bin/mt/plugin/api/util/{AsyncTask,ThreadUtil,UIUpdater,UIUpdaterGroup,ServiceLoader,
                        Consumer,Supplier,ResultCallback}
```

### 4.2 与上一轮（官方 jar）结论交叉验证

上一轮从 `maven.mt2.cn` 下载 `api-3.0.0.aar` 解出 **150 个类**。本次从**宿主 dex**（用户实际在跑的版本）看到的是**同一套类，一个不多一个不少**：

- ✅ **没有** `bin.mt.plugin.api.file.*` / `FileAction` / `FileList` / `SelectedFiles` 之类
- ✅ **没有** 任何"文件菜单/文件操作"接口
- ✅ `PluginContext` 依然只有运行时环境能力（无选中文件 API）

**→ 上一轮"v3 插件 API 没有文件菜单扩展点"的结论，从宿主侧独立复核成立。这不是文档滞后，是宿主实际就这样。**

### 4.3 插件是怎么被加载的（`[代码]` + `[推断]`）

- `[代码]` `bin.mt.plugin.api.util.ServiceLoader`（在插件 API 里，也有宿主侧同名类）→ **插件通过 ServiceLoader / META-INF services 注册实现类**，与官方文档 `interfaces = [...]` 配置一致
- `[代码]` manifest 有 `activity-alias bin.mt.plugin.PusherReceiver` + `scheme mtplugin` 的 Activity → **插件安装走 `mtplugin://` scheme + Pusher 推送**
- `[代码]` manifest `provider bin.mt.plus.fp`（`grantUriPermissions=true`）→ `[推断]` 给插件跨进程传文件用
- `[代码]` manifest 有 `taskAffinity="bin.mt.plus.Plugin"` 的 `singleInstance` Activity → `[推断]` 插件 UI 独立任务栈

### 4.4 插件能否读到 SMB 路径？

**`[未验证]` —— 这是唯一必须真机实测的一条。**

- 宿主**有** SMB 读栈（`SmbFileInputStream`）、**有** `smb://` 路径形态
- 但插件 API 里**没有**任何"文件/路径/SMB"相关接口
- 唯一可能拿到路径的公开 API 是 `TextEditor.getFilePath()`（`[代码]` 在插件 API 里存在；`[字符串]` 官方文档说明是"当前编辑的文件绝对路径，不支持时返回 null"）
- **`getFilePath()` 在打开 SMB 上的文本文件时返回什么（`smb://…`？null？内部句柄？）→ 只能实测**

## 五、对 ZipCalm 的判定

| ZipCalm 09 §11.5 未验证项 | 本轮 APK 侧结论 |
|---|---|
| 1. SMB 路径长什么样 | **`smb://`**（`[代码]`），若插件拿得到 |
| 2. 插件能否出现在 SMB 文件菜单 | **宿主插件 API 无文件菜单扩展点**（`[代码]`，宿主 dex 实证）→ **大概率不能** |
| 3. 插件能否写回 SMB | **宿主有完整 SMB 写栈**（`[代码]`），但**插件无公开写接口** → 需实测/或放弃 |
| 4. zstd-jni 能否打进插件 | **MT 自带 zstd-jni 1.5.7-7**（`[代码]`+so）→ 说明该库在 MT 生态可用；但**插件侧能否自带 .so 仍未验证** |

**新增的关键事实（对设计有影响）**：
- MT 原生对 SMB 压缩是"提示复制到内部存储"，**不是灰色按钮** → ZipCalm 09 §11.2 的前提表述建议改为"MT 原生不支持直接压 SMB，会引导用户先复制到本地"
- SMB 是 VIP 功能 → ZipCalm 插件目标用户**必须**有 MT VIP，这是硬门槛，写进文档
- MT 的 SMB 栈有完善的**中断态处理**（canceled/failed/interrupted/timed out/no progress 五种）→ ZipCalm 后端对 SMB 读取的容错可对照设计

## 六、未验证项

1. `TextEditor.getFilePath()` 在 SMB 文件上的实际返回值 —— **必须真机实测**
2. 插件菜单在 SMB 文件长按时是否出现 —— **必须真机实测**（预期不出现）
3. MT 原生压缩菜单在 SMB 目录是"灰色"还是"可点但报权限不足" —— `[推断]` 后者，需真机确认
4. 宿主侧压缩/传输的具体实现类（类名混淆，读不到）—— 全部结论均为库符号 + 文案反推
5. `libmt1/2/3.so` 是否有压缩相关 native 导出符号 —— **未做符号扫描**（本机无 `nm`/`readelf`），`[未验证]`
6. SMBJ 的确切版本号 —— `[未找到]`（dex 无版本串）
7. "压缩传输"具体指哪种协议的压缩 —— `[推断]` HTTP 传输，`[未验证]`
