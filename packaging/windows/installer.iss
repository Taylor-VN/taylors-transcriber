; Inno Setup script for Taylor's Transcriber.
;
; Deliberately a per-user install under %LOCALAPPDATA%\Programs: it needs no
; administrator prompt, which matters on locked-down editing machines, and it
; puts the app somewhere the user can always write. The app's environment still
; lives separately under %LOCALAPPDATA%\TaylorsTranscriber, so installing an
; update over the top keeps the speech runtimes the user added from Settings.
;
; Built by packaging/windows/build_installer.ps1, which passes AppVersion in.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

#define AppName "Taylor's Transcriber"
#define AppId "{{9F2C6B84-4E5D-4A1E-9C7B-6D3A2F81B0E4}"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Taylor
DefaultDirName={localappdata}\Programs\TaylorsTranscriber
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=no
PrivilegesRequired=lowest
OutputDir=..\..\dist
OutputBaseFilename=TaylorsTranscriber-{#AppVersion}-setup
SetupIconFile=..\..\build\icons\icon.ico
UninstallDisplayIcon={app}\icon.ico
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern

[Files]
Source: "..\..\build\payload\python\*"; DestDir: "{app}\python"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\..\build\payload\app\*";    DestDir: "{app}\app";    Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\..\build\icons\icon.ico";   DestDir: "{app}";        Flags: ignoreversion

[Icons]
; TaylorsTranscriber.exe is a renamed copy of pythonw.exe, so the process shows
; a recognisable name in Task Manager and starts with no console window. It has
; to stay inside python\ — the interpreter locates its own standard library
; relative to the executable, so moving it up a level would break startup.
Name: "{group}\{#AppName}"; Filename: "{app}\python\TaylorsTranscriber.exe"; \
  Parameters: """{app}\app\app.py"""; WorkingDir: "{app}\app"; \
  IconFilename: "{app}\icon.ico"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\python\TaylorsTranscriber.exe"; \
  Parameters: """{app}\app\app.py"""; WorkingDir: "{app}\app"; \
  IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; \
  GroupDescription: "Additional shortcuts:"

[Run]
Filename: "{app}\python\TaylorsTranscriber.exe"; Parameters: """{app}\app\app.py"""; \
  WorkingDir: "{app}\app"; Description: "Launch {#AppName}"; \
  Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Bytecode caches and the marker are written after install, so the uninstaller
; would otherwise leave the directory behind.
Type: filesandordirs; Name: "{app}\app\__pycache__"
Type: filesandordirs; Name: "{app}\python"

[Messages]
; The environment survives uninstall on purpose — a user reinstalling should not
; have to download several gigabytes of speech runtimes again. Say so, rather
; than leaving an unexplained folder behind.
ConfirmUninstall=Remove %1?%n%nThe downloaded speech models and the app's Python environment in %LOCALAPPDATA%\TaylorsTranscriber are kept, so a reinstall does not have to fetch them again. Delete that folder by hand to reclaim the space.
