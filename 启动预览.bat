@echo off
chcp 65001 >nul
title 小球角斗场 - 本地预览
cd /d "%~dp0"

echo.
echo   ==========================================
echo     小球角斗场  ·  本地预览
echo   ==========================================
echo.

set NODE_EXE=node
where node >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set NODE_EXE=C:\Program Files\nodejs\node.exe
  ) else (
    echo   [错误] 找不到 Node.js，请先安装：https://nodejs.org
    echo.
    pause
    exit /b 1
  )
)

rem 1) 先看服务器是不是已经在跑了
netstat -ano | findstr /r /c:"TCP.*:5173 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo   检测到预览已经在运行（端口 5173），直接打开浏览器…
  start "" http://localhost:5173
  echo.
  echo   如果页面打不开，请先关掉旧的预览窗口再重新运行本文件。
  echo.
  pause
  exit /b 0
)

rem 2) 没在跑，就启动服务器，并在 3 秒后打开浏览器
echo   正在启动服务器…
echo.
start "" /b cmd /c "timeout /t 3 >nul & start http://localhost:5173"

echo   ------------------------------------------
echo    浏览器会自动打开：http://localhost:5173
echo    若没自动打开，请手动在浏览器输入上面的地址。
echo.
echo    关闭本窗口 = 停止预览。
echo   ------------------------------------------
echo.

"%NODE_EXE%" tools\serve.mjs

echo.
echo   预览已停止。
pause
