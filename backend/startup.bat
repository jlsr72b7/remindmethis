@echo off
setlocal

set "BACKEND_DIR=%~dp0"
if "%BACKEND_DIR:~-1%"=="\" set "BACKEND_DIR=%BACKEND_DIR:~0,-1%"

echo [startup] Stopping backend Node processes...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'node.exe' -and $_.CommandLine -like '*special-date-reminder\\backend*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Host ('Stopped PID ' + $_.ProcessId) } catch {} }"

echo [startup] Stopping process bound to port 4000 (if any)...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":4000" ^| findstr "LISTENING"') do (
  taskkill /PID %%P /F >nul 2>&1
)

timeout /t 1 /nobreak >nul

echo [startup] Starting backend dev server...
cd /d "%BACKEND_DIR%"
start "special-date-reminder-backend" cmd /k "cd /d ""%BACKEND_DIR%"" && npm.cmd run dev"

echo [startup] Done.
endlocal
