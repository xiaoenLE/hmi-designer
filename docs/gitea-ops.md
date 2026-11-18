# 操作 Gitea：仓库、发布、乱码处理（给 AI 和维护者）

> **先读这三条铁律**（AI 也一样）：
> 1. **不要自己提交/推送**：`git commit` / `git push` / 任何往 Gitea 写的 API 调用，**只有用户明确说"保存/提交/推送/发布"时才做**。
> 2. **不要自己打包发版**：`tools/build-release.ps1`（尤其 `-Publish`）**只有用户说"打包/发版"时才跑**。
> 3. **不要动现场数据**：`%ProgramData%\HMI-Designer\`（工程/变量表/PLC 配置/报警/口令）**永远不碰**；
>    仓库里的 `server/data/` 也不要随手提交（见文末"那些坑"）。
>
> 这三条是用户在 2026-10-04 明确要求的工作规则，改动前先问。

---

## 1. 服务器与仓库

| 项 | 值 |
|---|---|
| Gitea 地址 | `http://124.221.183.24:3000` |
| 账号 | `xiaoen`（管理员） |
| 密码 | **不写进任何文件**。用环境变量 `HMI_GIT_USER` / `HMI_GIT_PASS` 传，或直接问用户 |
| API 根 | `http://124.221.183.24:3000/api/v1` |
| 认证头 | `Authorization: Basic base64(user:pass)` |

**仓库分工（就两个）**：

| 仓库 | 里面是什么 | 页面 |
|---|---|---|
| `xiaoen/hmi-designer` | **软件源码 + 文档 + 发布物**（安装包/代码包作为 tag 附件，清单在 `release/`） | <http://124.221.183.24:3000/xiaoen/hmi-designer> |
| `xiaoen/hmi-mcp` | **MCP 服务**（给 AI 一个端口读写当前打开的工程） | <http://124.221.183.24:3000/xiaoen/hmi-mcp> |

> 早期还有一个 `xiaoen/hmi-designer-release`（专门放包），**已删除并合并进 `hmi-designer`**（2026-10-04）。
> 老机器（≤1.0.4）的更新源还指在那儿 → 那些机器需要手动装一次新版安装包才会转到新地址。

---

## 2. 常用操作（照抄即可）

### 2.1 看状态 / 拉取 / 提交 / 推送

```powershell
cd C:\Users\Administrator\Desktop\hmi\hmi-designer
git status --short                     # 谁改了什么
git fetch origin                       # 看远端有没有新东西
git log --oneline -5

# 提交（用户说了"保存"才做）
git add -A
git commit -F "$env:TEMP\msg.txt"      # 中文提交信息走文件，别在命令行里拼（见第 3 节）

# 推送：一次性带凭据（不写进 .git/config）
$u = "http://xiaoen:$env:HMI_GIT_PASS@124.221.183.24:3000/xiaoen/hmi-designer.git"
git -c credential.helper= push $u master
```

### 2.2 ⚠ 推送被拒是常态：先 rebase 再推

发布脚本会用 **API 直接提交** `release/version.json`、`release/README.md`，
这些提交**只在远端**，本地没有 → 直接 `git push` 会被拒：

```
! [rejected]  master -> master (fetch first)
```

正确处理（**不要** `push -f`）：

```powershell
git fetch origin
git -c user.email=xiaoen@local -c user.name=xiaoen pull --rebase origin master
git -c credential.helper= push $u master
```

### 2.3 用 API 提交一个文件（contents API）

```powershell
$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$env:HMI_GIT_USER`:$env:HMI_GIT_PASS"))
$hdr = @{ Authorization = "Basic $b64" }
$api = 'http://124.221.183.24:3000/api/v1/repos/xiaoen/hmi-designer'

$path  = 'release/version.json'                  # 仓库内路径（不存在会自动新建）
$bytes = [IO.File]::ReadAllBytes('build\release\version.json')
$body  = @{ content = [Convert]::ToBase64String($bytes); message = 'release: V1.0.7 manifest' }
try {                                            # 文件已存在时必须带 sha 才能更新
  $cur  = Invoke-RestMethod "$api/contents/$path" -Headers $hdr -TimeoutSec 20
  $body = @{ content = $body.content; message = $body.message; sha = $cur.sha }
} catch { }

# ★ 必须发 UTF-8 字节，别发字符串（见第 3 节）
$json = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 6))
Invoke-RestMethod -Uri "$api/contents/$path" -Method Put -Headers $hdr `
  -ContentType 'application/json; charset=utf-8' -Body $json -TimeoutSec 60
```

### 2.4 发布 Release + 传附件

