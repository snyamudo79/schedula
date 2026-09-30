@echo off
rem Serves Schedula at http://localhost:5178 so it can be installed as an app.
rem After installing once, the app works offline — you don't need this running.
cd /d "%~dp0"
start "" http://localhost:5178/
python -m http.server 5178
