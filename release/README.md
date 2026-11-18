# WebHMI_设计器 · 下载与安装

> 本文件在 `release/` 下 —— 和更新清单 `release/version.json` 放一起。
> **源码、文档、安装包、更新清单现在都在同一个仓库**（`xiaoen/hmi-designer`）；
> 安装包与代码包以本仓库 tag `v<版本>` 的 **Release 附件**发布（不进 git 历史，仓库不会越滚越大）。

## 这是什么

工业 WebHMI_设计器：可视化拖拽生成现场画面，用**原生窗口**直接跑（内置 Python 后端 + WebView2），
跟 PLC 通过 Modbus TCP / OPC UA 对接。装好之后不用装 Python、不用记地址、不用看控制台。

## 下载

| 文件 | 多大 | 什么时候用 |
|---|---|---|
| `WebHMI-Designer-Setup-<版本>.exe` | ~36 MB | **现场装机**：双击 → 自己选安装路径 → 装完直接出原生窗口 |
| `WebHMI-Designer-<版本>-app.zip` | ~3 MB | **日常更新**：程序自己用（编辑器里点「立即更新」），不用手下载 |

直链（把 `<版本>` 换成实际版本号，例如 `1.0.6`）：

```
http://124.221.183.24:3000/xiaoen/hmi-designer/releases/download/v<版本>/WebHMI-Designer-Setup-<版本>.exe
http://124.221.183.24:3000/xiaoen/hmi-designer/releases/download/v<版本>/WebHMI-Designer-<版本>-app.zip
```

Release 列表：<http://124.221.183.24:3000/xiaoen/hmi-designer/releases>

静默安装（批量部署 / 自动化用）：

```bat
WebHMI-Designer-Setup-1.0.6.exe --silent --dir=D:\HMI --no-shortcut --no-launch
WebHMI-Designer-Setup-1.0.6.exe --uninstall --dir=D:\HMI        :: 卸载（保留现场数据）
```

## 装完之后

* **程序**：你选的安装目录（默认 `C:\Program Files\WebHMI-Designer`）= `WebHMIDesigner.exe + _internal\ + app\`
* **现场数据**：`C:\ProgramData\HMI-Designer\`（`data\` = 画面工程/变量表/PLC 配置/报警记录/口令；`logs\` = 日志）
  —— **安装、更新、卸载都碰不到它**，这是"更新不会删配置和工程"的根本保证
* **升级**：编辑器状态栏出现「⬆ 有新版本」→ 点「立即更新」→ 只替换 `app\` 那层代码（几 MB、不弹 UAC），
  更新前自动备份、起不来自动回滚。**图标属于"壳"，换图标要装新版安装包**。

## 最新版本

见 [`version.json`](version.json)：版本、更新说明、代码包地址与 **sha256**
（客户端下载后会校验 sha256，对不上就整包丢弃、代码一个字节不动）。

## 文档

| 文档 | 内容 |
|---|---|
| [`../README.md`](../README.md) | **软件完整说明**：给客户现场怎么用、快捷键、逐个控件、PLC/OPC UA 对接、报警、脚本、权限、打包与更新流程、踩坑记录 |
| [`../docs/add-widget.md`](../docs/add-widget.md) | 怎么新增一个控件（一控件一个文件） |
| [`../docs/widget-pack.md`](../docs/widget-pack.md) | 控件包格式（`.hmiw.json`，把控件导给别人用） |

配套的另一个仓库：[`xiaoen/hmi-mcp`](http://124.221.183.24:3000/xiaoen/hmi-mcp) = **MCP 服务**，
给 AI 一个端口，就能读/画/改当前打开的工程。

## 发一个版本（维护者看的）

```powershell
# 1. 改仓库根的 version.json（version / notes）—— 那是**人改的版本源**
# 2. 打包并发布：生成 release/version.json，把安装包与代码包挂到 tag 上，并校验下载回来的字节
$env:HMI_GIT_USER='xiaoen'; $env:HMI_GIT_PASS='……'
.\tools\build-release.ps1 -Publish

# 只改了业务代码（壳没动）时：几秒搞定（不重打 exe/安装包）
.\tools\build-release.ps1 -SkipExe -Publish
```

> ⚠ **清单为什么在 `release/version.json`、而不是仓库根的 `version.json`**：
> 根目录那份是人手改的版本源，开发机 `git push` 会覆盖它；而清单是**构建脚本生成的**
> （多出包地址与 sha256）。两者同一个路径的话，下一次 push 就会把 sha256 冲掉 →
> 所有客户端的校验全失败。所以：**版本源在根，发布清单在 release/**。
