; WebHMIDesigner.iss — 安装包脚本（Inno Setup 6）
;
; 要点（改之前先读）：
;  1. **安装路径可以选**：DisableDirPage=no + PrivilegesRequiredOverridesAllowed=dialog
;     （选"仅为我安装"时不用管理员，装到用户目录）
;  2. **现场数据不在安装目录里**：工程/变量表/配置在 %ProgramData%\WebHMI-Designer\
;     安装包**只创建目录并给 Users 写权限**，从不打包也从不删除它 —— 这就是
;     "更新/重装/卸载都不会删掉原来的配置和工程"（[Dirs] 上带 uninsneveruninstall）
;  3. 装的是"壳 + app"两层：{app}\WebHMIDesigner.exe(+_internal) 是壳，{app}\app\ 是业务代码。
;     日常更新只换 {app}\app\ 里的文件（不改安装包、不弹 UAC）
;  4. 升级安装：CloseApplications=yes 会先让正在跑的窗口退出（不然 exe 被锁住替换不了）
;
; 编译（tools/build-release.ps1 会代劳）：
;   ISCC.exe /DAppVersion=1.0.4 /DStage=<stage目录> /O<输出目录> packaging/WebHMIDesigner.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Stage
  #define Stage "..\build\stage"
#endif
#ifndef OutputDir
  #define OutputDir "..\build\release"
#endif

#define AppName "WebHMI_设计器"
#define AppPublisher "xiaoen"
#define AppUrl "http://124.221.183.24:3000/xiaoen/hmi-designer"
; AppId 必须固定：升级安装要认成"同一个软件"，而不是装出第二份
#define AppId "{{7E3C1B54-6C0B-4E3E-9F5B-2D6A7C4E1A21}"

[Setup]
; 安装器自己的图标 + 装的程序/快捷方式的图标（都取自同一个 hmi.ico）
SetupIconFile=..\packaging\hmi.ico
UninstallDisplayIcon={app}\WebHMIDesigner.exe
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}
DefaultDirName={autopf}\WebHMI-Designer
DefaultGroupName=WebHMI_设计器
; ★ 让用户能自己选安装路径
DisableDirPage=no
DisableProgramGroupPage=yes
; ★ 允许"仅为我安装"（不需要管理员，装到用户目录）
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
; 升级安装时先关掉正在跑的程序（否则 exe 被占用，替换会失败）
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
OutputDir={#OutputDir}
OutputBaseFilename=WebHMI-Designer-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppName} {#AppVersion}
; 卸载时**只删自己装的文件**（不写 UninstallDelete={app}）——
; {app}\app 下面可能留着现场自己放的东西，宁可留一点垃圾，也不能误删

[Languages]
Name: "chinese"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式:"; Flags: checkedonce

[Files]
; ① 壳：exe + _internal（运行时/DLL）。这些很少变，日常更新不碰它们
Source: "{#Stage}\WebHMIDesigner\*"; DestDir: "{app}"; \
  Flags: ignoreversion recursesubdirs createallsubdirs
; ② 业务代码：app\（日常更新只换这一层）
;    ⚠ 明确排除任何 data/日志/字节码缓存 —— 安装包里不该有现场数据，也永远不覆盖它
Source: "{#Stage}\app\*"; DestDir: "{app}\app"; \
  Excludes: "\server\data\*,__pycache__\*,*.pyc,*.log"; \
  Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
; ★ 现场数据目录（安装目录之外）：建好并给普通用户写权限，
;   并标 uninsneveruninstall —— **卸载也不删**（配置和工程永远留着）
Name: "{commonappdata}\WebHMI-Designer"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{commonappdata}\WebHMI-Designer\data"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{commonappdata}\WebHMI-Designer\logs"; Permissions: users-modify; Flags: uninsneveruninstall

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\WebHMIDesigner.exe"
Name: "{group}\卸载 {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\WebHMIDesigner.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\WebHMIDesigner.exe"; Description: "立即启动 {#AppName}"; \
  Flags: nowait postinstall skipifsilent

[Code]
{ WebView2 运行时检查：没有它窗口是空白的。Win10/11 自带的 Edge 一般都有，
  这里只做"发现没有就提示怎么办"，不偷偷联网装东西 }
function WebView2Installed(): Boolean;
var
  v: String;
begin
  Result :=
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) or
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) or
    RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v);
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not WebView2Installed() then
    MsgBox('没有检测到 Microsoft Edge WebView2 运行时，程序窗口可能是空白。' + #13#10 + #13#10 +
           'Windows 10/11 装了 Edge 一般自带；若确实没有，请安装 "Evergreen Standalone Installer"：' + #13#10 +
           'https://developer.microsoft.com/microsoft-edge/webview2/' + #13#10 + #13#10 +
           '（先继续安装也可以，装完再补 WebView2 即可）', mbInformation, MB_OK);
end;