```powershell
# 建 / 更新 release（说明的 PATCH 很重要：修历史发布页的乱码就靠它）
$obj = @{ tag_name='v1.0.7'; name='WebHMI Designer 1.0.7'; body=$notes; draft=$false; target_commitish='master' }
$json = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Depth 6))
Invoke-RestMethod -Uri "$api/releases" -Method Post -Headers $hdr -ContentType 'application/json; charset=utf-8' -Body $json
Invoke-RestMethod -Uri "$api/releases/<release_id>" -Method Patch -Headers $hdr -ContentType 'application/json; charset=utf-8' -Body $json

# 传附件：用 curl.exe（PS 5.1 没有 -Form！）
curl.exe -s -S -u "$env:HMI_GIT_USER`:$env:HMI_GIT_PASS" `
  -F "attachment=@build\release\WebHMI-Designer-Setup-1.0.7.exe" `
  "http://124.221.183.24:3000/api/v1/repos/xiaoen/hmi-designer/releases/<release_id>/assets?name=WebHMI-Designer-Setup-1.0.7.exe"
```

**下载地址规律**（客户端就是按这个拉的）：

```
代码/安装包：<repoBase>/releases/download/<tag>/<文件名>
源码/文档  ：<repoBase>/raw/branch/master/<仓库内路径>
更新清单   ：http://124.221.183.24:3000/xiaoen/hmi-designer/raw/branch/master/release/version.json
```

### 2.5 ⚠ 同名附件会并存，而且"下载到的是第一个"

Gitea **不会**因为名字相同就覆盖：同一个 release 下可以有 3 个都叫 `x.zip` 的附件，
而 `.../releases/download/<tag>/x.zip` 解析到的是**最先上传的那个** ——
于是"发了新版却下到旧包"，客户端 sha256 校验当场对不上（我们真踩过）。

规矩：
1. 传之前**先删同名旧附件**（注意 URL 要带 release id）：
   `DELETE /api/v1/repos/{owner}/{repo}/releases/{release_id}/assets/{asset_id}`
2. 传完**下载回来比对 sha256**，一致才算发布成功（`tools/build-release.ps1` 已经这么做了）

---

## 3. 乱码问题（重点：本仓库踩过的全部四类）

### 3.1 快速判断是哪一类

| 你看到的 | 是哪一类 | 根因 |
|---|---|---|
| Gitea 上的**发布说明 / commit message / 仓库描述**变成 `?????` | **API 编码** | PS 5.1 用 ANSI 编码字符串 body（第 3.2 节） |
| `.ps1` 报语法错，错误里中文是 `鎵撳３锛?` 这种 | **脚本文件编码** | 无 BOM 的 UTF-8 脚本被 PS 5.1 当 GBK 读（第 3.3 节） |
| `.bat` 里中文乱码 / cmd 解析错 | **bat 编码** | cmd.exe 按 ANSI 读 bat |
| 更新日志里中文断成 `完成：现在跑的是 V1.0.4 ====` 这种半截 | **日志双写** | 两个进程写同一个文件 + 子进程 stdout 按 GBK（第 3.4 节） |
| `version.json` 读不出来（明明有文件） | **BOM** | 记事本存的 UTF-8 带 BOM（第 3.5 节） |

> 记忆法：`?` = 编码转换时**丢字**（不可逆，只能重发）；`锟斤拷` / `鈥` / `鎵` = UTF-8 被**当 GBK 显示**（原文件可能是好的）。

### 3.2 API 编码：PS 5.1 的 `-Body` 是 ANSI（最坑的一个）

**现象**：文件内容没问题（走 base64），但 **commit message、仓库描述、Release 说明**里的中文变成 `?????`。
v1.0.7 的发布页就这么烂过一次。

**错误写法**：

```powershell
$body = @{ message = '中文提交信息' } | ConvertTo-Json
Invoke-RestMethod -Uri $u -Method Post -Headers $hdr -Body $body      # ✗ 中文变 ?
```

**正确写法**（把 JSON 转成 UTF-8 **字节**再发）：

