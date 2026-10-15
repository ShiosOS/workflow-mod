# A working Claude Code animates a glyph before its title, so titles are
# compared without leading marks.
param([int]$ProcessId, [switch]$DryRun)

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FocusTabNative {
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint GetConsoleTitle(StringBuilder title, uint size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
'@

$bare = { param($text) ($text -replace '^[^\p{L}\p{N}]+', '').Trim() }

[FocusTabNative]::FreeConsole() | Out-Null
if (-not [FocusTabNative]::AttachConsole([uint32]$ProcessId)) { exit 2 }
$buffer = New-Object System.Text.StringBuilder 1024
[FocusTabNative]::GetConsoleTitle($buffer, 1024) | Out-Null
[FocusTabNative]::FreeConsole() | Out-Null
$wanted = & $bare $buffer.ToString()
if ($DryRun) { Write-Output ("console title: " + $buffer.ToString()) }
if ($wanted -eq '') { exit 1 }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$auto = [System.Windows.Automation.AutomationElement]
$isTerminal = New-Object System.Windows.Automation.PropertyCondition($auto::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
$isTab = New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
foreach ($window in $auto::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $isTerminal)) {
  foreach ($tab in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $isTab)) {
    if ($DryRun) { Write-Output ("tab: " + $tab.Current.Name) }
    if ((& $bare $tab.Current.Name) -ne $wanted) { continue }
    if ($DryRun) { Write-Output ("match: " + $tab.Current.Name); exit 0 }
    $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
    $handle = [IntPtr]$window.Current.NativeWindowHandle
    if ([FocusTabNative]::IsIconic($handle)) { [FocusTabNative]::ShowWindow($handle, 9) | Out-Null }
    [FocusTabNative]::SetForegroundWindow($handle) | Out-Null
    exit 0
  }
}
exit 1
