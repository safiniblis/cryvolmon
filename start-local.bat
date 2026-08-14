@echo off
cd /d "%~dp0"
echo ============================================
echo  CRYVOLMON - Full Backend Server
echo  Council page: http://localhost:5000/council
echo ============================================
if "%DATABASE_URL%"=="" (
  echo ERROR: DATABASE_URL is not set.
  echo Set it to your local PostgreSQL or Google Cloud SQL connection string first.
  echo Example: set DATABASE_URL=postgresql://postgres:password@localhost:5432/heliumdb
  pause
  exit /b 1
)
set "PORT=5000"
set "NODE_ENV=production"
echo Starting Express server...
echo.
node dist\index.cjs
pause
