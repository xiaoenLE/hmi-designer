# 打包与发版手册（WebHMI_设计器）

> **先读这条铁律**：`tools/build-release.ps1`（尤其 `-Publish`）**只有用户明确说"打包/发版"时才跑**。
> 平时改代码只跑**不产生构建产物**的检查（`tools/check-syntax.py`、源码模式的自检套件）。
> 另外：`git commit` / `git push` 也是"用户说了才做"（见 `docs/gitea-ops.md` 第 0 节）。

---

## 1. 一键打什么样

```powershell
cd C:\Users\Administrator\Desktop\hmi\hmi-designer

.\tools\build-release.ps1                  # 只在本地产出（build\release\），不发出去
.\tools\build-release.ps1 -SkipExe         # 只重打 app 代码包（壳没变时用，几秒）
.\tools\build-release.ps1 -Publish         # 打完发到 Gitea（需要下面的凭据）
.\tools\build-release.ps1 -SkipExe -Publish  # 只改了业务代码：几秒出包并发布
```

```powershell
$env:HMI_GIT_USER='xiaoen'; $env:HMI_GIT_PASS='……'   # 凭据只用环境变量，别写进文件
```

**产出（`build\release\`）**：

| 文件 | 多大 | 用途 |
|---|---|---|
| `WebHMI-Designer-Setup-<ver>.exe` | ~36 MB | 现场装机：双击 → **自己选安装路径** → 装完出原生窗口 |
| `WebHMI-Designer-<ver>-app.zip` | ~3 MB | **日常更新用的代码包**（编辑器里点「立即更新」时下的就是它） |
| `version.json` | 1 KB | 发布清单（版本/说明/包地址/**sha256**）→ 提交到 `release/version.json` |

版本号来自**仓库根的 `version.json`**（人工改 version/date/notes）；清单是脚本生成的，
两者**必须分开**（原因见 `docs/gitea-ops.md` 第 4 节）。

---

## 2. 为什么要拆成"壳 + app"两层（改布局前必读）

```
<安装目录，默认 C:\Program Files\WebHMI-Designer>\
├── WebHMIDesigner.exe          壳：Python 运行时装在 exe 里 + pywebview + WebView2 桥接
├── _internal\                  壳自带的东西（DLL/运行时，很少变）
└── app\                        **业务代码全在这儿（日常更新只换这一层）**
    ├── index.html  css\  js\
    └── server\  (server.py / modbus.py / updater.py / _restart.py …)

