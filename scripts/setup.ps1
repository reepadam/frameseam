# ClipCut setup: downloads everything the app needs into this folder and creates a desktop shortcut.
# Nothing is installed system-wide. Safe to run again: it skips anything that's already there.
#
#   Double-click Setup.bat, or run:  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 [-SkipShortcut]
#
# What it downloads (into .\tools and .\node_modules):
#   - ffmpeg + ffprobe   from https://www.gyan.dev/ffmpeg/builds/ (the Windows build linked from ffmpeg.org; GPL licensed)
#   - Electron           via npm (https://www.npmjs.com/package/electron)
#   - a portable Node.js from https://nodejs.org/ (only if Node.js 22.12+ isn't already installed)
# The ffmpeg and Node.js downloads are pinned to exact versions and checked against their published SHA-256 before use.

param([switch]$SkipShortcut)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

# Pinned downloads. To update one: change the version and paste the new hash
# (gyan.dev publishes <zip>.sha256 next to each build, nodejs.org publishes SHASUMS256.txt for each release).
$FfmpegVersion = '9.0.2'
$FfmpegUrl = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-$FfmpegVersion-essentials_build.zip"
$FfmpegSha256 = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
$NodeVersion = 'v26.13.0'
$NodeUrl = "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip"
$NodeSha256 = 'dcc60d59a0746999f99064a01c020445d54d84228c691cdbf25b49ac3b59150a'

$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root 'tools'

if ($root -like '\\*') {
    Write-Host "ClipCut is on a network path ($root). Copy the folder to a local drive, for example C:\ClipCut, and run Setup.bat from there." -ForegroundColor Red
    exit 1
}

