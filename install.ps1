<#
.SYNOPSIS
  安装 Codex Speed 插件到本机的 Codex / ChatGPT 桌面版。

.DESCRIPTION
  干的事：
    1. 检查 Node.js（MCP server 与 hook 需要）。
    2. 把插件复制到 %USERPROFILE%\.codex\plugins\codex-speed。
    3. 在个人 marketplace（%USERPROFILE%\.agents\plugins\marketplace.json）里登记，
       这样 ChatGPT/Codex 桌面版的 Plugins 目录里能看到它。
    4. 可选：直接写入 config.toml 启用（改写前自动备份为 config.toml.bak）。

.PARAMETER Enable
  安装完立刻在 config.toml 里启用插件。

.PARAMETER Force
  连同插件数据目录（data）一起清空，做一次彻底重装。默认会保留 data。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Enable -Force
#>
[CmdletBinding()]
param(
  [switch]$Enable,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$pluginName = 'codex-speed'
$marketName = 'personal'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
# Windows 上 USERPROFILE 一定存在；这里兜底 HOME，便于在其它平台上演练/自测
$userHome = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { [Environment]::GetFolderPath('UserProfile') }
if (-not $userHome) { throw ' 无法确定用户主目录（USERPROFILE / HOME 均为空）。' }
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $userHome '.codex' }
$dest = Join-Path $codexHome "plugins\$pluginName"
$marketDir = Join-Path $userHome '.agents\plugins'
$marketFile = Join-Path $marketDir 'marketplace.json'
$configFile = Join-Path $codexHome 'config.toml'

# marketplace 里的 source.path 是相对用户主目录的，自定义 CODEX_HOME 时对不上
$codexHomeIsDefault = ($codexHome -eq (Join-Path $userHome '.codex'))

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text)   { Write-Host "    $Text" -ForegroundColor DarkGray }
function Write-Warn2([string]$Text){ Write-Host "    ! $Text" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 1. Node
Write-Step '检查 Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw ' 未找到 node。请先安装 Node.js 18+（https://nodejs.org），安装后重开终端。'
}
$nodeVersion = (& node --version).Trim()
if ($nodeVersion -match '^v(\d+)\.') {
  $nodeMajor = [int]$Matches[1]
  if ($nodeMajor -lt 18) {
    throw " Node.js $nodeVersion 过低。Codex Speed 需要 Node.js 18+。"
  }
} else {
  Write-Warn2 "无法解析 node 版本（$nodeVersion），继续安装；如运行失败请升级到 Node.js 18+。"
}
Write-Ok "node $nodeVersion ($($node.Source))"

# ---------------------------------------------------------------- 2. 复制
Write-Step "安装到 $dest"
if (Test-Path $dest) {
  if (-not $Force) {
    Write-Warn2 '目标目录已存在，将覆盖插件文件并保留 data 目录（要彻底重装加 -Force）。'
  } else {
    Write-Warn2 '目标目录已存在，-Force 会连 data 目录一起清空。'
  }
  $keep = if ($Force) { @() } else { @('data') }
  Get-ChildItem $dest -Force | Where-Object { $keep -notcontains $_.Name } | Remove-Item -Recurse -Force
} else {
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
}

$exclude = @('.git', 'node_modules', 'data', 'test', '.vscode', '.idea')
Get-ChildItem $src -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
  Copy-Item $_.FullName -Destination $dest -Recurse -Force
}
Write-Ok '插件文件已复制'

# ---------------------------------------------------------------- 3. marketplace
Write-Step "登记到个人 marketplace: $marketFile"
if (-not (Test-Path $marketDir)) { New-Item -ItemType Directory -Path $marketDir -Force | Out-Null }

$market = $null
$marketFileExisted = Test-Path $marketFile
if ($marketFileExisted) {
  try {
    $market = Get-Content $marketFile -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    $bak = "$marketFile.bak"
    Copy-Item $marketFile $bak -Force
    throw " 现有 marketplace.json 解析失败：$($_.Exception.Message)`n    已备份到 $bak，未修改 marketplace。请修复后重试。"
  }
}

if ($null -eq $market) {
  if ($marketFileExisted) {
    throw " marketplace.json 内容为空或为 null，未修改 marketplace。请修复后重试。"
  }
  $market = [pscustomobject]@{
    name = $marketName
    interface = [pscustomobject]@{ displayName = 'Personal' }
    plugins = @()
  }
} else {
  if ($market -isnot [pscustomobject]) {
    throw " marketplace.json 顶层必须是对象，当前是 $($market.GetType().Name)。请修复后重试。"
  }
  # 已存在 marketplace 时沿用它的名字：-Enable 写进 config.toml 的键是
  # "插件名@marketplace 名"，名字对不上就会写了也不生效
  if ($market.PSObject.Properties.Name -contains 'name' -and $market.name) {
    $marketName = [string]$market.name
  }
}
Write-Ok "marketplace 名称：$marketName"
if (-not $codexHomeIsDefault) {
  Write-Warn2 "CODEX_HOME 不是默认位置，但 marketplace 只支持相对用户主目录的路径。"
  Write-Warn2 "  当前会写成 ./.codex/plugins/$pluginName，指向 $(Join-Path $userHome ".codex\plugins\$pluginName")。"
  Write-Warn2 "  若要让桌面版找到它，请把插件也复制一份到该位置，或改用默认 CODEX_HOME 安装。"
}

# 统一成数组，便于追加
$existing = @()
if ($market.PSObject.Properties.Name -contains 'plugins' -and $market.plugins) {
  $existing = @($market.plugins)
}
$existing = $existing | Where-Object { $_.name -ne $pluginName }

