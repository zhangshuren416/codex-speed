<#
.SYNOPSIS
  Codex Speed —— Windows 置顶悬浮窗（PowerShell 5.1 + WinForms，零额外依赖）。

.DESCRIPTION
  从本地 MCP server 的只读接口拉取速度数据并绘制。窗口无边框、可拖动、
  支持不透明度与缩放，右键菜单可切换置顶/透明度或关闭。Esc 也可关闭。

.PARAMETER Port
  本地数据接口端口（由 MCP server 传入）。

.PARAMETER Opacity
  窗口不透明度 0.2 - 1.0。

.PARAMETER Scale
  界面缩放 0.6 - 2.0。

.PARAMETER AlwaysOnTop
  是否置顶。

.PARAMETER PidFile
  运行期 PID 文件路径（由 MCP server 传入），用于让别的进程也能关掉本窗口。

.PARAMETER PortFile
  运行期端口文件路径。MCP server 重启后端口可能变化，HUD 会重读它来重连。
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [double]$Opacity = 0.92,
  [double]$Scale = 1.0,
  [switch]$AlwaysOnTop,
  [string]$PidFile = '',
  [string]$PortFile = ''
)

# 这个窗口完全依赖 WinForms + GDI+（System.Drawing.Common）。
# 只有 Windows PowerShell 5.1（Desktop 版）保证可用；在 pwsh Core / 非 Windows 上，
# 脚本里的 System.Drawing 类型在“脚本类型初始化”阶段就会失败，连第一行都执行不到，
# 错误信息是毫无帮助的 “An error occurred while creating the pipeline”。
# #Requires 由解析器在类型解析前检查，能给出可读的提示。
#Requires -PSEdition Desktop

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 高 DPI：不声明 DPI 感知的话，Windows 会把窗口整体拉伸，字会发虚
try {
  Add-Type -Namespace CodexSpeed -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
'@ -ErrorAction Stop
  [CodexSpeed.Native]::SetProcessDPIAware() | Out-Null
} catch { }
[System.Windows.Forms.Application]::EnableVisualStyles()

# ---------------------------------------------------------------- helpers
function Set-DoubleBuffered {
  param([System.Windows.Forms.Control]$Control)
  $flags = [System.Reflection.BindingFlags]'Instance,NonPublic'
  $prop = $Control.GetType().GetProperty('DoubleBuffered', $flags)
  if ($prop) { $prop.SetValue($Control, $true) }
}

# 已安装的字体族只枚举一次；直接 new Font('不存在的字体') 不会抛错，而是静默替换，
# 所以必须先查表。界面文案是中文，优先选带 CJK 字形的字体。
$script:fontFamilies = @()
try { $script:fontFamilies = @([System.Drawing.FontFamily]::Families | ForEach-Object { $_.Name }) } catch { }

function Get-UiFont {
  param([double]$Size, [string]$Style = 'Regular')
  $candidates = @('Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI Variable Text', 'Segoe UI')
  $styleValue = [System.Drawing.FontStyle]$Style
  foreach ($name in $candidates) {
    if ($script:fontFamilies -contains $name) {
      return New-Object System.Drawing.Font($name, [float]$Size, $styleValue, [System.Drawing.GraphicsUnit]::Point)
    }
  }
  return New-Object System.Drawing.Font([System.Drawing.FontFamily]::GenericSansSerif, [float]$Size, $styleValue)
}

function Get-MonoFont {
  param([double]$Size, [string]$Style = 'Bold')
  $styleValue = [System.Drawing.FontStyle]$Style
  foreach ($name in @('Cascadia Mono', 'Consolas', 'Lucida Console')) {
    if ($script:fontFamilies -contains $name) {
      return New-Object System.Drawing.Font($name, [float]$Size, $styleValue, [System.Drawing.GraphicsUnit]::Point)
    }
  }
  return Get-UiFont -Size $Size -Style $Style
}

