param([int]$PrismProcessId, [int]$Seconds = 150)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$shell = New-Object -ComObject WScript.Shell
$until = (Get-Date).AddSeconds($Seconds)
$seen = @{}
while ((Get-Date) -lt $until) {
  if (-not (Get-Process -Id $PrismProcessId -ErrorAction SilentlyContinue)) { break }
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $PrismProcessId)))
  foreach ($window in $windows) {
    try {
      $title = $window.Current.Name -replace ' - Prism Launcher .*$', ''
      $buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Button)))
      $names = @($buttons | ForEach-Object { $_.Current.Name })
      $signature = $title + '|' + ($names -join ',')
      if (-not $seen.ContainsKey($signature)) {
        Write-Output ('UI ' + (@{title=$title;buttons=$names} | ConvertTo-Json -Compress))
        $seen[$signature] = $true
      }
      $wanted = $null
      if ($title -match 'Quick Setup') { $wanted = '^(Finish|&Finish)$' }
      elseif ($title -eq 'No Accounts') { $wanted = '^(&?No)$' }
      elseif ($title -eq 'Play demo?') { $wanted = '^Play Demo$' }
      elseif ($title -eq 'Player name') { $wanted = '^(&?OK)$' }
      if ($wanted) {
        $clicked = $false
        foreach ($button in $buttons) {
          if ($button.Current.Name -match $wanted -and $button.Current.IsEnabled) {
            $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $pattern.Invoke(); $clicked = $true
            Write-Output ('INVOKED ' + $title); break
          }
        }
        if (-not $clicked -and $shell.AppActivate($PrismProcessId)) {
          if ($title -match 'Quick Setup') { $shell.SendKeys('%f') }
          elseif ($title -eq 'No Accounts') { $shell.SendKeys('%n') }
          elseif ($title -eq 'Play demo?') { $shell.SendKeys('{LEFT}{ENTER}') }
          elseif ($title -eq 'Player name') { $shell.SendKeys('{ENTER}') }
        }
      }
    } catch { Write-Output ('UI unavailable: ' + $_.Exception.GetType().Name) }
  }
  Start-Sleep -Milliseconds 1000
}
