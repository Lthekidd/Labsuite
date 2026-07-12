@echo off
title LabSuite Launcher
echo ===================================================
echo   LabSuite - Encrypted Backup Client Launcher
echo ===================================================
echo.
echo Launching local development environment...
echo The app UI window should appear shortly.
echo.
echo [To stop, close this console window or press Ctrl+C]
echo.

cd /d "%~dp0"
call npm.cmd run dev

if errorlevel 1 (
  echo.
  echo LabSuite failed to start. Review the error above.
  pause
)
