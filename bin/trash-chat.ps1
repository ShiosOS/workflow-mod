param([string]$Transcript, [string]$Trash)
New-Item -ItemType Directory -Force -Path $Trash | Out-Null
$sessionFolder = [IO.Path]::ChangeExtension($Transcript, $null).TrimEnd('.')
Move-Item -LiteralPath $Transcript -Destination $Trash -Force
if (Test-Path -LiteralPath $sessionFolder -PathType Container) {
  Move-Item -LiteralPath $sessionFolder -Destination $Trash -Force
}