# ---------------------------------------------------------------- palette
$colBg      = [System.Drawing.Color]::FromArgb(255, 18, 20, 24)
$colBorder  = [System.Drawing.Color]::FromArgb(255, 40, 45, 54)
$colText    = [System.Drawing.Color]::FromArgb(255, 232, 234, 237)
$colDim     = [System.Drawing.Color]::FromArgb(255, 138, 148, 163)
$colAccent  = [System.Drawing.Color]::FromArgb(255, 16, 163, 127)
$colWarn    = [System.Drawing.Color]::FromArgb(255, 232, 179, 75)

# ---------------------------------------------------------------- 端口重连
# MCP server 是随会话生灭的：用户关掉一个会话，server 就换了实例，端口可能落在
# 8787/8788/8789 中的另一个。HUD 要能自己找回新端口，否则会一直显示“未连接”。
function Update-BaseUrl {
  if ([string]::IsNullOrWhiteSpace($PortFile)) { return $false }
  try {
    if (-not (Test-Path $PortFile)) { return $false }
    $raw = Get-Content $PortFile -Raw -ErrorAction Stop
    $info = $raw | ConvertFrom-Json
    $newPort = [int]$info.port
    if ($newPort -le 0) { return $false }
    if ($newPort -eq $script:currentPort) { return $false }
    $script:currentPort = $newPort
    $script:baseUrl = "http://127.0.0.1:$newPort/api/speed"
    return $true
  } catch {
    return $false
  }
}

# ---------------------------------------------------------------- state
$script:pending    = $null
$script:client     = New-Object System.Net.WebClient
$script:client.Proxy = $null
$script:currentPort = $Port
$script:baseUrl    = "http://127.0.0.1:$Port/api/speed"
$script:data       = $null
$script:history    = New-Object 'System.Collections.Generic.List[double]'
$script:lastTick   = [DateTime]::MinValue
$script:lastSampleAt = [long]0
$script:lastSessionId = ''
$script:pendingSince = [DateTime]::UtcNow
$script:failCount  = 0

# ---------------------------------------------------------------- form
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition   = 'Manual'
$form.BackColor       = $colBg
$form.Text            = 'Codex Speed'
$form.ShowInTaskbar   = $false
$form.MinimizeBox     = $false
$form.MaximizeBox     = $false
$form.TopMost         = [bool]$AlwaysOnTop
$form.Opacity         = [Math]::Min(1.0, [Math]::Max(0.2, $Opacity))
$form.KeyPreview      = $true
# 布局全部由脚本按 DPI 手算，关闭 WinForms 自动缩放，避免字体被缩放两次
$form.AutoScaleMode   = 'None'

# 先创建句柄拿到实际 DPI：字体用 Point 会随 DPI 放大，窗口/边距/线宽也必须
# 按同样的比例放大；否则 125%–200% 缩放下内容会挤出窗口。
$form.CreateControl()
$dpiScale = 1.0
try {
  $dpiGraphics = $form.CreateGraphics()
  $dpiScale = [double]$dpiGraphics.DpiX / 96.0
  $dpiGraphics.Dispose()
} catch { }
if ($dpiScale -le 0) { $dpiScale = 1.0 }
$ui = [double]$Scale * $dpiScale
$w = [int](264 * $ui)
$h = [int](126 * $ui)
$margin = [int](24 * $dpiScale)
$form.Size = New-Object System.Drawing.Size($w, $h)

# 放到主屏右上角，留一点边距
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($screen.Right - $w - $margin), ($screen.Top + $margin))

$panel = New-Object System.Windows.Forms.Panel
$panel.Dock = 'Fill'
$panel.BackColor = $colBg
Set-DoubleBuffered -Control $panel
$form.Controls.Add($panel)

# ---------------------------------------------------------------- drag
$script:dragging = $false
$script:dragStart = New-Object System.Drawing.Point(0, 0)
$script:formStart = New-Object System.Drawing.Point(0, 0)

