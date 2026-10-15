$p = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
for ($i = 0; $p -and $p.Name -ne 'WindowsTerminal.exe' -and $i -lt 32; $i++) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"
}
$terminal = if ($p -and $p.Name -eq 'WindowsTerminal.exe') { $p.ExecutablePath } else { '' }
$pwsh = [bool](Get-Command pwsh.exe -ErrorAction SilentlyContinue)
@{ terminal = $terminal; pwsh = $pwsh } | ConvertTo-Json -Compress
