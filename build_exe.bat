@echo off
cd /d "%~dp0"
where npm >nul 2>nul
if %errorlevel%==0 (
    echo Compilation de l'interface...
    pushd frontend
    call npm install
    call npm run build
    popd
) else (
    echo Node.js absent : utilisation de frontend\dist deja compile.
)
echo Installation des outils...
python -m pip install -r backend\requirements.txt pyinstaller
echo.
echo Creation de MessagerieChiffree.exe (1 a 2 minutes)...
python -m PyInstaller --onefile --name MessagerieChiffree --add-data "frontend\dist;frontend\dist" --add-data "backend\relais_static;relais_static" --hidden-import relais --collect-submodules uvicorn backend\main.py
echo.
echo Termine ! Ton programme est ici : dist\MessagerieChiffree.exe
pause