%ProgramData%\HMI-Designer\     ★ 现场数据，**安装/更新/卸载都不碰**（名字永远别改）
├── data\   画面工程 / 变量表 / PLC 配置 / 报警记录 / 口令 / 掉电保持值
└── logs\   按天日志 + 更新日志
```

* **运行中的 exe 不能覆盖自己**（Windows 锁文件）→ 更新只能是"替换旁边那几个文本文件"，
  所以**不用重装、不弹 UAC、只有几 MB**；只有"壳"要升级时才重跑安装包。
* 因此 **`app\` 里绝不能有 `server/data`**：`packaging/launcher.py` 与安装器都会显式跳过它，
  `server/updater.py` 里还有一条**硬断言**（要写进数据目录的路径一律拒绝整个更新）。

**相关文件**：

| 文件 | 作用 |
|---|---|
| `packaging/launcher.py` | 壳：定数据目录（`%ProgramData%\HMI-Designer`）、把 `app\` 接上 sys.path、老布局数据自动沿用、`--hmi-update-helper` 时自己当更新助手 |
| `packaging/WebHMIDesigner.spec` | PyInstaller 打壳（onedir；业务代码**不打进 exe**，否则就地更新失效） |
| `packaging/installer.py` + `installer.spec` | 自带安装器（tkinter GUI）：可选安装路径、快捷方式、卸载器（保留数据）、静默安装/卸载 |
| `packaging/WebHMIDesigner.iss` | Inno Setup 脚本（可选：能上 GitHub 的机器上传 `-Iscc <ISCC.exe>` 就会优先用它） |
| `packaging/hmi.ico` / `tools/make-icon.py` | 应用图标（9 个尺寸；exe / 安装包 / 快捷方式 / 网页页签共用） |
| `tools/build-release.ps1` | 一键：自检 → 摆 app\ → 打代码包 → 打壳 → 打安装包 → 写清单 →（-Publish）发布 |
| `tools/check-syntax.py` | 打包前门禁：python 全量编译 + 前端 js 真解析 + 关键文件在位 |

---

## 3. 打包环境（换机器时看这节）

| 项 | 要求 / 现状 |
|---|---|
| **解释器** | **必须是稳定版 Python**。本机 `py -3.10` 是 **3.10.0b1（beta）**，PyInstaller 扫字节码会 `IndexError` 崩掉；脚本默认用系统 **Python 3.11**（`python`） |
| Python 依赖 | `pyinstaller`、`pywebview`（含 pythonnet/clr_loader）、`asyncua`（OPC UA）、`Pillow`（生成图标）。装 3.11 那一份：`python -m pip install pyinstaller pywebview asyncua pillow` |
| WebView2 运行时 | 目标机器要有（Win10/11 基本自带）。安装器会检测并提示，不偷偷联网装 |
| Inno Setup | **可选**。它只发布在 GitHub，本构建机连不上（winget 也因此卡死）→ 默认用自带安装器；能用时传 `-Iscc` |
| 磁盘 | `build\` 里会有 ~100 MB（壳 49 MB + 安装包 37 MB + 中间产物），已 gitignore |

---

## 4. 打包时的 Windows PowerShell 5.1 坑（脚本已处理，改脚本别踩回去）

1. **原生命令往 stderr 写东西会被当成错误** → 脚本里用 `$ErrorActionPreference='Continue'`，
   并且**每个原生命令后显式检查 `$LASTEXITCODE`**（PyInstaller 全往 stderr 打 INFO）。
2. **没有 `Invoke-RestMethod -Form`**（那是 PS 6+）→ 传附件用 **`curl.exe -F`**；
   否则会出现"提示上传成功、实际 0 字节"。
3. **字符串 body 按 ANSI 编码** → 往 Gitea 写中文必须发 **UTF-8 字节**（`Send-GiteaJson`）。
4. **`.ps1` 只写 ASCII**（无 BOM 的 UTF-8 会被当 GBK 读、中文串直接把解析器搞崩）；
   必须写中文就存 **UTF-8 with BOM**。
5. 脚本里**别内联多行 Python**（引号/编码能把它搞崩）—— 放到 `tools/*.py` 里调用。

---

## 5. 发布环节做了什么（`-Publish`）

1. `release/version.json` 提交到仓库（contents API，UTF-8 字节）
2. `release/README.md`（下载与安装页，源文件 `packaging/release-readme.md`）同步
3. 建/更新 tag `v<版本>` 的 Release（**已存在也 PATCH 说明**，这样历史发布页的乱码能被修回来）
4. 两个附件上传（`curl -F`）到 tag 上；**同名旧附件先删**（Gitea 同名会并存，下载解析到第一个）
5. **下载回来比对 sha256**，与本地构建字节不一致就报错
6. 拉一次 `release/version.json`，确认版本号等于本次版本，否则报错

所以"发布了"这句话是有验证的，不是打印一句就算。

---

## 6. 验收：怎么证明这个包是好的

```powershell
# ① 语法/结构门禁（不产生产物）
python tools\check-syntax.py

# ② 沙箱自检：更新成功 / 版本对不上拒绝 / 坏版本自动回滚 / 数据目录保护（不碰真仓库）
python test\verify-update-apply.py            # 约 3 分钟

# ③ 打包之后才能跑的：exe 就地上更新（真装真跑真更新）
python test\verify-exe-update.py              # 17 项；会临时装一份、验完自己清掉
```

**手工验收（最直观）**：

```bat
:: 静默装到指定目录（GUI 有问题时的兜底；也用于批量部署）
WebHMI-Designer-Setup-1.0.7.exe --silent --dir=D:\WebHMI-Designer --no-launch
:: 卸载（保留 %ProgramData%\HMI-Designer）
WebHMI-Designer-Setup-1.0.7.exe --uninstall --dir=D:\WebHMI-Designer
```

装完自检：运行页按 `Ctrl+Shift+E` 进编辑器 → 状态栏右下角应显示当前版本号；
点「⬆ 有新版本」能开对话框（**只显示这次改了什么**）。

---

## 7. 常见故障速查

| 现象 | 原因 / 处理 |
|---|---|
| 双击安装包，**看不到「开始安装」** | 老版本安装器窗口写死尺寸 + 未声明高 DPI，被系统放大后超出屏幕（已修）。临时办法：`--silent` 静默装；已修版本还支持回车触发、`HMI_INSTALLER_GEOM=520x360` 指定窗口大小 |
| 换了 exe，**桌面图标还是旧的** | Windows 图标缓存。安装器现在会 `SHChangeNotify(SHCNE_ASSOCCHANGED)` + `ie4uinit -show` 自动刷新；实在不刷新就桌面按 F5，或清 `%LOCALAPPDATA%\...\iconcache_*.db` 并重启资源管理器 |
| 客户端点了「立即更新」却下到旧包 | Gitea 同名附件并存（下载解析到第一个）。删旧附件重传，并用 sha256 复核（脚本已做） |
| 更新后**服务没起来** | 看 `<数据目录>\..\logs\update-<日期>.log`（和 `-child.log` / `-app.log`）；人工回滚：`WebHMIDesigner.exe --hmi-update-helper --rollback` |
| 客户端说"已经是最新"但明明发了新版 | 它问的还是旧地址（≤1.0.4 的机器）→ 手动装一次新版；或带 `HMI_UPDATE_URL` 环境变量启动让它认新地址 |
| `PyInstaller` 报 `IndexError: tuple index out of range` | 用了 beta 解释器（3.10.0b1）→ 换系统 Python 3.11（脚本已默认） |
| 打出来的包**页面白板**（窗口能开、接口正常） | `app\` 里少了前端文件。两个历史原因：① 静态文件按进程工作目录找（已改成按 ROOT 找）；② 安装器"跳过 data 目录"一刀切把 `js/data/pinyin.js` 也跳了（已改成精确匹配）。`test\verify-exe-update.py` 现在专门断言"前端文件一个不少 + 静态文件取得到" |

---

## 8. 发一版的完整流程（建议照这个顺序）

```powershell
# 1) 改代码 + 改仓库根 version.json（version / date / notes —— notes 会显示在客户端的更新对话框里）
# 2) 本地自检
python tools\check-syntax.py
# 3) 用户确认可以发 → 提交
git add -A; git commit -F "$env:TEMP\msg.txt"
git fetch origin; git -c user.email=xiaoen@local -c user.name=xiaoen pull --rebase origin master
$u="http://xiaoen:$env:HMI_GIT_PASS@124.221.183.24:3000/xiaoen/hmi-designer.git"; git -c credential.helper= push $u master
# 4) 打包并发布
$env:HMI_GIT_USER='xiaoen'; .\tools\build-release.ps1 -Publish
# 5) 复核：Releases 页的中文说明、附件大小、清单里的 sha256（脚本会自动验，人眼再看一眼发布页）
```
