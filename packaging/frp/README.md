# packaging/frp — 随安装包一起装出去的 FRP 客户端

这个目录里放的是 **[frp](https://github.com/fatedier/frp) 的客户端 `frpc.exe`**（自带的，不是我们写的）。

## 为什么放这儿

现场要「**在外面用手机看画面**」：HMI 跑在车间局域网里，用一个 frps 服务器把它的端口映射出去。
以前是手工改 `frpc.toml` + 双击 `start_frpc.bat`；现在做进软件里了：

* 界面：编辑器 **工程 ▾ → FRP 内网穿透…**（`js/editor/frpSettings.js`）
* 后端：`server/core/frp.py`（生成配置、拉进程、看门狗自动重拉、状态给界面）
* 接口：`/api/frp`（GET 看现状 / POST 保存并起停）

## 放在哪一层（**壳**，不是代码包）

`frpc.exe` 有 16 MB，而「立即更新」的代码包只有 3 MB —— 把它放进代码包的话，
**每次改个界面都要重下这 17 MB**。所以它跟**壳**（安装包）走：

```
<安装目录>\
├── WebHMIDesigner.exe
├── _internal\
├── frp\frpc.exe        ← 这个目录（打包时从 packaging\frp\ 拷进来）
├── logs\
└── app\                ← 日常更新只换这一层（里面没有 frpc.exe）
```

运行时 `server/core/frp.py` 的 `find_frpc()` 按这个顺序找：
① 环境变量 `HMI_FRPC` → ② `<安装目录>\frp\frpc.exe` → ③ 程序目录下的 `frp\frpc.exe` /
`FRP\frpc.exe` / `packaging\frp\frpc.exe`（源码方式跑）→ ④ PATH 里的 `frpc`。
找不到**不报错**：界面里会说清"没找到 frpc.exe、该放到哪儿"，别的功能一概不受影响。

## 版本与许可

* 当前：**frp v0.71.0**（`frpc.exe --version` 可以自己确认；换版本就覆盖这个文件，
  顺手把下面这行的版本号改掉）
* 来源：<https://github.com/fatedier/frp/releases>（Windows amd64 的 `frp_<ver>_windows_amd64.zip` 里的 `frpc.exe`）
* 许可：**Apache-2.0**（见同目录的 `LICENSE`，随安装包一起装出去；frp 的版权归 fatedier 及贡献者）
