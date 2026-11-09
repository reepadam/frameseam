@echo off
rem Double-click to set up ClipCut: downloads ffmpeg, Electron and (if needed) a portable Node.js into this folder, then adds a desktop shortcut.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*
echo.
pause
