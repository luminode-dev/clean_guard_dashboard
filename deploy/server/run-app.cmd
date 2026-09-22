@echo off
rem Clean Guard FastAPI · 127.0.0.1:8010 (Caddy 가 /api, /ws, /snapshots 를 여기로 프록시)
cd /d C:\server\app
C:\server\app\python\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8010 --proxy-headers --log-level info >> C:\server\app\app.log 2>&1
