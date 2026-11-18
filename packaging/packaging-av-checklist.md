# 打包与「被当成病毒」清单

这份文档回答一个问题：**下次打包怎么做，才最不容易被杀软 / SmartScreen 拦、被 HIPS 干掉。**
Nuitka 和 PyInstaller 两条产线都写了，因为两条线要同时维护。

> 本文件不参与打包，`packaging\` 目录不会进 app\，也不会进安装包。

---

## 0. 先看优先级（按「收益 ÷ 成本」排序）

| 顺位 | 动作 | 收益 | 成本 |
|---|---|---|---|
| 1 | **代码签名**（OV/EV 证书） | ★★★★★ 未签名是所有误报里权重最大的一项 | 1 张证书 + 1 小时接入 |
| 2 | **只发安装包，不发绿色文件夹 / 裸 exe** | ★★★★ 从浏览器下载的裸 exe 带 MOTW 标记，双击必弹「未知发布者」 | 0（已经这么做） |
| 3 | **主程序绝不自解压到 %TEMP%** | ★★★★ 自解压+高熵+释放后执行＝启发式最爱的组合 | 0（Nuitka 线已经这么做） |
| 4 | **别装 UPX** | ★★★ UPX 壳是传统杀软的重点命中项 | 0（两条线都已关闭） |
| 5 | **减少「自我更新并执行脚本」的行为** | ★★★ HIPS 会盯这个 | 改造量中等 |
| 6 | **不申请管理员常驻、不写开机自启、不监听 0.0.0.0** | ★★ 减少行为面 | 0（现在就是这样） |
| 7 | **保持发布者名/文件名/版本号稳定，壳不要每次重打** | ★★ 无证书时唯一的「信誉」就是哈希 | 0（用 `-SkipShell`） |

一句话：**打包器换不换只影响第 3、4 项；真正决定上限的是第 1 项。**

---

## 1. 铁律三条

1. **能签名就一定签。** 签名是唯一同时解决「未知发布者弹窗」「杀软对匿名 exe 一律从严」「每次重打都是陌生文件」三件事的手段。
2. **对外只给 `Setup.exe`。** 绿色包（`WebHMI-Designer-Nuitka-<ver>\`）只用于自己现场排障，不要发给客户。
3. **两条产线、主程序和安装包，一律用 standalone（目录式）打，绝不 onefile。**
   Nuitka 写 `--mode=standalone`；PyInstaller **不写** `--onefile`（它把这个形态叫 onedir，就是它的 standalone 模式，产物是「exe + `_internal\` + `app\`」一整个文件夹）。
   我们的架构本来就是「壳 + `app\`」两层，壳自解压没有任何好处：启动慢好几秒、每次解压到 `%TEMP%` 正好是启发式最爱的形状。
   **只有用户明确点名要单文件 exe，才可以打 onefile。**

---

## 2. 两条产线各自的固定打法

### 2.1 Nuitka 线（推荐作为主产线）

> `tools\` / `packaging\` 里的脚本是同一套（`build-nuitka.ps1`、`build-pyinst.ps1`、`sign.ps1`、本文件），
> 命令一致。（`hmi-designer-v2 - 自建ai` 那棵树已经在 2026-11-17 清理时删掉，只剩 `hmi-designer-v2`。）

```powershell
cd 'hmi-designer-v2'

# 日常发版：只改了 app\ 里的业务代码（python / js / css），壳没动
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\build-nuitka.ps1 -SkipShell
#   ≈ 3 分钟，只重打安装包；壳 exe 原样复用

# 改了 packaging\launcher.py、installer.py，或动了依赖版本
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\build-nuitka.ps1
#   ≈ 7 分钟（clcache 全热）