```powershell
function Send-GiteaJson($uri, $method, $obj) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Depth 6))
  return Invoke-RestMethod -Uri $uri -Method $method -Headers $hdr `
    -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 180
}
```

**已修好的位置**（新代码别再退回字符串 body）：`tools/build-release.ps1` 里的
`Send-GiteaJson` / `Push-GiteaFile` / version.json 提交 / **Release 创建与 PATCH**。

### 3.3 脚本文件编码：PS 5.1 按 ANSI 读 `.ps1`

这台机器的 shell 是 **Windows PowerShell 5.1**（`$PSVersionTable.PSVersion` = 5.1，PSEdition=Desktop），
**不是 PowerShell 7**。它读 .ps1 时：有 BOM 按 UTF-8，**没 BOM 按 ANSI(GBK)**。

所以本仓库的约定是：

* `*.bat` / `*.ps1` **一律只写 ASCII**（英文注释）—— 仓库里 `start_server.bat` 开头就写着
  "ASCII only on purpose"，就是这个原因；
* 必须写中文的 .ps1 → **存成 UTF-8 with BOM**：
  ```powershell
  [IO.File]::WriteAllText($p, $text, (New-Object Text.UTF8Encoding($true)))    # $true = 带 BOM
  ```
* **读/写文件不要用 `Get-Content`/`Set-Content` 默认编码**，显式指定或用 .NET：
  ```powershell
  $t = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding($false)))      # 不带 BOM
  ```
* 改中文文本优先**用 Python**（`Path.read_text(encoding="utf-8")` / `write_text(..., encoding="utf-8")`），
  没有编码歧义 —— 本次改名、修前缀都是用 Python 做的。

### 3.4 日志编码：两个写者争一个文件（更新日志"看不懂"）

**现象**：更新日志里中文被截断、行与行互相穿插。

**根因**：更新时后端把助手的 stdout 重定向到 `update-<日期>.log`，
而助手自己也往**同一个文件**写日志；两边编码还不一样（子进程 stdout 默认按系统区域 = GBK）。

**修法（已在代码里）**：
* 日志目录跟 `HMI_LOG_DIR` 走（打包后指向 `%ProgramData%\HMI-Designer\logs`，安装目录写不进去）；
* 子进程输出写**另一个文件**（`update-<日期>-child.log` / `-app.log`），不跟谁共用一个；
* 起子进程时显式 `PYTHONIOENCODING=utf-8`。

### 3.5 BOM：`version.json` 读不出来

记事本/Excel 存 UTF-8 会带 BOM。后端读版本清单、客户端读清单都用 **`utf-8-sig`**
（Python）或 `decode('utf-8-sig')`，否则"明明有文件却说没查到"。

### 3.6 提交后一定要"读回来"复核

不管用什么方式写的，**发完都读一遍**：

```powershell
# 文件内容
(Invoke-WebRequest "$repoBase/raw/branch/master/release/version.json" -UseBasicParsing).Content
# 发布说明 / 提交信息（用 API 看真实存了什么）
(Invoke-RestMethod "$api/releases/tags/v1.0.7" -Headers $hdr).body
(Invoke-RestMethod "$api/commits?limit=3" -Headers $hdr) | ForEach-Object { $_.commit.message }
```

发现 `?????` 的补救：`?????` 是**不可逆**的（信息已丢），只能**重新提交/PATCH 一遍正确内容**
（文件重传、Release 用 PATCH 改 body；提交历史里那条改不了，只能靠新的提交说明覆盖认知）。

---

## 4. 更新链路（为什么清单在 `release/` 而不是仓库根）

```
客户端（WebHMI_设计器）
  └─ GET  .../hmi-designer/raw/branch/master/release/version.json     ← 清单（版本/说明/包地址/sha256）
       └─ 发现新版 → GET .../releases/download/v<ver>/WebHMI-Designer-<ver>-app.zip
            └─ 校验 sha256 → 只覆盖 app\（跳过 server/data）→ 重启（起不来自动回滚）
```

* **仓库根的 `version.json` 是人手改的"版本源"**（version/date/notes），发版时改它；
* **`release/version.json` 是构建脚本生成的发布清单**（多出 `app_zip.url/sha256`、`min_launcher`）；
* 两个文件**必须分开**：同路径的话，开发机一次 `git push` 就会把清单里的 sha256 冲掉，
  **所有客户端的校验都会失败**（这是设计约束，不是随手放的）。
* 老机器（代码里 baked 了旧地址）看不到新版本 —— 需要手动装一次新版安装包；
  临时验证可以让它带环境变量启动：
  ```bat
  set HMI_UPDATE_URL=http://124.221.183.24:3000/xiaoen/hmi-designer/raw/branch/master/release/version.json
  "C:\Program Files\WebHMI-Designer\WebHMIDesigner.exe"
  ```

---

## 5. 那些坑（一句话版）

* **别把密码写进仓库/脚本/文档** —— 用环境变量，或问用户。
* **别 `push -f`**：远端有脚本用 API 提交的 `release/*`，先 `pull --rebase`。
* **别在 `server/data/` 里提交现场数据**：那是运行数据；仓库里只留样例工程（"工程演示"）。
* **数据目录名永远别改**：`%ProgramData%\HMI-Designer`（改名 = 现场工程"消失"）。
* **Gitea 是 http 明文**：传输不加密，别在里面放不该放的东西；建议改 https/换密码。
* **同名附件并存**：先删旧的、传完比对 sha256。
* **改完中文，读回来复核**：本地对不等于 Gitea 上对。