$panel.Add_MouseDown({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $script:dragging = $true
    $script:dragStart = [System.Windows.Forms.Cursor]::Position
    $script:formStart = $form.Location
    # 捕获鼠标：不捕获的话光标一旦移出窗口就收不到 MouseMove，拖动会在边缘卡住
    $panel.Capture = $true
    $form.Activate()
  }
})
$panel.Add_MouseMove({
  param($sender, $e)
  if ($script:dragging) {
    $now = [System.Windows.Forms.Cursor]::Position
    $dx = $now.X - $script:dragStart.X
    $dy = $now.Y - $script:dragStart.Y
    $form.Location = New-Object System.Drawing.Point(($script:formStart.X + $dx), ($script:formStart.Y + $dy))
  }
})
$panel.Add_MouseUp({
  param($sender, $e)
  $script:dragging = $false
  $panel.Capture = $false
})

# ---------------------------------------------------------------- context menu
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.RenderMode = 'System'

$miTop = New-Object System.Windows.Forms.ToolStripMenuItem('始终置顶')
$miTop.CheckOnClick = $true
$miTop.Checked = [bool]$AlwaysOnTop
$miTop.Add_Click({ $form.TopMost = $miTop.Checked })
$menu.Items.Add($miTop) | Out-Null

$miOpacity = New-Object System.Windows.Forms.ToolStripMenuItem('不透明度')
foreach ($pct in @(100, 90, 80, 60, 40)) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem("$pct%")
  $item.Tag = $pct
  $item.Add_Click({
    param($sender, $e)
    $form.Opacity = [double]$sender.Tag / 100.0
    foreach ($sib in $miOpacity.DropDownItems) { $sib.Checked = $false }
    $sender.Checked = $true
  })
  if ([Math]::Abs($form.Opacity * 100 - $pct) -lt 1) { $item.Checked = $true }
  $miOpacity.DropDownItems.Add($item) | Out-Null
}
$menu.Items.Add($miOpacity) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miReset = New-Object System.Windows.Forms.ToolStripMenuItem('重置位置')
$miReset.Add_Click({
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $form.Location = New-Object System.Drawing.Point(($area.Right - $form.Width - $margin), ($area.Top + $margin))
})
$menu.Items.Add($miReset) | Out-Null

$miClose = New-Object System.Windows.Forms.ToolStripMenuItem('关闭')
$miClose.Add_Click({ $form.Close() })
$menu.Items.Add($miClose) | Out-Null

$panel.ContextMenuStrip = $menu
$form.ContextMenuStrip = $menu

$form.Add_KeyDown({
  param($sender, $e)
  if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $form.Close() }
})

# ---------------------------------------------------------------- drawing
function Format-Compact {
  param([double]$Value)
  if ($Value -ge 1000000) { return ('{0:N1}M' -f ($Value / 1000000)) }
  if ($Value -ge 1000)    { return ('{0:N1}k' -f ($Value / 1000)) }
  return ('{0:N0}' -f $Value)
}

# ---------------------------------------------------------------- 字体与画刷缓存
# Paint 每秒触发一次；如果在 Paint 里 new Font/Brush 而不释放，GDI 句柄会持续增长
# （Windows 每进程默认 10000 个，大约十几分钟就会让绘制失败）。这里全部预先创建。
$script:fontCache = @{}
function Get-CachedFont {
  param([string]$Kind, [double]$Size, [string]$Style = 'Regular')
  $key = "$Kind|$Size|$Style"
  if (-not $script:fontCache.ContainsKey($key)) {
    if ($Kind -eq 'mono') { $script:fontCache[$key] = Get-MonoFont -Size $Size -Style $Style }
    else { $script:fontCache[$key] = Get-UiFont -Size $Size -Style $Style }
  }
  return $script:fontCache[$key]
}

$script:brushDim    = New-Object System.Drawing.SolidBrush($colDim)
$script:brushText   = New-Object System.Drawing.SolidBrush($colText)
$script:brushWarn   = New-Object System.Drawing.SolidBrush($colWarn)
$script:brushFaint  = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 96, 104, 116))
$script:penBorder   = New-Object System.Drawing.Pen($colBorder, 1)
$script:penEmpty    = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 32, 36, 42), 1)
$script:penAccent   = New-Object System.Drawing.Pen($colAccent, [float](1.6 * $ui))
$script:penAccent.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$script:brushFill   = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(34, $colAccent))
$script:brushBg     = New-Object System.Drawing.SolidBrush($colBg)

