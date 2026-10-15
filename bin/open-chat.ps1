# The tab inherits the launching session's environment; clear the variables
# that would make this claude act as that session's child.
$exe = if ($env:CLAUDE_CODE_EXECPATH) { $env:CLAUDE_CODE_EXECPATH } else { 'claude' }
@(
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_EFFORT', 'CLAUDE_CODE_EXECPATH'
) | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }

# A first prompt arrives as `--prompt-file <file>`, never on the command line,
# where Windows Terminal would split it at `;`.
$passed = [System.Collections.Generic.List[string]]::new()
for ($i = 0; $i -lt $args.Count; $i++) {
  if ($args[$i] -eq '--prompt-file' -and $i + 1 -lt $args.Count) {
    $file = $args[++$i]
    $passed.Add((Get-Content -LiteralPath $file -Raw -Encoding utf8).TrimEnd())
    Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue
  } else {
    $passed.Add([string]$args[$i])
  }
}
& $exe @passed
