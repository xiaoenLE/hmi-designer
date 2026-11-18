# HMI 组态设计器 · 发布仓库

这里放**装出来的东西**（安装包 / 日常更新用的代码包 / 更新清单），源码和完整文档在另外两个仓库。

| 仓库 | 里面是什么 |
|---|---|
| **xiaoen/hmi-designer-release**（本仓库） | 安装包、更新代码包、`version.json` 清单、以及本页下方这套说明文档 |
| [xiaoen/hmi-designer](http://124.221.183.24:3000/xiaoen/hmi-designer) | 软件**源码**（原生 JS 前端 + 零依赖 Python 后端） |
| [xiaoen/hmi-mcp](http://124.221.183.24:3000/xiaoen/hmi-mcp) | **MCP 服务**：给 AI 一个端口，就能读/画/改当前打开的工程 |

## 装哪个、怎么装

| 文件 | 多大 | 什么时候用 |
|---|---|---|
| `HMIDesigner-Setup-<版本>.exe` | ~36 MB | **现场装机**：双击 → 自己选安装路径 → 装完出原生窗口（不用装 Python、不用记地址、不用看控制台） |
| `HMI-Designer-<版本>-app.zip` | ~3 MB | **日常更新**：由程序自己用（编辑器里点「立即更新」），不用手下载 |

下载地址在各自的 Release 页面（tag = `v<版本>`），例如：

```
http://124.221.183.24:3000/xiaoen/hmi-designer-release/releases/download/v1.0.4/HMIDesigner-Setup-1.0.4.exe
```

静默安装（批量部署用）：

```bat
HMIDesigner-Setup-1.0.4.exe --silent --dir=D:\HMI --no-shortcut --no-launch
HMIDesigner-Setup-1.0.4.exe --uninstall --dir=D:\HMI        :: 卸载（保留现场数据）
```

## 装完之后

* **程序**：你选的安装目录（默认 `C:\Program Files\HMI-Designer`）= `HMIDesigner.exe + _internal\ + app\`
* **现场数据**：`C:\ProgramData\HMI-Designer\`（`data\` = 画面工程/变量表/PLC 配置/报警记录/口令；`logs\` = 日志）
  —— **安装、更新、卸载都碰不到它**，这是"更新不会删配置和工程"的根本保证
* **升级**：编辑器状态栏出现「⬆ 有新版本」→ 点「立即更新」→ 只替换 `app\` 那层代码（几 MB、不弹 UAC），
  更新前自动备份、起不来自动回滚。**图标属于"壳"，换图标要装新版安装包**。

## 最新版本

当前：见 [`version.json`](version.json)（里面还带代码包的 sha256，客户端会校验）。

```json
{ "version": "1.0.4", "notes": "…", "app_zip": { "url": "…", "sha256": "…" } }
```

## 文档（软件完整说明）

| 文档 | 内容 |
|---|---|
| [`docs/HMI-Designer-说明.md`](docs/HMI-Designer-说明.md) | **软件完整说明**（= 源码仓库 README.md 的副本）：给客户现场怎么用、快捷键、控件逐个说明、PLC/OPC UA 对接、报警、脚本、权限、打包与更新流程、踩坑记录 |
| [`docs/add-widget.md`](docs/add-widget.md) | 怎么新增一个控件（一控件一个文件） |
| [`docs/widget-pack.md`](docs/widget-pack.md) | 控件包格式（`.hmiw.json`，把控件导给别人用） |
| [`version.json`](version.json) | 更新清单（版本、更新说明、代码包地址与 sha256） |

> 每个版本发布时，构建脚本（源码仓库 `tools/build-release.ps1`）会把这三份文档一起提交到这里，
> 所以**这里的说明永远跟发布版本对得上**。