# 换了 Python 解释器 / 增删依赖 / 怀疑缓存坏了（慎用）
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\build-nuitka.ps1 -Clean
#   ≈ 22 分钟（371 个 C 文件全量重编）
```

产物：`build\release-nuitka\`（绿色包 + `WebHMI-Designer-Nuitka-Setup-<ver>.exe`）。
旧 PyInstaller 产物 `build\release\`、`build\pyinst\` 一个字节都不会被碰。

> **`build\nuitka\`（约 820 MB）留着别删**——它是 scons 中间产物 + 壳 dist，删掉不影响重打速度：
> 实测删干净后重打仍只要 222 秒（371 个 C 文件 **371 命中 / 0 未命中**）。
> 真正贵的缓存是 `%LOCALAPPDATA%\Nuitka\Nuitka\Cache`（约 230 MB，**装机级、不在仓库里**），
> 它才是「第一次 22 分钟」和「之后 7 分钟」的差别来源；换机器 / 换 Python / 加依赖才会真正退回去。
> `-Clean` 只删 `build\nuitka`、`build\nuitka-stage`、`build\release-nuitka`，**不碰**全局缓存。
> 清理磁盘时可以放心删：`build\nuitka-stage\`（每次重新生成）、`build\nuitka-test\`（分析脚本与截图）、
> `build\release\` 里过期的旧版安装包、`__pycache__`、`logs\`、`out\`。

### 2.2 PyInstaller 线（保留作退路）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\build-release.ps1
```

现状评价：**壳本身已经是 standalone（目录式，PyInstaller 内部叫 onedir，正确）**，问题只剩安装包——没装 Inno Setup 时它回落到 PyInstaller **onefile**，那是整条链上最差的一环（40 MB 自解压 + 熵 7.999 + 引导器特征）。

因此 PyInstaller 线的改进只有两条，按性价比：

1. **装 Inno Setup 6**（约 6 MB，`jrsoftware.org`），脚本会自动走 `packaging\WebHMIDesigner.iss` 分支，安装包立刻从「onefile 自解压」变成「标准安装器 stub + 压缩数据」，同时也是行业里杀软白名单覆盖最广的安装器。
2. 装了也别忘了签名——Inno 的 stub 也是未签名的。

> 参数层面 PyInstaller 线已经没得优化了：`upx=False`、目录式（standalone，不写 `--onefile`）、hiddenimports 精确、excludes 齐全。剩下全是结构性的，换不掉就靠 Inno + 签名补。

### 2.3 PyInstaller standalone（目录式；PyInstaller 管它叫 onedir）做成和 Nuitka 同形状的包

`build-release.ps1` 打的是**正式发版**（app 包 + 安装包 + 发布到 Gitea），它只有 `build\stage\` 里那一层中间产物，不适合拿来跟 Nuitka 摆在一起做 A/B。

所以另有一个专门的对比用脚本，输出**和 Nuitka 绿色包一模一样**的目录：

```powershell
cd 'hmi-designer-v2'
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\build-pyinst.ps1
#   ≈ 30 秒（PyInstaller 的分析阶段比 Nuitka 的 C 编译快一个数量级）
```

| | Nuitka | PyInstaller standalone |
|---|---|---|
| 目录 | `build\release-nuitka\WebHMI-Designer-Nuitka-<ver>\` | `build\release-pyinst\WebHMI-Designer-PyInstaller-<ver>\` |
| 顶层 | `WebHMIDesigner.exe` + 散装 dll/pyd + `app\` + `frp\` + `logs\` | `WebHMIDesigner.exe` + `_internal\` + `app\` + `frp\` + `logs\` |
| 壳 exe | 87 MB，无附加段，熵 6.36，`_MEIPASS` 等标记都没有 | 7.4 MB，**95.6% 是附加段**（自解压归档），熵 7.99，`PyInstaller`/`pyi-`/`_MEI` 标记齐全 |
| 整包 | ≈151 MB / 864 文件 | ≈71 MB / 895 文件 |

唯一去不掉的差别是 `_internal\`：PyInstaller 的 bootloader 写死了「exe 旁边找 `_internal`」，DLL 不能像 Nuitka 那样摊平。其余（exe 名、`app\` 同级、`frp\`、`logs\`、版本信息）完全一致，`app\` 两边是同一份 212 个文件。

这也是**做杀软对比的正确姿势**：两个文件夹丢到同一台测试机，各自用独立 `HMI_DATA_DIR` / `HMI_LOG_DIR` 起一遍，看哪边被拦、哪边被 HIPS 记行为。

---

## 3. 参数级 do / don't

| 项 | 要做 | 不要做 | 原因 |
|---|---|---|---|
| 打包模式（主程序） | **standalone 目录式**：Nuitka `--mode=standalone`、PyInstaller 不写 `--onefile`（= 它的 onedir） | onefile / 单文件 exe（除非用户明确要求） | onefile 每次启动解压到 `%TEMP%\onefile_*`，行为启发式的标准靶子，启动还慢好几秒 |
| 打包模式（安装包） | Inno Setup；退而求其次 onefile | — | 单文件安装包本身可接受，但要选白名单覆盖率高的 stub |
| UPX | `upx=False` / 不加 `--upx` | 任何 UPX 压缩 | UPX 壳是老杀软的头号特征 |
| 版本资源 | company / product / file-version / copyright 全填 | 空版本信息 | 无版本资源的 exe 在多数引擎里加一分可疑 |
| 图标 | `packaging\hmi.ico` | 默认 Python 图标 | 默认图标等于「自编译脚本」标签 |
| 提权 manifest | 安装包要 `requireAdministrator`，**主程序要 `asInvoker`** | 主程序也 requireAdministrator | 常驻程序要管理员＝HIPS 高关注对象 |
| 控制台 | `--windows-console-mode=disable` | 保留黑框 | 黑框一闪是「命令行工具」特征，也难看 |
| 依赖裁剪 | `--nofollow-import-to=tkinter,unittest,pydoc,test,pytest,numpy,...` | 全量 stdlib | 体积越小、无关模块越少，静态特征越干净 |
| 签名 | 壳 exe + 安装包都签（脚本已自动化） | 只签一个 | 只签壳不签安装包，客户在安装这一步就被拦了 |
| 文件名 | `WebHMI-Designer-Setup-<ver>.exe` 保持稳定 | 每次换名 / 加 `_new` / 加 `final` | 命名的稳定性本身是信誉信号 |

---

## 4. 行为层：本产品最容易被 HIPS 盯上的 6 个点

按风险从高到低，都附了代码位置，改不改由产品决定，但**必须知道**。

### 4.1 `frpc.exe`：捆绑的未签名反向隧道客户端（风险最高）

`server\core\frp.py:538-541`：

```python
flags = 0x08000000 if os.name == "nt" else 0        # CREATE_NO_WINDOW：别弹黑框
p = subprocess.Popen([exe, "-c", str(conf)], cwd=str(FRP_DIR),
                     stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                     creationflags=flags)
