param(
  [Parameter(Mandatory = $true)]
  [string]$ComfyBaseUrl,

  [string]$EnvId = "lafa-d8g0hkbkk586278bc",
  [string]$PromptNodeId = "6",
  [string]$OutputNodeId = "9",
  [string]$CheckpointName = "v1-5-pruned-emaonly.ckpt"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $repoRoot "cloudbaserc.json"
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json

$config.envId = $EnvId

foreach ($fn in $config.functions) {
  if ($fn.name -eq "comfySubmit") {
    $fn | Add-Member -Force -NotePropertyName envVariables -NotePropertyValue @{
      COMFY_BASE_URL = $ComfyBaseUrl.TrimEnd("/")
      COMFY_PROMPT_NODE_ID = $PromptNodeId
      COMFY_CKPT_NAME = $CheckpointName
    }
  }

  if ($fn.name -eq "comfyStatus") {
    $fn | Add-Member -Force -NotePropertyName envVariables -NotePropertyValue @{
      COMFY_BASE_URL = $ComfyBaseUrl.TrimEnd("/")
      COMFY_OUTPUT_NODE_ID = $OutputNodeId
    }
  }
}

$json = $config | ConvertTo-Json -Depth 10
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configPath, $json, $utf8NoBom)

Push-Location $repoRoot
try {
  tcb config update fn comfySubmit -e $EnvId
  tcb config update fn comfyStatus -e $EnvId
} finally {
  Pop-Location
}
