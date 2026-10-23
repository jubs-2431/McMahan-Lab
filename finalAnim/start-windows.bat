@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  py -3.12 -m venv .venv
  if errorlevel 1 goto :failed
)
if not exist ".venv\.requirements-installed" goto :install
fc /b requirements.txt ".venv\.requirements-installed" >nul 2>&1
if errorlevel 1 goto :install
goto :configured
:install
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto :failed
copy /y requirements.txt ".venv\.requirements-installed" >nul
if errorlevel 1 goto :failed
:configured
if not exist .env (
  copy .env.example .env >nul
  echo Created .env. Add your OpenAI and Azure Speech credentials, then run this again.
  notepad .env
  pause
  exit /b 0
)
echo Starting finalAnim. The URL will appear below.
".venv\Scripts\python.exe" server.py
if errorlevel 1 goto :failed
exit /b 0
:failed
echo Startup failed. See the error above. Install Python 3.12 ^(64-bit^) with the Python launcher.
pause
exit /b 1
