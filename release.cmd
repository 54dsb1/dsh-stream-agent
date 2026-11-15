@echo off
chcp 65001 >nul
cd /d "%~dp0.."
title dsh-stream-agent - release

echo ============================================================
echo   dsh-stream-agent   one-click release
echo   build + test  ->  git commit/tag/push  ->  GitHub Release  ->  npm
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js not found on PATH.
  pause
  exit /b 1
)

echo Version bump:
echo   [1] patch  ^(bugfix, default^)
echo   [2] minor  ^(new feature^)
echo   [3] major  ^(breaking^)
echo   [4] keep   ^(use the version already in package.json^)
echo.
set "PICK=1"
set /p PICK="Choose [1-4, Enter=1]: "
set "BUMP=--patch"
if "%PICK%"=="2" set "BUMP=--minor"
if "%PICK%"=="3" set "BUMP=--major"
if "%PICK%"=="4" set "BUMP=--keep"

echo.
echo This will commit, push to GitHub and publish to npm. Ctrl+C to abort.
set "GO="
set /p GO="Continue? [y/N]: "
if /i not "%GO%"=="y" (
  echo Aborted.
  pause
  exit /b 0
)

echo.
node scripts\release.mjs %BUMP%
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" (
  echo ============================================================
  echo   RELEASE FAILED  ^(exit %CODE%^) - see the message above.
  echo ============================================================
) else (
  echo ============================================================
  echo   DONE.
  echo ============================================================
)
pause
exit /b %CODE%