# Tags a .lnk with the AppUserModelID that src/main.js sets, so pinning the running ClipCut window to the taskbar
# gives a pin that launches ClipCut (without this, Windows pins plain electron.exe and the pin opens Electron's demo app).
function Set-ShortcutAppId([string]$lnk, [string]$appId) {
    if (-not ('ClipCut.ShortcutAppId' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
namespace ClipCut {
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PropertyKey { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    public struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr ptr; }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    public class ShellLinkObject { }
    public static class ShortcutAppId {
        public static void Set(string path, string appId) {
            object link = new ShellLinkObject();
            ((IPersistFile)link).Load(path, 2);
            IPropertyStore store = (IPropertyStore)link;
            PropertyKey key = new PropertyKey();
            key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
            key.pid = 5;
            PropVariant v = new PropVariant();
            v.vt = 31;
            v.ptr = Marshal.StringToCoTaskMemUni(appId);
            try { store.SetValue(ref key, ref v); store.Commit(); }
            finally { Marshal.FreeCoTaskMem(v.ptr); }
            ((IPersistFile)link).Save(path, true);
        }
    }
}
'@
    }
    [ClipCut.ShortcutAppId]::Set($lnk, $appId)
}

# Downloads a zip, checks its SHA-256 against the pinned value, unpacks it and returns the folder.
function Get-Zip($url, $sha256) {
    $zip = Join-Path $env:TEMP ("clipcut-setup-" + [guid]::NewGuid() + ".zip")
    $dir = "$zip-x"
    try {
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
        if ($actual -ne $sha256) { throw "the file's SHA-256 ($actual) is not the expected $sha256; the download is corrupt or the file has changed" }
        Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
        return $dir
    } catch {
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        throw "Download of $url failed: $($_.Exception.Message)"
    } finally {
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    }
}
# (-LiteralPath everywhere below: a folder name with [brackets] would otherwise be read as a wildcard pattern.)

try {
    New-Item -ItemType Directory -Force $tools | Out-Null

    # 1. Node.js: a portable copy in tools\node if we already downloaded one, else the one on PATH, else download it.
    $nodeDir = Join-Path $tools 'node'
    $nodeExe = $null
    $npm = $null
    if (Test-Path -LiteralPath "$nodeDir\node.exe") {
        $nodeExe = "$nodeDir\node.exe"
        $npm = "$nodeDir\npm.cmd"
    } elseif (Get-Command node.exe -ErrorAction SilentlyContinue) {
        $exe = (Get-Command node.exe).Source
        $ver = [version]'0.0'
        try { $ver = [version]((& $exe -v) -replace '^v', '') } catch {}
        $npmBeside = Join-Path (Split-Path $exe) 'npm.cmd'
        $npmOnPath = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if ($ver -lt [version]'22.12') {   # Electron 44's npm package needs Node 22.12 or newer
            Write-Host "The Node.js on this PC ($(& $exe -v)) is too old for Electron, so a portable current one will be downloaded instead."
        } elseif (Test-Path -LiteralPath $npmBeside) {
            $nodeExe = $exe
            $npm = $npmBeside
        } elseif ($npmOnPath) {
            $nodeExe = $exe
            $npm = $npmOnPath.Source
        } else {
            Write-Host "The Node.js on this PC ($exe) has no npm with it, so a portable copy will be downloaded instead."
        }
    }
    if (-not $nodeExe) {
        Write-Host "Downloading portable Node.js $NodeVersion (about 40 MB)..."
        $x = Get-Zip $NodeUrl $NodeSha256
        if (Test-Path -LiteralPath $nodeDir) { Remove-Item -LiteralPath $nodeDir -Recurse -Force }   # leftovers of an interrupted earlier run
        Move-Item -LiteralPath (Get-ChildItem -LiteralPath $x -Directory | Select-Object -First 1).FullName -Destination $nodeDir
        Remove-Item -LiteralPath $x -Recurse -Force
        $nodeExe = "$nodeDir\node.exe"
        $npm = "$nodeDir\npm.cmd"
    }
    Write-Host "Using Node.js $(& $nodeExe -v)  ($nodeExe)"

    # 2. ffmpeg + ffprobe (the video engine)
    $ffDir = Join-Path $tools 'ffmpeg'
    if (-not (Test-Path -LiteralPath "$ffDir\ffmpeg.exe") -or -not (Test-Path -LiteralPath "$ffDir\ffprobe.exe")) {
        Write-Host "Downloading ffmpeg $FfmpegVersion (about 110 MB)..."
        $x = Get-Zip $FfmpegUrl $FfmpegSha256
        $exe = Get-ChildItem -LiteralPath $x -Recurse -Filter ffmpeg.exe | Select-Object -First 1
        if (-not $exe) { throw 'The ffmpeg download did not contain ffmpeg.exe.' }
        New-Item -ItemType Directory -Force $ffDir | Out-Null
        Move-Item -LiteralPath (Join-Path $exe.DirectoryName 'ffmpeg.exe') -Destination $ffDir -Force
        Move-Item -LiteralPath (Join-Path $exe.DirectoryName 'ffprobe.exe') -Destination $ffDir -Force
        Remove-Item -LiteralPath $x -Recurse -Force
    }
    Write-Host "Using $((& "$ffDir\ffmpeg.exe" -hide_banner -version | Select-Object -First 1))"

    # 3. Electron (the app runtime), via npm. This runs every time: it is a quick no-op when node_modules already
    #    matches the lock file, and it picks up a changed Electron version after an update of ClipCut.
    $electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path -LiteralPath $electronExe)) { Write-Host 'Installing Electron (about 160 MB)...' }
    Push-Location -LiteralPath $root
    try {
        $env:PATH = "$(Split-Path $nodeExe);$env:PATH"
        $env:electron_config_cache = Join-Path $tools 'electron-cache'   # npm's copy of the Electron download stays in this folder too
        & $npm install --no-fund --no-audit
        if ($LASTEXITCODE) { throw "npm install failed with exit code $LASTEXITCODE" }
        # The electron package no longer fetches its binary during npm install; scripts/postinstall.js does that, and this is the safety net.
        if (-not (Test-Path -LiteralPath $electronExe)) { & $nodeExe (Join-Path $root 'node_modules\electron\install.js') }
        if (-not (Test-Path -LiteralPath $electronExe)) { throw 'Electron did not download correctly. Delete the node_modules folder and run Setup.bat again.' }
    } finally { Pop-Location }

    # 4. Shortcuts (desktop + this folder)
    if (-not $SkipShortcut) {
        $ws = New-Object -ComObject WScript.Shell
        foreach ($lnk in @((Join-Path $root 'ClipCut.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'ClipCut.lnk'))) {
            $s = $ws.CreateShortcut($lnk)
            $s.TargetPath = $electronExe
            $s.Arguments = "`"$root`""
            $s.WorkingDirectory = $root
            $s.IconLocation = (Join-Path $root 'src\renderer\icon.ico') + ',0'
            $s.Description = 'ClipCut video editor'
            $s.Save()
            try { Set-ShortcutAppId $lnk 'ClipCut.VideoEditor' }
            catch { Write-Host "  (could not tag $lnk for taskbar pinning: $($_.Exception.Message))" -ForegroundColor DarkGray }
        }
        Write-Host 'Created a ClipCut shortcut on your desktop (and one in this folder).'
    }

    Write-Host ''
    Write-Host 'ClipCut is ready.' -ForegroundColor Green
} catch {
    Write-Host ''
    Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Check your internet connection and run Setup.bat again. If it keeps failing, open an issue at https://github.com/reepadam/clipcut/issues' -ForegroundColor Yellow
    exit 1
}
