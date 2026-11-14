@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Publication de Kairos sur GitHub...
if not exist .git (
  git init -b main
  git remote add origin https://github.com/Lampadwair/kairos.git
)
git add .
git commit -m "Kairos : mise a jour"
git push -u origin main
echo.
echo Termine. Tu peux fermer cette fenetre.
pause