```

配合 `packaging\frp\frpc.exe`（16.7 MB，**无签名、无版本信息**）一起看：
「隐藏窗口 + 无 stdin/stdout + 未签名的第三方 exe + 主动外连 + 反向端口转发」——这在任何一家国产杀软的行为模型里都接近远控特征。

可选缓解（按代价排序）：

- 把 frp 做成**可选组件**：只有客户在界面里明确点「开启远程协助」时才释放并启动，平时安装包里不含 `frpc.exe`。
- 给 `frpc.exe` **单独签名**（签名前先用 `signtool` 签它，再打进安装包）。
- 不要把 frpc 塞进主安装包，改为客户现场按需下载（企业内网可放到自己服务器）。
- 保底：至少在 README / 交付文档里预先声明「本软件捆绑 frp 开源客户端，用于远程协助」，被拦时客户能对号入座。

### 4.2 自我更新：下载代码再执行

`app\` 是纯 `.py` + `.js`，`launcher.py` 用 `importlib` 从磁盘动态加载并执行。
「程序自行下载文件到自身目录并解释执行」是 HIPS 的经典高危模式。

缓解：更新包用 `release\version-v2.json` 里的 SHA256 强校验（已有），**不要**把更新落到 `%TEMP%` 再执行；下载-写入-校验-切换目录这条链尽量短，且全部在安装目录内完成。

### 4.3 监听端口

`server\hmi_desktop.py` 默认只听 `127.0.0.1`（正确）。
**任何情况下都不要改成 `0.0.0.0`**——一旦监听到非回环地址，防火墙弹窗 + 「后门」启发式会同时触发。

### 4.4 常驻与自启

全仓 grep 结果：`server\*.py` / `server\core\*.py` 里**没有任何** `HKCU\...\Run`、`Startup`、`schtasks`、计划任务代码。
保持现状：**不写开机自启**。如果客户要求自启，用安装器里的复选框 + 开始菜单启动目录快捷方式（可见、可关），而不是静默注册表。

### 4.5 安装 / 卸载副作用

`packaging\installer.py` 会写 `HKLM\...\Uninstall\WebHMI-Designer`、建桌面/开始菜单快捷方式、生成 `uninstall.bat`——这些都是正常安装器行为，没问题。
唯一注意：**新旧包共用同一个卸载键**，测试安装会覆盖正式安装的注册表指向（本次已踩过并手工恢复）。

### 4.6 每次重打都是新哈希

未签名时，编译产物的哈希次次不同，等于每次给杀软一个全新的、零信誉的文件。
因此**改了业务代码就不要重打壳**（`-SkipShell`），壳的哈希能长期稳定，云查杀端才有机会攒出「已知安全」的结论。

---

## 5. 分发与信誉积累

1. **先自检再外发**：把 `Setup.exe` 和壳 exe 的 SHA256 记进发布说明，上传 [VirusTotal](https://www.virustotal.com/) 看多引擎结果。只看「有无检出」不看引擎数量——1-2 家小众引擎报毒可以走误报申诉，5 家以上必须停下来查。
2. **误报申诉渠道**（被报毒后走这里，比换打包工具管用）：
   - 微软 Defender：<https://www.microsoft.com/en-us/wdsi/filesubmission>（选「软件开发者」身份提交，说明是误报）
   - 火绒：官网「服务中心／误报反馈」，或论坛 <https://bbs.huorong.cn/> 反馈区
   - 360 / 腾讯管家：各自官网的「误报申诉」入口（以官网为准，入口常变）
3. **证书采购要点**：
   - 2023-06 起 CA/B 规定代码签名私钥必须放硬件令牌 / HSM，**新证书拿不到 `.pfx` 文件**，所以 `sign.ps1` 同时支持「按指纹用已装令牌里的证书」和 `-Pfx`（后者留给旧证书 / 内部 CA）。
   - OV（组织验证）便宜，签出来是可信发布者，但 SmartScreen 信誉仍需按下载量积累。
   - EV（扩展验证）是上限最高的一档，硬件 token，价格明显更贵。
   - Azure Trusted Signing 便宜（月付），但要求组织资质且对大陆主体支持有限，落地前先问渠道。
4. **证书导入后不用改代码**：`tools\sign.ps1` 会自动在 `Cert:\CurrentUser\My` / `Cert:\LocalMachine\My` 里找带私钥的代码签名证书，找到就签。找不到只是打一行黄字警告，构建照常继续。

---

## 6. 本次已经落地的改动

| 文件 | 改动 |
|---|---|
| `tools\sign.ps1` | **新增**。统一签名入口：自动定位 `signtool.exe`（Windows SDK 里已有）、自动选择证书、`/fd sha256 /tr http://timestamp.digicert.com /td sha256` 时间戳、签完用 `Get-AuthenticodeSignature` 自检。无证书时警告并返回 `$false`，不中断构建 |
| `tools\build-nuitka.ps1` | 新增 `-NoSign`；默认在**壳 exe 进 payload 之前**签名（保证绿色包 / 安装包 / 安装后文件同一签名），安装包打完再签一次（这样报告的 SHA256 就是实际交付物的哈希） |
| `tools\build-release.ps1` | 新增 `-NoSign`；同样在 PyInstaller 壳进 payload 前签、安装包打完签 |
| `tools\build-pyinst.ps1` | **新增**。PyInstaller **standalone（目录式）** 打成与 Nuitka 绿色包同形状的对比包，输出 `build\release-pyinst\`，绝不写 `build\release` / `build\stage` / `build\pyinst` / `build\pywork`；`version_info.txt` 由 `version.json` 现场生成（不再手改 tracked 文件）；壳 exe 组装前签名 |

已验证：用一张 30 天有效期的自签证书跑通 `sign.ps1` → signtool 签名成功 → DigiCert 时间戳写入成功 → `Get-AuthenticodeSignature` 能读回签名者。自签证书**仅用于验证链路**，验证完已从证书存储删除；正式安装包仍是未签名状态（哈希没变）。

> 自签名对免杀**没有帮助**，反而更糟（不可信根）。不要拿自签包发给客户。

---

## 7. 待决策（这两条决定上限）

1. **买不买代码签名证书？** 不买，就只能靠「不发裸 exe + 稳定哈希 + 一家家申诉」打补丁；买了，OV 一年几千块，能解决绝大部分「未知发布者」类拦截。
2. **要不要装 Inno Setup？** 装了，PyInstaller 线的安装包从 40 MB 自解压变成标准安装器，同时也顺手解决 Nuitka 线「每次压 180 MB、固定 3 分钟」的开销。
3. **`frpc.exe` 怎么处理？** 现状是最大的一处行为风险（见 4.1），产品上要不要改成按需释放，需要你拍板。