$panel.Add_Paint({
  param($sender, $e)
  # Paint 里的异常会弹错误对话框或让窗口白屏，整体兜住
  try {

  $g = $e.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  $W = $panel.ClientSize.Width
  $H = $panel.ClientSize.Height
  $pad = [int](12 * $ui)

  $g.FillRectangle($script:brushBg, 0, 0, $W, $H)
  $g.DrawRectangle($script:penBorder, 0, 0, $W - 1, $H - 1)

  $d = $script:data
  $ok = $false
  if ($d -ne $null -and $d.ok -eq $true) { $ok = $true }
  # 连续多次拉取失败（server 已退出）时不能再显示旧数字，否则看起来像实时数据
  $disconnected = $script:failCount -ge 3
  if ($disconnected) { $ok = $false }

  $brushDim = $script:brushDim
  $brushText = $script:brushText

  # ---- 第一行：标题 + 状态
  $fontLabel = Get-CachedFont -Kind ui -Size (8.5 * $Scale)
  $g.DrawString('CODEX SPEED', $fontLabel, $brushDim, [float]$pad, [float]($pad - 3))

  $statusText = '未连接'
  $statusColor = $colDim
  if ($ok) {
    if ([bool]$d.live.active) { $statusText = '生成中'; $statusColor = $colAccent }
    elseif ([bool]$d.live.stalled) { $statusText = '长时间无样本'; $statusColor = $colWarn }
    elseif ([bool]$d.live.waitingTool) { $statusText = '工具中'; $statusColor = $colWarn }
    elseif ([bool]$d.live.generating) { $statusText = '等待首字'; $statusColor = $colWarn }
    else { $statusText = '空闲'; $statusColor = $colDim }

    # 生成中把已等待秒数挂到状态上：token 只在响应结束后落盘，没有这个计数
    # 窗口看起来就像卡住了
    if ([bool]$d.live.active -and $d.live.generatingMs -ne $null) {
      $waited = [int]([double]$d.live.generatingMs / 1000)
      if ($waited -ge 1) { $statusText = "$statusText ${waited}s" }
    }
  } elseif ($d -ne $null -and $d.ok -eq $false) {
    $statusText = '等待会话'
  }

  $fontStatus = Get-CachedFont -Kind ui -Size (8.5 * $Scale) -Style 'Bold'
  $statusSize = $g.MeasureString($statusText, $fontStatus)
  $statusW = [int]([Math]::Ceiling($statusSize.Width) + 6 * $ui)
  $statusH = [int]([Math]::Max(14 * $dpiScale, [Math]::Ceiling($statusSize.Height) - 2 * $ui))
  $statusX = $W - $pad - $statusW
  $statusY = [int]($pad - 3 * $ui)

  $pillBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(38, $statusColor))
  $g.FillRectangle($pillBrush, $statusX, $statusY, $statusW, $statusH)
  $pillBrush.Dispose()
  $brushStatus = New-Object System.Drawing.SolidBrush($statusColor)
  $g.DrawString($statusText, $fontStatus, $brushStatus, [float]($statusX + 3 * $ui), [float]$statusY)
  $brushStatus.Dispose()

  # ---- 第二行：大号 tok/s
  $tpsText = '—'
  $tpsBrush = $brushText
  if ($ok) {
    $tpsText = ('{0:N1}' -f [double]$d.live.tokensPerSec)
    # 样本过期（例如会话已结束）时用暗色，避免把历史值误当成实时值
    if ([bool]$d.live.stale) { $tpsBrush = $brushDim }
  }
  $fontBig = Get-CachedFont -Kind mono -Size (30 * $Scale) -Style 'Bold'
  $bigY = [float]($pad + 14 * $ui)
  $g.DrawString($tpsText, $fontBig, $tpsBrush, [float]$pad, $bigY)
  $bigSize = $g.MeasureString($tpsText, $fontBig)

  $fontUnit = Get-CachedFont -Kind ui -Size (10 * $Scale)
  $g.DrawString('tok/s', $fontUnit, $brushDim, [float]($pad + $bigSize.Width - 6 * $ui), [float]($bigY + 26 * $ui))

  # ---- 第三行：本轮 / 推理占比
  $fontSmall = Get-CachedFont -Kind ui -Size (8.5 * $Scale)
  $lineY = [float]($bigY + 46 * $ui)

  $leftText = '本轮 —'
  $rightText = '推理 —'
  if ($ok) {
    $leftText = '本轮 ' + (Format-Compact -Value ([double]$d.turn.outputTokens)) + ' tok · ' + ('{0:N0}' -f [double]$d.turn.avgTokensPerSec) + ' t/s'
    $rightText = ('推理 {0:N0}%' -f ([double]$d.session.reasoningShare * 100))
  }
  $g.DrawString($leftText, $fontSmall, $brushDim, [float]$pad, $lineY)

  $rightSize = $g.MeasureString($rightText, $fontSmall)
  $g.DrawString($rightText, $fontSmall, $brushDim, [float]($W - $pad - $rightSize.Width), $lineY)

  # ---- 第四行：迷你速度曲线（每个点 = 一次响应）
  $sparkTop = [int]($lineY + 17 * $ui)
  $sparkH = $H - $sparkTop - $pad
  if ($sparkH -lt 8) { $sparkH = 8 }
  $sparkW = $W - $pad * 2

  $points = $script:history
  if ($points.Count -ge 2) {
    $max = 10.0
    foreach ($v in $points) { if ($v -gt $max) { $max = $v } }

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $n = $points.Count
    $prevX = 0.0
    $prevY = 0.0
    for ($i = 0; $i -lt $n; $i++) {
      $x = $pad + ($i / ($n - 1)) * $sparkW
      $y = $sparkTop + $sparkH - ($points[$i] / $max) * ($sparkH - 2) - 1
      if ($i -eq 0) { $path.AddLine([float]$x, [float]$y, [float]$x, [float]$y) }
      else { $path.AddLine([float]$prevX, [float]$prevY, [float]$x, [float]$y) }
      $prevX = $x; $prevY = $y
    }
    $g.DrawPath($script:penAccent, $path)

    # 曲线下方淡色填充
    $fillPath = $path.Clone()
    $fillPath.AddLine([float]($pad + $sparkW), [float]($sparkTop + $sparkH), [float]$pad, [float]($sparkTop + $sparkH))
    $fillPath.CloseFigure()
    $g.FillPath($script:brushFill, $fillPath)
    $fillPath.Dispose()
    $path.Dispose()
  } else {
    $g.DrawLine($script:penEmpty, $pad, ($sparkTop + $sparkH), ($pad + $sparkW), ($sparkTop + $sparkH))
  }

  # ---- 底部连接异常提示
  if (-not $ok) {
    $hint = ''
    if ($disconnected) {
      $hint = '连接中断，正在重连…'
    } elseif ($d -ne $null) {
      $hint = [string]$d.hint
      if ([string]::IsNullOrWhiteSpace($hint)) { $hint = [string]$d.reason }
    }
    if (-not [string]::IsNullOrWhiteSpace($hint)) {
      $fontHint = Get-CachedFont -Kind ui -Size (7.5 * $Scale)
      $g.DrawString($hint, $fontHint, $script:brushWarn, [float]$pad, [float]($sparkTop - 2 * $ui))
    }
  }

  } catch {
    # 绘制失败时至少把背景画出来，避免窗口上残留花屏
    try { $e.Graphics.Clear($colBg) } catch { }
  }
})

