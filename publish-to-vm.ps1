param(
  [string]$Project = "cryvollm",
  [string]$Instance = "instance-20260811-203639",
  [string]$Zone = "us-south1-b",
  [switch]$SkipSecretSync
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command gcloud.cmd -ErrorAction SilentlyContinue)) {
  throw "Google Cloud CLI is not installed. Run: winget install Google.CloudSDK"
}

$secretDirectory = Join-Path $HOME ".cryvolmon"
$secretStore = Join-Path $secretDirectory "api-keys.json"
New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null

function Convert-SecureStringToPlainText([Security.SecureString]$SecureValue) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Save-EncryptedKey([string]$Name, [string]$Value) {
  $stored = [ordered]@{}
  if (Test-Path $secretStore) {
    try {
      $existing = Get-Content $secretStore -Raw | ConvertFrom-Json
      foreach ($property in $existing.PSObject.Properties) { $stored[$property.Name] = $property.Value }
    } catch { }
  }
  $stored[$Name] = ConvertFrom-SecureString (ConvertTo-SecureString $Value -AsPlainText -Force)
  $stored | ConvertTo-Json | Set-Content -LiteralPath $secretStore
  return $Value
}

function Get-EncryptedKey([string]$Name) {
  if (-not (Test-Path $secretStore)) { return $null }
  try {
    $stored = Get-Content $secretStore -Raw | ConvertFrom-Json
    $encrypted = $stored.PSObject.Properties[$Name].Value
    if ($encrypted) { return Convert-SecureStringToPlainText (ConvertTo-SecureString $encrypted) }
  } catch { }
  return $null
}

function Get-LocalDotEnvKey([string]$Name) {
  $dotenv = Join-Path (Get-Location).Path ".env"
  if (-not (Test-Path $dotenv)) { return $null }
  $line = Get-Content -LiteralPath $dotenv | Where-Object { $_ -match "^$Name=(.*)$" } | Select-Object -First 1
  if (-not $line) { return $null }
  $value = ($line -replace "^$Name=", "").Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return $value
}

function Get-OrPromptKey([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ($value) { return Save-EncryptedKey $Name $value }
  $value = Get-EncryptedKey $Name
  if ($value) { return $value }
  $value = Get-LocalDotEnvKey $Name
  if ($value) { return Save-EncryptedKey $Name $value }
  $secure = Read-Host "Paste $Name (saved encrypted for future deploys)" -AsSecureString
  return Save-EncryptedKey $Name (Convert-SecureStringToPlainText $secure)
}

# ── 1. Push local commits to GitHub ─────────────────────────────────────────
Write-Host "Pushing local commits to GitHub..."
$uncommitted = git status --porcelain
if ($uncommitted) {
  throw "You have uncommitted changes. Commit or stash them before deploying."
}
$branch = git rev-parse --abbrev-ref HEAD
git push origin $branch
if ($LASTEXITCODE -ne 0) { throw "git push failed." }

# ── 2. Collect API keys ──────────────────────────────────────────────────────
$localApiEnv = Join-Path $env:TEMP "cryvolmon-api.env"
Remove-Item -LiteralPath $localApiEnv -Force -ErrorAction SilentlyContinue

$apiKeyLines = [System.Collections.Generic.List[string]]::new()
if (-not $SkipSecretSync) {
  $requiredApiKeys = @("GROQ_API_KEY", "CEREBRAS_API_KEY", "OPENROUTER_API_KEY", "BITUNIX_API_KEY", "BITUNIX_SECRET_KEY", "OPENCODE_API_KEY", "NVIDIA_API_KEY")
  foreach ($name in $requiredApiKeys) {
    $apiKeyLines.Add("$name=$(Get-OrPromptKey $name)")
  }
  foreach ($name in @("OPENCODE_API_KEY", "DEEPSEEK_API_KEY", "HYPERBOLIC_API_KEY", "ABACUS_API_KEY", "BITRUE_API_KEY", "BITRUE_SECRET_KEY")) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $apiKeyLines.Add("$name=$(Save-EncryptedKey $name $value)") }
    else {
      $value = Get-EncryptedKey $name
      if (-not $value) { $value = Get-LocalDotEnvKey $name }
      if ($value) { $apiKeyLines.Add("$name=$value") }
    }
  }
}

if ($apiKeyLines.Count -gt 0) {
  Set-Content -LiteralPath $localApiEnv -Value ($apiKeyLines -join "`n") -NoNewline
}

$aclUser = "$env:USERDOMAIN\$env:USERNAME"
icacls $secretStore /inheritance:r /grant:r "${aclUser}:(F)" | Out-Null

