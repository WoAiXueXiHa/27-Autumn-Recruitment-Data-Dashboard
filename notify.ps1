param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$Message
)

$notify = $null
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $notify = New-Object System.Windows.Forms.NotifyIcon
  $notify.Icon = [System.Drawing.SystemIcons]::Information
  $notify.Text = $Title
  $notify.BalloonTipTitle = $Title
  $notify.BalloonTipText = $Message
  $notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
  $notify.Visible = $true
  $notify.ShowBalloonTip(5000)
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::Out.WriteLine('{"ok":true,"method":"tray-balloon"}')
  Start-Sleep -Milliseconds 6000
} catch {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($null -ne $notify) {
    $notify.Visible = $false
    $notify.Dispose()
  }
}
