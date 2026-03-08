@echo off
setlocal enabledelayedexpansion

echo === QQBot Upgrade Script ===

set "foundInstallation="

set "clawdbotDir=%USERPROFILE%\.clawdbot"
if exist "%clawdbotDir%\" (
    call :CleanupInstallation clawdbot
    set "foundInstallation=clawdbot"
)

set "openclawDir=%USERPROFILE%\.openclaw"
if exist "%openclawDir%\" (
    call :CleanupInstallation openclaw
    set "foundInstallation=openclaw"
)

if "%foundInstallation%"=="" (
    echo clawdbot or openclaw not found
    exit /b 1
)

set "cmd=%foundInstallation%"

echo.
echo === Cleanup Complete ===
echo.
echo Run these commands to reinstall:
for %%I in ("%~dp0..") do set "qqbotDir=%%~fI"
echo   cd %qqbotDir%
echo   %cmd% plugins install .
echo   %cmd% channels add --channel qqbot --token "AppID:AppSecret"
echo   %cmd% gateway restart
exit /b 0

:CleanupInstallation
set "AppName=%~1"
set "appDir=%USERPROFILE%\.%AppName%"
set "configFile=%appDir%\%AppName%.json"
set "extensionDir=%appDir%\extensions\qqbot"

echo.
echo ^>^>^> Processing %AppName% installation...

if exist "%extensionDir%\" (
    echo Deleting old plugin: %extensionDir%
    rd /s /q "%extensionDir%" 2>nul || (
        echo Warning: Could not delete %extensionDir% ^(permission denied^)
        echo   Please delete it manually if needed
    )
) else (
    echo Old plugin directory not found, skipping
)

if exist "%configFile%" (
    echo Cleaning qqbot fields from config...
    set "configPath=%configFile:\=/%"
    node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('!configPath!','utf8'));if(c.channels&&c.channels.qqbot){delete c.channels.qqbot;console.log('  - deleted channels.qqbot');}if(c.plugins&&c.plugins.entries&&c.plugins.entries.qqbot){delete c.plugins.entries.qqbot;console.log('  - deleted plugins.entries.qqbot');}if(c.plugins&&c.plugins.installs&&c.plugins.installs.qqbot){delete c.plugins.installs.qqbot;console.log('  - deleted plugins.installs.qqbot');}if(c.plugins&&c.plugins.allow&&Array.isArray(c.plugins.allow)){const i=c.plugins.allow.indexOf('qqbot');if(i^!==-1){c.plugins.allow.splice(i,1);console.log('  - deleted qqbot from plugins.allow array');}}fs.writeFileSync('!configPath!',JSON.stringify(c,null,2));console.log('Config file updated');" || (
        echo Warning: Node.js error
    )
) else (
    echo Config file not found: %configFile%
)
exit /b 0
