param(
  [string]$UnityProjectPath = "C:\unity_project\Imagine WebAR",
  [string]$PublishRepoPath = "C:\unity_project\WebAR_Test_repo",
  [string]$EnvId = "lafa-d8g0hkbkk586278bc",
  [string]$HostingPrefix = "lafa-web-ar",
  [string]$UnityExe = "",
  [switch]$SkipUnityBuild,
  [switch]$SkipFunctionDeploy,
  [switch]$SkipHostingDeploy,
  [switch]$DeployRootMirror,
  [switch]$AllowStaleBuild
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Resolve-UnityExe {
  param([string]$Preferred)

  if ($Preferred -and (Test-Path -LiteralPath $Preferred)) {
    return (Resolve-Path -LiteralPath $Preferred).Path
  }

  $candidates = @(
    "C:\Program Files\Unity 6000.5.2f1\Editor\Unity.exe",
    "C:\Program Files\Unity 6000.3.2f1\Editor\Unity.exe",
    "C:\Program Files\Unity 6000.0.69f1\Editor\Unity.exe"
  ) | Where-Object { Test-Path -LiteralPath $_ }

  if ($candidates.Count -gt 0) {
    return $candidates[0]
  }

  $found = Get-ChildItem -Path "C:\Program Files", "C:\Program Files (x86)" -Recurse -Filter Unity.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\Editor\\Unity\.exe$" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1

  if ($found) {
    return $found.FullName
  }

  throw "Unity.exe not found. Pass -UnityExe `"C:\Path\To\Unity.exe`"."
}

function Assert-Command([string]$CommandName) {
  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "Required command '$CommandName' was not found in PATH."
  }
}

function Copy-BuildOutput {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Build output not found: $Source"
  }

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null

  $items = @(
    "Build",
    "TemplateData",
    "StreamingAssets",
    "targets",
    "arcamera.js",
    "itracker.js",
    "opencv.js",
    "manifest.webmanifest",
    "ServiceWorker.js",
    "index.html",
    "xfyun-voice.js",
    "comfyui-config.js",
    "main.png",
    "sent2unity.json"
  )

  foreach ($item in $items) {
    $src = Join-Path $Source $item
    if (-not (Test-Path -LiteralPath $src)) {
      continue
    }

    $dst = Join-Path $Destination $item
    if (Test-Path -LiteralPath $dst) {
      Remove-Item -LiteralPath $dst -Recurse -Force
    }
    Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
  }
}

function Assert-BuildOutputFresh {
  param(
    [string]$BuildOutput,
    [string]$UnityProject
  )

  if (-not (Test-Path -LiteralPath $BuildOutput)) {
    throw "Build output not found: $BuildOutput"
  }

  $buildIndex = Join-Path $BuildOutput "index.html"
  if (-not (Test-Path -LiteralPath $buildIndex)) {
    throw "Build output is incomplete. Missing: $buildIndex"
  }

  $buildTime = (Get-Item -LiteralPath $buildIndex).LastWriteTime
  $sources = @(
    (Join-Path $UnityProject "Assets\WebGLTemplates\iTracker 6\index.html"),
    (Join-Path $UnityProject "Assets\WebGLTemplates\iTracker 6\xfyun-voice.js"),
    (Join-Path $UnityProject "Assets\WebGLTemplates\iTracker 6\comfyui-config.js"),
    (Join-Path $UnityProject "Assets\Imagine\Common\ComfyUI\ComfyUISettings.asset"),
    (Join-Path $UnityProject "Assets\Imagine\Common\ComfyUI\sent2unity.json")
  ) | Where-Object { Test-Path -LiteralPath $_ }

  foreach ($source in $sources) {
    $sourceTime = (Get-Item -LiteralPath $source).LastWriteTime
    if ($sourceTime -gt $buildTime) {
      throw "Build output is older than '$source'. Run a Unity WebGL build first, or pass -AllowStaleBuild if this is intentional."
    }
  }
}

function Deploy-HostingItem {
  param(
    [string]$LocalPath,
    [string]$CloudPath,
    [string]$EnvId
  )

  if (Test-Path -LiteralPath $LocalPath) {
    Write-Host "Deploy hosting: $LocalPath -> $CloudPath"
    tcb hosting deploy $LocalPath $CloudPath --env-id $EnvId
  }
}

$UnityProjectPath = (Resolve-Path -LiteralPath $UnityProjectPath).Path
$PublishRepoPath = (Resolve-Path -LiteralPath $PublishRepoPath).Path
$BuildOutputPath = Join-Path $UnityProjectPath ".deploy-WebAR_Test"
$UnityLogPath = Join-Path $PublishRepoPath "build-unity-webgl.log"

Assert-Command "tcb"
Assert-Command "node"

if (-not $SkipUnityBuild) {
  $UnityExe = Resolve-UnityExe $UnityExe
  Write-Step "Build Unity WebGL"
  Write-Host "Unity: $UnityExe"
  Write-Host "Project: $UnityProjectPath"
  Write-Host "Log: $UnityLogPath"

  & $UnityExe `
    -batchmode `
    -quit `
    -projectPath $UnityProjectPath `
    -executeMethod Imagine.WebAR.Editor.WebGLCommandLineBuild.BuildWebGL `
    -logFile $UnityLogPath

  if ($LASTEXITCODE -ne 0) {
    Write-Host "Unity build failed. Last log lines:" -ForegroundColor Red
    if (Test-Path -LiteralPath $UnityLogPath) {
      Get-Content -LiteralPath $UnityLogPath -Tail 120
    }
    throw "Unity build failed with exit code $LASTEXITCODE."
  }
} else {
  Write-Step "Skip Unity build"
  if (-not $AllowStaleBuild) {
    Assert-BuildOutputFresh -BuildOutput $BuildOutputPath -UnityProject $UnityProjectPath
  }
}

Write-Step "Copy build output to publish repo"
Copy-BuildOutput -Source $BuildOutputPath -Destination $PublishRepoPath

Write-Step "Validate JavaScript"
Push-Location $PublishRepoPath
try {
  node --check ".\xfyun-voice.js"
  node --check ".\cloudfunctions\comfySubmit\index.js"
  if (Test-Path ".\cloudfunctions\comfyStatus\index.js") {
    node --check ".\cloudfunctions\comfyStatus\index.js"
  }

  if (-not $SkipFunctionDeploy) {
    Write-Step "Deploy CloudBase functions"
    if (Test-Path ".\cloudfunctions\xfyunAuth") {
      tcb fn deploy xfyunAuth --force --env-id $EnvId
    }
    tcb fn deploy comfySubmit --force --env-id $EnvId
    if (Test-Path ".\cloudfunctions\comfyStatus") {
      tcb fn deploy comfyStatus --force --env-id $EnvId
    }
    if (Test-Path ".\cloudfunctions\comfyImage") {
      tcb fn deploy comfyImage --force --env-id $EnvId
    }
  } else {
    Write-Step "Skip function deploy"
  }

  if (-not $SkipHostingDeploy) {
    Write-Step "Deploy CloudBase hosting"
    Deploy-HostingItem -LocalPath "Build" -CloudPath "$HostingPrefix/Build" -EnvId $EnvId
    Deploy-HostingItem -LocalPath "TemplateData" -CloudPath "$HostingPrefix/TemplateData" -EnvId $EnvId
    Deploy-HostingItem -LocalPath "StreamingAssets" -CloudPath "$HostingPrefix/StreamingAssets" -EnvId $EnvId
    Deploy-HostingItem -LocalPath "targets" -CloudPath "$HostingPrefix/targets" -EnvId $EnvId

    $rootFiles = @(
      "index.html",
      "xfyun-voice.js",
      "comfyui-config.js",
      "ServiceWorker.js",
      "arcamera.js",
      "itracker.js",
      "opencv.js",
      "manifest.webmanifest",
      "main.png",
      "sent2unity.json"
    )

    foreach ($file in $rootFiles) {
      Deploy-HostingItem -LocalPath $file -CloudPath "$HostingPrefix/$file" -EnvId $EnvId
    }

    if ($DeployRootMirror) {
      Write-Step "Deploy root mirror"
      foreach ($file in $rootFiles) {
        Deploy-HostingItem -LocalPath $file -CloudPath $file -EnvId $EnvId
      }
      Deploy-HostingItem -LocalPath "Build" -CloudPath "Build" -EnvId $EnvId
      Deploy-HostingItem -LocalPath "TemplateData" -CloudPath "TemplateData" -EnvId $EnvId
      Deploy-HostingItem -LocalPath "targets" -CloudPath "targets" -EnvId $EnvId
    }
  } else {
    Write-Step "Skip hosting deploy"
  }
} finally {
  Pop-Location
}

$url = "https://$EnvId-1302628121.tcloudbaseapp.com/$HostingPrefix/"
Write-Step "Done"
Write-Host "URL: $url" -ForegroundColor Green
Write-Host "Tip: append ?v=<Frontend Version> when testing in WeChat." -ForegroundColor Yellow
