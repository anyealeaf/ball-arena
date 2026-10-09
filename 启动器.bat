@echo off
chcp 65001 >nul
title 小球角斗场 - 本地启动器
cd /d "%~dp0"

echo.
echo   ==========================================
echo     小球角斗场  ·  本地启动器
echo   ==========================================
echo.
echo    进入游戏 / 素材编辑器，都在浏览器里点按钮。
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

rem PowerShell 用来"等端口 + 开浏览器"（优先用系统绝对路径，PATH 被改坏也能跑）
set PS_EXE=powershell
if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe

rem 浏览器要打开的页面（服务器顺延到 5174/5175 时，等待脚本会自己找到）
set LAUNCHER=launcher.html

rem ---------------------------------------------------------------------------
rem  等服务器真的起来，再打开启动器页面
rem
rem  为什么不写死"3 秒后打开"：服务器要读文件、抢端口，慢机器上 3 秒并不够，
rem  于是会出现"第一次点是空白、刷新一下才好"的假故障（旧版就是这么写的）。
rem  这里改成**轮询探测**：某个端口能真的取到 launcher.html 才开浏览器，
rem  并且按 5173..5180 的顺序找 —— 正好覆盖 tools/serve.mjs 的端口顺延。
rem
rem  ⚠ 两个必须记住的坑（都是实测踩出来的）：
rem    1. 本文件必须是 **CRLF 行尾**。只用 LF 的话 cmd.exe 会把带括号的
rem       代码块解析错乱，出现"'面（服务器顺延到' 不是内部或外部命令"这类怪错。
rem    2. 本文件是 **UTF-8 无 BOM**，并且第一行之后马上 chcp 65001；
rem       中文才不会变成乱码（这两条由 tests/diag/launcher.mjs 守着）。
rem ---------------------------------------------------------------------------
set WAITER=%PS_EXE% -NoProfile -WindowStyle Hidden -Command "$ok=$false; for($n=0; $n -lt 60 -and -not $ok; $n++){ for($p=5173; $p -le 5180; $p++){ try{ $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 ('http://127.0.0.1:'+$p+'/%LAUNCHER%'); if($r.StatusCode -eq 200){ Start-Process ('http://localhost:'+$p+'/%LAUNCHER%'); $ok=$true; break } } catch {} } if(-not $ok){ Start-Sleep -Milliseconds 500 } }"

rem 1) 服务器已经在跑？直接打开启动器页面，不再起第二个
netstat -ano | findstr /r /c:"TCP.*:51[7-9][0-9] .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo   检测到本地服务器已经在运行，直接打开启动器页面…
  start "" /b %WAITER%
  timeout /t 3 >nul
  echo.
  echo   ------------------------------------------
  echo    启动器页面：http://localhost:5173/%LAUNCHER%
  echo    （5173 被占用过的话，看服务器那个窗口打印的地址）
  echo.
  echo    注意：本窗口不是服务器，关掉它不会停止预览。
  echo   ------------------------------------------
  echo.
  pause
  exit /b 0
)

rem 2) 没在跑：先派出"等端口 + 开浏览器"的后台脚本，再启动服务器
echo   正在启动本地服务器…
echo.
start "" /b %WAITER%

echo   ------------------------------------------
echo    浏览器会自动打开启动器页面：
echo      http://localhost:5173/%LAUNCHER%
echo    若没自动打开，请手动在浏览器输入上面的地址。
echo.
echo    启动器里有「进入游戏」和「素材编辑器」两个按钮。
echo.
echo    关闭本窗口 = 停止服务器。
echo   ------------------------------------------
echo.

"%NODE_EXE%" tools\serve.mjs

echo.
echo   服务器已停止。
pause