# ── 3. Upload API key bundle ─────────────────────────────────────────────────
if (Test-Path $localApiEnv) {
  gcloud.cmd compute scp $localApiEnv "${Instance}:/tmp/cryvolmon-api.env" --project=$Project --zone=$Zone
  if ($LASTEXITCODE -ne 0) { throw "Uploading the API key bundle failed." }
  Remove-Item -LiteralPath $localApiEnv -Force
  $syncedNames = $apiKeyLines | ForEach-Object { ($_ -split "=", 2)[0] }
  Write-Host ("Synced server-side API keys: " + ($syncedNames -join ", "))
}

# ── 4. Pull latest code on the VM and rebuild ───────────────────────────────
$remoteScript = @'
set -euo pipefail

if [ ! -f /etc/cryvolmon.env ] || ! sudo grep -q '^DATABASE_URL=' /etc/cryvolmon.env; then
  echo "ERROR: /etc/cryvolmon.env must contain DATABASE_URL before deployment."
  exit 1
fi

if [ -f /tmp/cryvolmon-api.env ]; then
  sudo touch /etc/cryvolmon.env
  sudo chmod 600 /etc/cryvolmon.env
  while IFS='=' read -r key value; do
    [ -z "$key" ] && continue
    sudo sed -i "/^${key}=/d" /etc/cryvolmon.env
    printf '%s=%s\n' "$key" "$value" | sudo tee -a /etc/cryvolmon.env >/dev/null
  done < /tmp/cryvolmon-api.env
  rm -f /tmp/cryvolmon-api.env
fi

cd /opt/cryvolmon

# Stash any pipeline-generated uncommitted changes before pulling.
# This handles the case where the pipeline committed locally but
# hasn't pushed yet (e.g. after a restart before the auto-push runs).
STASHED=false
if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet HEAD 2>/dev/null; then
  git stash push -m "deploy-auto-stash"
  STASHED=true
fi

# If the VM has local commits that weren't pushed (pipeline auto-commit),
# push them first so they aren't lost by the pull.
AHEAD=$(git rev-list --count @{u}..HEAD 2>/dev/null || echo "0")
if [ "$AHEAD" -gt 0 ]; then
  echo "Pushing $AHEAD pipeline-generated commit(s) to GitHub..."
  git push origin main 2>&1 || echo "Warning: push failed, continuing with pull..."
fi

git pull --ff-only origin main
if [ $? -ne 0 ]; then
  echo "Fast-forward pull failed. Attempting rebase..."
  git pull --rebase origin main
fi

# Restore stashed changes if any.
if [ "$STASHED" = true ]; then
  git stash pop 2>/dev/null || echo "Warning: stash pop had conflicts, stash left in reflog"
fi

sudo systemctl stop cryvolmon 2>/dev/null || true

npm ci
sudo bash -c 'set -a; source /etc/cryvolmon.env; set +a; cd /opt/cryvolmon; npm run db:push'
npm run build

sudo tee /etc/systemd/system/cryvolmon.service >/dev/null <<SERVICE
[Unit]
Description=Cryvolmon trading and council service
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=/opt/cryvolmon
EnvironmentFile=-/etc/cryvolmon.env
Environment=NODE_ENV=production
Environment=PORT=5000
ExecStart=/usr/bin/node /opt/cryvolmon/dist/index.cjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable cryvolmon
sudo systemctl restart cryvolmon
sudo systemctl --no-pager --full status cryvolmon

# Passwordless sudo for the cryvolmon service user (council manager tools).
sudo tee /etc/sudoers.d/cryvolmon-agent >/dev/null <<SUDOERS
$USER ALL=(ALL) NOPASSWD:ALL
SUDOERS
sudo chmod 440 /etc/sudoers.d/cryvolmon-agent

# Point Caddy at the current external IP so the sslip.io hostname stays reachable.
if command -v caddy >/dev/null 2>&1 && [ -f /etc/caddy/Caddyfile ]; then
  CURRENT_IP=$(curl -s --max-time 8 ifconfig.me || true)
  if [ -n "$CURRENT_IP" ] && [ "$CURRENT_IP" != "34.174.227.237" ]; then
    sudo sed -i "s/34-174-227-237\.sslip\.io/${CURRENT_IP//./-}.sslip.io/g" /etc/caddy/Caddyfile
    sudo sed -i "s/34-174-172-116\.sslip\.io/${CURRENT_IP//./-}.sslip.io/g" /etc/caddy/Caddyfile
    sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy || true
    echo "Caddy updated to ${CURRENT_IP}"
  fi
fi
'@

$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
gcloud.cmd compute ssh $Instance --project=$Project --zone=$Zone --command="echo $encoded | base64 -d | bash"
if ($LASTEXITCODE -ne 0) { throw "The VM deployment command failed. The existing service was left in place." }

$externalIp = gcloud.cmd compute instances describe $Instance --project=$Project --zone=$Zone --format="value(networkInterfaces[0].accessConfigs[0].natIP)"
$externalIp = $externalIp.Trim()
Write-Host "Deployment complete: http://${externalIp}:5000/council"
