param([string]$Path, [string]$Line)
[IO.File]::AppendAllText($Path, $Line + "`n")
