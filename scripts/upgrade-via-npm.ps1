# qqbot upgrade via npm package (Windows PowerShell)
#
# Windows-native equivalent of upgrade-via-npm.sh.
# No bash / Git Bash / WSL required.
#
# Usage:
#   .\upgrade-via-npm.ps1                                    # upgrade to latest (default)
#   .\upgrade-via-npm.ps1 -Version <version>                 # upgrade to specific version
#   .\upgrade-via-npm.ps1 -SelfVersion                       # upgrade to local package.json version
#   .\upgrade-via-npm.ps1 -AppId <appid> -Secret <secret>    # configure on first install
#   .\upgrade-via-npm.ps1 -NoRestart                         # file replacement only (for hot-upgrade)

param(
    [string]$Version = "",
    [switch]$SelfVersion,
    [string]$AppId = "",
    [string]$Secret = "",
    [switch]$NoRestart,
    [string]$Tag = "",
    [string]$Pkg = "",
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$PKG_NAME = "@tencent-connect/openclaw-qqbot"
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Definition
$PROJECT_DIR = Split-Path -Parent $SCRIPT_DIR

# -Pkg 覆盖包名（支持 "scope/name" 自动补 @）
if ($Pkg) {
    $Pkg = $Pkg.Trim()
    if (-not $Pkg.StartsWith("@")) { $Pkg = "@$Pkg" }
    $PKG_NAME = $Pkg
}

# Read local version
$LOCAL_VERSION = ""
try {
    $pkgPath = Join-Path $PROJECT_DIR "package.json"
    if (Test-Path $pkgPath) {
        $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
        $LOCAL_VERSION = $pkg.version
    }
} catch {}

if ($Help) {
    Write-Host "Usage:"
    Write-Host "  .\upgrade-via-npm.ps1                              # upgrade to latest (default)"
    Write-Host "  .\upgrade-via-npm.ps1 -Version [version]           # upgrade to specific version"
    Write-Host "  .\upgrade-via-npm.ps1 -SelfVersion                 # upgrade to repo version ($LOCAL_VERSION)"
    Write-Host ""
    Write-Host "  -Pkg [scope/name]    Custom npm package (e.g. ryantest/openclaw-qqbot)"
    Write-Host "  -AppId [appid]       QQ bot appid (required on first install)"
    Write-Host "  -Secret [secret]     QQ bot secret (required on first install)"
    exit 0
}

# Determine install source
$INSTALL_SRC = ""
if ($Tag) {
    $INSTALL_SRC = "${PKG_NAME}@${Tag}"
} elseif ($Version) {
    $INSTALL_SRC = "${PKG_NAME}@${Version}"
} elseif ($SelfVersion) {
    if (-not $LOCAL_VERSION) {
        Write-Host "[ERROR] Cannot read version from package.json" -ForegroundColor Red
        exit 1
    }
    $INSTALL_SRC = "${PKG_NAME}@${LOCAL_VERSION}"
} else {
    $INSTALL_SRC = "${PKG_NAME}@latest"
}

# Environment variable fallback
if (-not $AppId) { $AppId = $env:QQBOT_APPID }
if (-not $Secret) { $Secret = $env:QQBOT_SECRET }
if ((-not $AppId) -and (-not $Secret) -and $env:QQBOT_TOKEN) {
    $parts = $env:QQBOT_TOKEN -split ":", 2
    $AppId = $parts[0]
    $Secret = $parts[1]
}

# Detect CLI
$CMD = ""
foreach ($name in @("openclaw", "clawdbot", "moltbot")) {
    try {
        $null = Get-Command $name -ErrorAction Stop
        $CMD = $name
        break
    } catch {}
}
if (-not $CMD) {
    Write-Host "[ERROR] openclaw / clawdbot / moltbot not found" -ForegroundColor Red
    exit 1
}

$HOME_DIR = $env:USERPROFILE
if (-not $HOME_DIR) { $HOME_DIR = [Environment]::GetFolderPath("UserProfile") }
$EXTENSIONS_DIR = Join-Path (Join-Path $HOME_DIR ".$CMD") "extensions"

Write-Host "==========================================="
Write-Host "  qqbot npm upgrade: $INSTALL_SRC"
Write-Host "==========================================="
Write-Host ""

# [1/3] Download and extract new version
Write-Host "[1/5] Downloading new version..."
$TMPDIR_PACK = Join-Path ([System.IO.Path]::GetTempPath()) "qqbot-pack-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$EXTRACT_DIR = Join-Path ([System.IO.Path]::GetTempPath()) "qqbot-extract-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $TMPDIR_PACK -Force | Out-Null
New-Item -ItemType Directory -Path $EXTRACT_DIR -Force | Out-Null

try {
    Push-Location $TMPDIR_PACK

    # Multi-registry fallback
    $PACK_OK = $false
    $registries = @("https://registry.npmjs.org/", "https://registry.npmmirror.com/", "")
    foreach ($registry in $registries) {
        try {
            if ($registry) {
                Write-Host "  Trying registry: $registry"
                & npm pack $INSTALL_SRC --registry $registry --quiet 2>&1 | Out-Null
            } else {
                Write-Host "  Trying default registry..."
                & npm pack $INSTALL_SRC --quiet 2>&1 | Out-Null
            }
            if ($LASTEXITCODE -eq 0) {
                $PACK_OK = $true
                break
            }
        } catch {}
    }

    if (-not $PACK_OK) {
        Write-Host "[ERROR] npm pack failed (all registries unavailable)" -ForegroundColor Red
        exit 1
    }

    $TGZ_FILE = Get-ChildItem -Path $TMPDIR_PACK -Filter "*.tgz" | Select-Object -First 1
    if (-not $TGZ_FILE) {
        Write-Host "[ERROR] Downloaded tgz file not found" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Downloaded: $($TGZ_FILE.Name)"

    # Extract tgz (tar is built-in on Windows 10+)
    & tar xzf $TGZ_FILE.FullName -C $EXTRACT_DIR
    $PACKAGE_DIR = Join-Path $EXTRACT_DIR "package"
    if (-not (Test-Path $PACKAGE_DIR)) {
        Write-Host "[ERROR] Extraction failed, package directory not found" -ForegroundColor Red
        exit 1
    }

    Pop-Location

    # Prepare staging directory
    $STAGING_DIR = Join-Path (Split-Path $EXTENSIONS_DIR -Parent) ".qqbot-upgrade-staging"
    if (Test-Path $STAGING_DIR) { Remove-Item -Recurse -Force $STAGING_DIR }
    Copy-Item -Recurse -Force $PACKAGE_DIR $STAGING_DIR

    # Check bundled dependencies
    $nmDir = Join-Path $STAGING_DIR "node_modules"
    if (Test-Path $nmDir) {
        $bundledCount = (Get-ChildItem -Directory $nmDir -ErrorAction SilentlyContinue | Measure-Object).Count
        # Count scoped packages
        Get-ChildItem -Directory $nmDir -Filter "@*" -ErrorAction SilentlyContinue | ForEach-Object {
            $bundledCount += (Get-ChildItem -Directory $_.FullName -ErrorAction SilentlyContinue | Measure-Object).Count - 1
        }
        Write-Host "  Bundled dependencies ready (${bundledCount} packages)"
    } else {
        Write-Host "  [WARN] Bundled node_modules not found, installing dependencies..."
        Push-Location $STAGING_DIR
        try { & npm install --omit=dev --omit=peer --ignore-scripts --quiet 2>&1 | Out-Null } catch {}
        Pop-Location
    }

} finally {
    # Clean up temp files
    if (Test-Path $TMPDIR_PACK) { Remove-Item -Recurse -Force $TMPDIR_PACK -ErrorAction SilentlyContinue }
    if (Test-Path $EXTRACT_DIR) { Remove-Item -Recurse -Force $EXTRACT_DIR -ErrorAction SilentlyContinue }
}

# ── Preflight: validate new package before writing to extensions ──
Write-Host ""
Write-Host "[2/5] Preflight checks..."
$PreflightOK = $true

# (a) package.json exists and has version
$StagingPkg = Join-Path $STAGING_DIR "package.json"
$StagingVersion = ""
if (-not (Test-Path $StagingPkg)) {
    Write-Host "  [FAIL] New package missing package.json" -ForegroundColor Red
    $PreflightOK = $false
} else {
    try {
        $spkg = Get-Content $StagingPkg -Raw | ConvertFrom-Json
        $StagingVersion = $spkg.version
        if (-not $StagingVersion) { throw "no version" }
        Write-Host "  [OK] Version: $StagingVersion"
    } catch {
        Write-Host "  [FAIL] package.json unreadable or missing version" -ForegroundColor Red
        $PreflightOK = $false
    }
}

# (b) Entry file exists
$EntryFile = ""
foreach ($candidate in @("dist\index.js", "index.js")) {
    if (Test-Path (Join-Path $STAGING_DIR $candidate)) {
        $EntryFile = $candidate
        break
    }
}
if (-not $EntryFile) {
    Write-Host "  [FAIL] Missing entry file (dist\index.js or index.js)" -ForegroundColor Red
    $PreflightOK = $false
} else {
    Write-Host "  [OK] Entry file: $EntryFile"
}

# (c) Core directory dist/src
$CoreSrcDir = Join-Path $STAGING_DIR "dist" "src"
if (-not (Test-Path $CoreSrcDir)) {
    Write-Host "  [FAIL] Missing core directory dist\src\" -ForegroundColor Red
    $PreflightOK = $false
} else {
    $CoreJsCount = (Get-ChildItem -Path $CoreSrcDir -Filter "*.js" -File -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count
    Write-Host "  [OK] dist\src\ contains $CoreJsCount JS files"
    if ($CoreJsCount -lt 5) {
        Write-Host "  [FAIL] JS file count too low (expected >= 5, got $CoreJsCount)" -ForegroundColor Red
        $PreflightOK = $false
    }
}

# (d) Critical module files
$MissingModules = @()
foreach ($mod in @("dist\src\gateway.js", "dist\src\api.js", "dist\src\admin-resolver.js")) {
    if (-not (Test-Path (Join-Path $STAGING_DIR $mod))) {
        $MissingModules += $mod
    }
}
if ($MissingModules.Count -gt 0) {
    Write-Host "  [FAIL] Missing critical modules: $($MissingModules -join ', ')" -ForegroundColor Red
    $PreflightOK = $false
} else {
    Write-Host "  [OK] Critical modules intact"
}

# (e) Bundled node_modules health check
$nmDir = Join-Path $STAGING_DIR "node_modules"
if (Test-Path $nmDir) {
    $BundledOK = $true
    foreach ($dep in @("ws", "silk-wasm")) {
        if (-not (Test-Path (Join-Path $nmDir $dep))) {
            Write-Host "  [WARN] Bundled dependency missing: $dep" -ForegroundColor Yellow
            $BundledOK = $false
        }
    }
    if ($BundledOK) {
        Write-Host "  [OK] Core bundled dependencies intact"
    }
}

# (f) Version sanity check
if ($StagingVersion) {
    $StagingMajor = ($StagingVersion -split "\.")[0]
    if ($StagingMajor -eq "0") {
        Write-Host "  [WARN] Major version is 0 ($StagingVersion), may not be a production release" -ForegroundColor Yellow
    }
}

# Preflight result
if (-not $PreflightOK) {
    Write-Host ""
    Write-Host "[ABORT] Preflight checks failed, upgrade cancelled (old version unaffected)" -ForegroundColor Red
    Remove-Item -Recurse -Force $STAGING_DIR -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "  [OK] All preflight checks passed"

# [3/5] Replace plugin directory (in-place overwrite to avoid file-lock issues)
Write-Host ""
Write-Host "[3/5] Replacing plugin directory..."
if (-not (Test-Path $EXTENSIONS_DIR)) { New-Item -ItemType Directory -Path $EXTENSIONS_DIR -Force | Out-Null }
$TARGET_DIR = Join-Path $EXTENSIONS_DIR "openclaw-qqbot"

if (-not (Test-Path $TARGET_DIR)) {
    # Fresh install: just move staging into place
    Move-Item -Path $STAGING_DIR -Destination $TARGET_DIR
} else {
    # In-place overwrite using robocopy /MIR (mirrors source to dest, works even with locked files)
    Write-Host "  Overwriting in-place with robocopy /MIR ..."
    $roboArgs = @($STAGING_DIR, $TARGET_DIR, "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:3", "/W:2")
    $roboResult = & robocopy @roboArgs 2>&1
    $roboExit = $LASTEXITCODE
    # robocopy exit codes: 0-7 = success (various levels of copy), 8+ = error
    if ($roboExit -ge 8) {
        Write-Host "  robocopy failed (exit $roboExit), falling back to Copy-Item..." -ForegroundColor Yellow
        # Fallback: recursive Copy-Item -Force (overwrites files even if target exists)
        try {
            Copy-Item -Path (Join-Path $STAGING_DIR "*") -Destination $TARGET_DIR -Recurse -Force -ErrorAction Stop
            Write-Host "  Copy-Item fallback succeeded"
        } catch {
            Write-Host "  [ERROR] Copy-Item also failed: $($_.Exception.Message)" -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "  robocopy completed (exit $roboExit)"
    }
    # Clean up staging
    Remove-Item -Recurse -Force $STAGING_DIR -ErrorAction SilentlyContinue
}

# Clean up leftover directories
foreach ($leftover in @("openclaw-qqbot.staging", ".qqbot-upgrade-staging", ".qqbot-upgrade-old", ".openclaw-qqbot-new")) {
    $p = Join-Path $EXTENSIONS_DIR $leftover
    if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
}
$oldDir = Join-Path (Split-Path $EXTENSIONS_DIR -Parent) ".qqbot-upgrade-old"
if (Test-Path $oldDir) { Remove-Item -Recurse -Force $oldDir -ErrorAction SilentlyContinue }
foreach ($legacyName in @("qqbot", "openclaw-qq")) {
    $p = Join-Path $EXTENSIONS_DIR $legacyName
    if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
}
Write-Host "  Installed to: $TARGET_DIR"

# Execute postinstall script to create openclaw SDK symlink
# (upgrade-via-npm is pure file operation, npm install is not run, so postinstall won't trigger automatically)
$PostinstallScript = Join-Path $TARGET_DIR "scripts" "postinstall-link-sdk.js"
if (Test-Path $PostinstallScript) {
    Write-Host "  Running postinstall: creating openclaw SDK symlink..."
    try {
        Push-Location $TARGET_DIR
        $postOutput = & node $PostinstallScript 2>&1
        Pop-Location
        if ($postOutput) { Write-Host "  $postOutput" }
    } catch {
        Write-Host "  [WARN] postinstall script failed (non-fatal)" -ForegroundColor Yellow
        try { Pop-Location } catch {}
    }
    # Verify symlink creation
    $symlinkPath = Join-Path $TARGET_DIR "node_modules" "openclaw"
    if (Test-Path $symlinkPath) {
        Write-Host "  [OK] openclaw SDK symlink ready"
    } else {
        Write-Host "  [WARN] openclaw SDK symlink not created, attempting manual fallback..." -ForegroundColor Yellow
        $cliDataDir = Split-Path $EXTENSIONS_DIR -Parent
        $cliName = (Split-Path $cliDataDir -Leaf) -replace '^\.',''
        try {
            $globalRoot = (& npm root -g 2>$null).Trim()
            $globalPkg = Join-Path $globalRoot $cliName
            if ($globalRoot -and (Test-Path $globalPkg)) {
                $nmDir = Join-Path $TARGET_DIR "node_modules"
                if (-not (Test-Path $nmDir)) { New-Item -ItemType Directory -Path $nmDir -Force | Out-Null }
                New-Item -ItemType Junction -Path $symlinkPath -Target $globalPkg -Force | Out-Null
                Write-Host "  [OK] Manual symlink created: -> $globalPkg"
            } else {
                Write-Host "  [ERROR] Cannot locate global $cliName installation (npm root -g: $globalRoot)" -ForegroundColor Red
            }
        } catch {
            Write-Host "  [ERROR] Manual symlink creation also failed: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
} else {
    Write-Host "  [WARN] postinstall script not found, skipping symlink creation" -ForegroundColor Yellow
}

# [4/5] Verify installation
Write-Host ""
Write-Host "[4/5] Verifying installation..."
$NEW_VERSION = "unknown"
try {
    $newPkgPath = Join-Path $TARGET_DIR "package.json"
    if (Test-Path $newPkgPath) {
        $newPkg = Get-Content $newPkgPath -Raw | ConvertFrom-Json
        if ($newPkg.version) { $NEW_VERSION = $newPkg.version }
    }
} catch {}

Write-Host "QQBOT_NEW_VERSION=$NEW_VERSION"

if ($NEW_VERSION -ne "unknown") {
    Write-Host "QQBOT_REPORT=QQBot upgrade complete: v${NEW_VERSION}"
} else {
    Write-Host "QQBOT_REPORT=[WARN] QQBot upgrade status unknown, cannot confirm new version"
}

Write-Host ""
Write-Host "==========================================="
Write-Host "  File installation complete"
Write-Host "==========================================="

# --NoRestart mode
if ($NoRestart) {
    Write-Host ""
    Write-Host "[Skip restart] -NoRestart specified, exiting for caller to trigger gateway restart"
    exit 0
}

# [配置] Configure appid/secret
if ($AppId -and $Secret) {
    Write-Host ""
    Write-Host "[Config] Writing qqbot channel config..."
    $DESIRED_TOKEN = "${AppId}:${Secret}"

    try {
        & $CMD channels add --channel qqbot --token $DESIRED_TOKEN 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  Channel config saved"
        } else { throw "channels add failed" }
    } catch {
        Write-Host "  [WARN] $CMD channels add failed, trying direct config edit..." -ForegroundColor Yellow
        $CONFIG_FILE = Join-Path (Join-Path $HOME_DIR ".$CMD") "$CMD.json"
        if (Test-Path $CONFIG_FILE) {
            try {
                $cfg = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
                if (-not $cfg.channels) { $cfg | Add-Member -NotePropertyName channels -NotePropertyValue @{} }
                if (-not $cfg.channels.qqbot) { $cfg.channels | Add-Member -NotePropertyName qqbot -NotePropertyValue @{} }
                $cfg.channels.qqbot | Add-Member -NotePropertyName appId -NotePropertyValue $AppId -Force
                $cfg.channels.qqbot | Add-Member -NotePropertyName clientSecret -NotePropertyValue $Secret -Force
                $cfg | ConvertTo-Json -Depth 10 | Set-Content $CONFIG_FILE -Encoding UTF8
                Write-Host "  Channel config saved (direct file edit)"
            } catch {
                Write-Host "  [ERROR] Config write failed, please configure manually:" -ForegroundColor Red
                Write-Host "     $CMD channels add --channel qqbot --token `"${AppId}:${Secret}`""
            }
        }
    }
} elseif ($AppId -or $Secret) {
    Write-Host ""
    Write-Host "[WARN] -AppId and -Secret must be provided together" -ForegroundColor Yellow
}

# [5/5] Restart gateway
Write-Host ""

# Manual upgrade: write startup-marker before restart to prevent bot from sending duplicate notification
if ($NEW_VERSION -and $NEW_VERSION -ne "unknown") {
    $MarkerDir = Join-Path $HOME_DIR ".openclaw" "qqbot" "data"
    if (-not (Test-Path $MarkerDir)) { New-Item -ItemType Directory -Path $MarkerDir -Force | Out-Null }
    $MarkerFile = Join-Path $MarkerDir "startup-marker.json"
    $Now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    @{ version = $NEW_VERSION; startedAt = $Now; greetedAt = $Now } | ConvertTo-Json -Compress | Set-Content $MarkerFile -Encoding UTF8
}

Write-Host "[Restart] Restarting gateway..."
try {
    & $CMD gateway restart 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Gateway restarted"
        # Print the same upgrade greeting as bot notification (no need to push via bot in manual upgrade)
        if ($NEW_VERSION -and $NEW_VERSION -ne "unknown") {
            Write-Host ""
            Write-Host "🎉 QQBot 插件已更新至 v${NEW_VERSION}，在线等候你的吩咐。"
        }
    } else { throw "restart failed" }
} catch {
    Write-Host "  [WARN] Gateway restart failed, please run manually: $CMD gateway restart" -ForegroundColor Yellow
}
