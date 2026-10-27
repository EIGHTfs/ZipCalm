# RAR 测试样本

用于验收「RAR 解压（只读）」功能（`docs/18` §①）。全部样本由 RARLAB 官方 `rar` 命令生成，
**只入库产物、不入库生成工具**（法律边界见 `docs/18` §附三：RAR 压缩算法为闭源商业算法，
未授权不能分发 `rar` 二进制；但用它生成的数据文件不受限制）。

## 样本清单

| 文件 | 类型 | 用途 | 关键属性 |
|---|---|---|---|
| `s1-rar4.rar` | rar4 单文件 | 最基础的解压路径 | 93 字节，1 个文件 |
| `s2-rar4.rar` | rar4 多文件 + 嵌套目录 | 目录结构还原、逐文件 hash 比对 | 185 字节，`a.txt` + `sub/b.txt` |
| `s3-rar5.rar` | rar5 普通包 | 新格式兼容（`unrar 5.70+` 支持） | 177 字节，内容同 s2 |
| `s4-encrypted.rar` | rar5 加密 | 密码路径：正确密码能解、错密码报「密码错误」 | 318 字节，**密码 `TestRar123`** |
| `s5-multivol.part1~3.rar` | rar5 分卷 | 从 `part1` 进入应能自动拼接出完整内容 | 每卷 10 KB，原始数据 30 KB 随机字节 |
| `s6-broken.rar` | 损坏包 | 错误提示必须是「压缩包损坏」，**不能**误报成密码错或文件不存在 | `s3-rar5.rar` 截断到 100 字节 |
| `s7-chinese.rar` | 中文 + 空格文件名 | 编码不乱码 | `中文文件名.txt` + `带 空格 的文件.txt` |

## 已验证（2026-10-27）

用 `unrar 5.70` 逐个试解，全部符合预期：

```bash
unrar t s1-rar4.rar                      # 退出 0
unrar t s2-rar4.rar                      # 退出 0
unrar t s3-rar5.rar                      # 退出 0
unrar t -pTestRar123 s4-encrypted.rar    # 退出 0
unrar t -pWRONG s4-encrypted.rar         # 报 "The specified password is incorrect."
unrar t s5-multivol.part1.rar            # 退出 0（自动拼接 part2/part3）
unrar t s6-broken.rar                    # 报 "Unexpected end of archive"
unrar t s7-chinese.rar                   # 退出 0，文件名不乱码
```

## 如何重新生成

样本很小（合计约 60 KB），正常情况下直接使用即可。需要重建时：

1. 从 RARLAB 官网下载 Linux 版 `rar`（`rarlinux-x64-*.tar.gz`）到**项目目录之外**的临时位置
2. 解包并 `chmod +x`，然后按下表生成
3. **生成完立刻删除 `rar` 二进制** —— 它不能入库、不能随项目分发

```bash
RAR=/path/to/rar          # 项目外，用完删

# rar4 样本（rar 7.x 起不再支持 -ma4，需用 rar 6.x）
$RAR a -ma4 -idq s1-rar4.rar s1.txt
$RAR a -ma4 -idq -r s2-rar4.rar s2/

# rar5 样本
$RAR a -ma5 -idq -r s3-rar5.rar s2/
$RAR a -ma5 -idq -r -pTestRar123 s4-encrypted.rar s2/
head -c 30000 /dev/urandom > s5big.bin
$RAR a -ma5 -idq -v10k s5-multivol.rar s5big.bin     # 产出 part1~3
head -c 100 s3-rar5.rar > s6-broken.rar               # 截断即损坏
$RAR a -ma5 -idq -r s7-chinese.rar s7/
```

## 没覆盖的一项：恶意条目包

原本想造一个含 `../` 或绝对路径条目的 rar 来验 zip-slip 防线，但 `rar` 命令行会拒绝打包
这类路径，构造需要手工拼二进制头，成本高于收益。

**替代覆盖**：zip-slip 判定走的是 `server/plugins/formats/_shared/entrySafety.js`，与格式无关；
zip 侧的恶意包测试（`scripts/test-invariants-m1.sh`、`test-multiroot.mjs`）已经覆盖了同一套逻辑。
RAR 侧只需确认「解压前会调 entrySafety」—— 这是代码审查项，不必单独造样本。
