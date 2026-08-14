@echo off
cd /d "%~dp0"
echo ============================================
echo  CRYVOLMON - Frontend Dev Server
echo  Council page: http://localhost:5173/council
echo  (Express API forwarded to :5000 if running)
echo ============================================
echo.
call "%~dp0node_modules\.bin\vite.cmd" --port 5173 --host
pause