# ---------------------------------------------------------------- polling
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000

$timer.Add_Tick({
  $script:lastTick = [DateTime]::UtcNow
  # WinForms 的定时器回调里抛异常会弹“未处理异常”对话框甚至直接结束进程，
  # 这里整体兜住：宁可少刷一帧，也不能让悬浮窗崩掉
  try {

  # 非阻塞：检查上一次请求是否完成
  if ($script:pending -ne $null) {
    # server 换实例/端口迁移时请求可能永远挂着；超时后丢弃，否则窗口会一直停在旧数据
    if (-not $script:pending.IsCompleted -and ([DateTime]::UtcNow - $script:pendingSince).TotalSeconds -gt 5) {
      try { $script:pending.Dispose() } catch { }
      $script:pending = $null
      # WebClient 不支持取消，只能换一个新的，否则挂住的连接会越积越多
      try { $script:client.Dispose() } catch { }
      $script:client = New-Object System.Net.WebClient
      $script:client.Proxy = $null
      $script:failCount++
      $panel.Invalidate()
      return
    }
    if ($script:pending.IsCompleted) {
      $task = $script:pending
      $script:pending = $null
      try {
        $json = $task.Result
        $script:data = $json | ConvertFrom-Json
        $script:failCount = 0
        # 换会话后曲线要清空，否则上一个会话的速度点会混进来
        if ($script:data.ok -eq $true) {
          $sid = [string]$script:data.session.id
          if ($sid -ne $script:lastSessionId) {
            $script:lastSessionId = $sid
            $script:history.Clear()
            $script:lastSampleAt = [long]0
          }
        }
        # 曲线按“每次响应一个点”，而不是每秒一个点：
        # 速度值只在一次响应结束后才更新，按秒采样会得到一条无意义的直线
        if ($script:data.ok -eq $true -and $script:data.live.lastResponse -ne $null) {
          $sampleAt = [long]$script:data.live.lastResponse.atMs
          if ($sampleAt -ne $script:lastSampleAt) {
            $script:lastSampleAt = $sampleAt
            $script:history.Add([double]$script:data.live.lastResponse.tokensPerSec)
            while ($script:history.Count -gt 40) { $script:history.RemoveAt(0) }
          }
        }
      } catch {
        # 保留上一次数据，避免闪烁；但连续失败要如实显示“未连接”
        $script:failCount++
      }
      $panel.Invalidate()
    }
  } else {
    try {
      # 每次重新发起请求前检查端口文件：server 换实例时会写新端口
      Update-BaseUrl | Out-Null
      $script:pending = $script:client.DownloadStringTaskAsync($script:baseUrl)
      $script:pendingSince = [DateTime]::UtcNow
    } catch {
      $script:pending = $null
      $script:failCount++
    }
  }

  } catch {
    # 定时器回调里的任何异常都不能逃逸
    $script:failCount++
  }
})
$timer.Start()

$form.Add_FormClosed({
  $timer.Stop()
  if ($script:pending -ne $null) { try { $script:pending.Dispose() } catch { } }
  try { $script:client.Dispose() } catch { }
  foreach ($f in $script:fontCache.Values) { try { $f.Dispose() } catch { } }
  foreach ($o in @($script:brushDim, $script:brushText, $script:brushWarn, $script:brushFaint,
                   $script:penBorder, $script:penEmpty, $script:penAccent, $script:brushFill, $script:brushBg)) {
    try { $o.Dispose() } catch { }
  }
  if ($PidFile -and (Test-Path $PidFile)) { try { Remove-Item $PidFile -Force } catch { } }
})

# 写 PID 文件：HUD 是独立进程，只靠 MCP server 的 child 句柄判断存活并不够
# （server 重启后句柄就丢了），用 PID 文件才能可靠地“找到并关掉已经开着的窗口”。
if ($PidFile) {
  try { [System.IO.File]::WriteAllText($PidFile, [string]$PID) } catch { }
}

# 首次拉取后显示
Update-BaseUrl | Out-Null
$script:pending = $script:client.DownloadStringTaskAsync($script:baseUrl)

[System.Windows.Forms.Application]::Run($form)