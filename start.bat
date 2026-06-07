@echo off
cd /d D:\email-dashboard
echo ============================================
echo   Sherwin's Domain - Email Marketing Suite
echo ============================================
echo.
echo [1/3] Starting server...
pm2 resurrect 2>nul || pm2 start server.js --name sherwins-domain
pm2 save >nul 2>&1

echo [2/3] Server running at http://localhost:3000
echo       Campaigns: http://localhost:3000/campaigns.html
echo.

echo [3/3] Starting Cloudflare tunnel...
start "Cloudflare Tunnel" /min D:\cloudflared.exe tunnel --url http://localhost:3000

echo.
echo All systems go! Open your browser to:
echo   http://localhost:3000/campaigns.html
echo.
echo (Tunnel URL will appear in the background window)
pause