$entry = [pscustomobject]@{
  name = $pluginName
  source = [pscustomobject]@{
    source = 'local'
    path = "./.codex/plugins/$pluginName"
  }
  policy = [pscustomobject]@{
    installation = 'AVAILABLE'
    authentication = 'ON_INSTALL'
  }
  category = 'Developer Tools'
}
$market.plugins = @($existing) + $entry

$json = $market | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($marketFile, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Ok "已写入 $marketFile"

# ---------------------------------------------------------------- 4. 启用
$pluginKey = "$pluginName@$marketName"
if ($Enable) {
  Write-Step "在 config.toml 中启用 $pluginKey"
  $key = "[plugins.`"$pluginKey`"]"
  $hadFile = Test-Path $configFile
  $hadBom = $false
  $content = ''
  if ($hadFile) {
    # 只为了判断有没有 BOM，不去改用户文件的编码风格
    try {
      $bytes = [System.IO.File]::ReadAllBytes($configFile)
      $hadBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    } catch { }
    $content = Get-Content $configFile -Raw -Encoding UTF8
    if ($null -eq $content) { $content = '' }
  }

  # TOML 的 table key 可以用双引号或单引号；只在双引号上做 substring 检测
  # 会漏掉合法写法，然后追加出重复 table，把用户配置写坏。
  $quotedKey = [regex]::Escape($pluginKey)
  $sectionPattern = "(?m)^[ \t]*\[[ \t]*plugins[ \t]*\.[ \t]*(?:`"$quotedKey`"|'$quotedKey')[ \t]*\](?:[ \t]*#[^\r\n]*)?(?=\r?$)"
  $sectionMatch = [regex]::Match($content, $sectionPattern)
  $changed = $false
  $message = ''

  if (-not $sectionMatch.Success) {
    # 用文件原有的换行风格，别把 CRLF 混进一个 LF 文件（有些 TOML 解析器会报错）
    $nl = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
    if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) { $content += $nl }
    if ($content.Length -gt 0 -and -not $content.EndsWith("$nl$nl")) { $content += $nl }
    $content += "$key$nl" + "enabled = true$nl"
    $changed = $true
    $message = '已写入'
  } else {
    # 只检查该 table 到下一个 [table] 之前的内容，避免误改别的插件
    $sectionStart = $sectionMatch.Index
    $afterHeader = $content.Substring($sectionStart + $sectionMatch.Length)
    $nextHeader = [regex]::Match($afterHeader, '(?m)^[ \t]*\[')
    $bodyLength = if ($nextHeader.Success) { $nextHeader.Index } else { $afterHeader.Length }
    $body = $afterHeader.Substring(0, $bodyLength)
    $enabledFalse = '(?m)^[ \t]*enabled[ \t]*=[ \t]*false[ \t]*(?:#[^\r\n]*)?(?=\r?$)'
    if ($body -match $enabledFalse) {
      $newBody = ([regex]$enabledFalse).Replace($body, 'enabled = true', 1)
      $content = $content.Substring(0, $sectionStart + $sectionMatch.Length) + $newBody + $afterHeader.Substring($bodyLength)
      $changed = $true
      $message = '已把该条目的 enabled 改为 true'
    } elseif ($body -notmatch '(?m)^[ \t]*enabled[ \t]*=') {
      # table 存在但没有 enabled 行：补一行，否则默认仍是未启用
      $nl = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
      $nlIndex = $body.IndexOf("`n")
      if ($nlIndex -ge 0) {
        $newBody = $body.Substring(0, $nlIndex + 1) + "enabled = true$nl" + $body.Substring($nlIndex + 1)
      } else {
        $newBody = $nl + "enabled = true" + $body
      }
      $content = $content.Substring(0, $sectionStart + $sectionMatch.Length) + $newBody + $afterHeader.Substring($bodyLength)
      $changed = $true
      $message = '已补充 enabled = true'
    } else {
      $message = 'config.toml 中已存在该条目'
    }
  }

  if ($changed) {
    if ($hadFile) {
      Copy-Item $configFile "$configFile.bak" -Force
    }
    [System.IO.File]::WriteAllText($configFile, $content, (New-Object System.Text.UTF8Encoding($hadBom)))
    Write-Ok "$message $configFile"
  } else {
    Write-Ok $message
  }
} else {
  Write-Ok "未自动启用。手动启用请在 config.toml 里加："
  Write-Ok "  [plugins.`"$pluginKey`"]`n  enabled = true"
}

Write-Host ''
Write-Host '完成。' -ForegroundColor Green
Write-Host '下一步：' -ForegroundColor Green
Write-Host '  1) 重启 ChatGPT / Codex 桌面应用（或 Codex CLI）。'
Write-Host '  2) 打开 Plugins 目录，在 Personal 里找到 “Codex Speed” 并安装/启用。'
Write-Host '  3) 新版 Codex 会注入 threadId，速度面板默认就按当前会话精确取数，不依赖 hooks。'
Write-Host '     如果使用旧版/特殊调用，可在 Settings -> Hooks 信任 Codex Speed 的'
Write-Host '     SessionStart / UserPromptSubmit / Stop 三条作为兜底。'
Write-Host '  4) 打开会话，点击右侧的「速度面板」标签页；或在会话里说“打开速度悬浮窗”。'
Write-Host ''
Write-Host "会话日志目录： $codexHome\sessions" -ForegroundColor DarkGray
Write-Host "插件数据目录： 由 Codex 注入的 PLUGIN_DATA 决定（get_reasoning_speed 返回 hud.dataDir）" -ForegroundColor DarkGray