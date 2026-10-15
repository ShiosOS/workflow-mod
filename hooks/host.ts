import type { EngineInterface, RenderSurface } from 'claude-code'

import type { Chat } from '../types'
import { parseAgents } from './parse'
import type { AgentRow } from './parse'
import { joinPath, toNativePath } from './paths'
import { clip } from './text'

export async function claudeDir($: EngineInterface) {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured !== undefined && configured !== '') return configured
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return joinPath(home, '.claude')
}

async function claudeExe($: EngineInterface) {
  return (await $.env.get('CLAUDE_CODE_EXECPATH')) ?? 'claude'
}

async function isWindows($: EngineInterface) {
  return (await $.env.get('OS')) === 'Windows_NT'
}

async function isWindowsTerminal($: EngineInterface) {
  return (await $.env.get('WT_SESSION')) !== undefined
}

export function say($: EngineInterface, text: string) {
  $.ui.toast(text, { timeoutMs: 6000 })
}

export async function listAgents($: EngineInterface): Promise<AgentRow[]> {
  const ran = await $.process
    .run([await claudeExe($), 'agents', '--json'], { timeoutMs: 15_000 })
    .catch(() => null)
  return ran?.exitCode === 0 ? parseAgents(ran.stdout) : []
}

function scriptPath($: EngineInterface, name: string) {
  return toNativePath(joinPath($.plugin.root, 'bin', name))
}

type Host = { wt: string; shell: string }
let host: Promise<Host> | null = null

// Another install's wt.exe (a portable copy first on PATH) cannot add a tab
// here and opens a window.
async function findHost($: EngineInterface): Promise<Host> {
  const ran = await $.process
    .run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath($, 'find-host.ps1')], { timeoutMs: 20_000 })
    .catch(() => null)
  let found: { terminal?: unknown; pwsh?: unknown } = {}
  try {
    found = ran?.exitCode === 0 ? JSON.parse(ran.stdout) : {}
  } catch {
  }
  const shell = found.pwsh === true ? 'pwsh.exe' : 'powershell.exe'
  const terminal = typeof found.terminal === 'string' ? found.terminal : ''
  if (terminal === '') return { wt: 'wt', shell }
  if (/\\WindowsApps\\/i.test(terminal)) {
    // A Store install runs only through its app alias.
    const local = await $.env.get('LOCALAPPDATA')
    return { wt: local === undefined ? 'wt' : joinPath(local, 'Microsoft', 'WindowsApps', 'wt.exe'), shell }
  }
  return { wt: terminal.replace(/WindowsTerminal\.exe$/i, 'wt.exe'), shell }
}

export function hostOf($: EngineInterface) {
  return (host ??= findHost($))
}

export async function runScript($: EngineInterface, name: string, args: string[], timeoutMs = 60_000) {
  const { shell } = await hostOf($)
  return $.process
    .run([shell, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath($, name), ...args], { timeoutMs })
    .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))
}

export async function launch(
  $: EngineInterface,
  cwd: string,
  title: string,
  args: string[],
  surface: RenderSurface,
  prompt = '',
) {
  const name = clip(title.replace(/[;"]/g, ' '), 40)
  if ((await isWindowsTerminal($)) && (await openTab($, cwd, name, args, prompt))) return
  const command = ['cd', `"${cwd}"`, '&&', 'claude', ...args, ...(prompt === '' ? [] : [JSON.stringify(prompt)])].join(' ')
  const copied = await $.ui.copy({ text: command, surface })
  say($, copied.isCopied ? `Copied; paste in a new terminal: ${command}` : `Run in a new terminal: ${command}`)
}

async function openTab($: EngineInterface, cwd: string, name: string, args: string[], prompt: string) {
  say($, `Opening "${name}"…`)
  const { wt, shell } = await hostOf($)
  const profile = await $.env.get('WT_PROFILE_ID')
  // A prompt rides in a file the launcher reads and drops: on the command
  // line Windows Terminal would split it at every `;`.
  const promptFile = prompt === ''
    ? null
    : joinPath(await claudeDir($), 'worktrees-mod', 'prompts', `${await $.clock.now()}.txt`)
  if (promptFile !== null) await $.fs.write(promptFile, prompt)
  const ran = await $.process
    .run([
      wt, '-w', '0', 'new-tab',
      ...(profile === undefined ? [] : ['-p', profile]),
      '-d', cwd, '--title', name,
      shell, '-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptPath($, 'open-chat.ps1'), ...args,
      ...(promptFile === null ? [] : ['--prompt-file', toNativePath(promptFile)]),
    ])
    .catch((error: unknown) => ({ exitCode: -1, stderr: String(error) }))
  if (ran.exitCode !== 0) {
    $.ui.log(`worktrees: ${wt} failed (${ran.exitCode}): ${ran.stderr.trim()}`)
    return false
  }
  say($, `Opened "${name}" in a new tab.`)
  return true
}

export async function focusTab($: EngineInterface, pid: number) {
  if (!(await isWindowsTerminal($))) return false
  const ran = await runScript($, 'focus-tab.ps1', ['-ProcessId', String(pid)], 20_000)
  return ran.exitCode === 0
}

export async function stopChat($: EngineInterface, chat: Chat) {
  const live = chat.live
  if (live === null || chat.signal === 'here') return false
  const argv = live.kind === 'background' && live.jobId !== null
    ? [await claudeExe($), 'stop', live.jobId]
    : live.pid === null
      ? null
      : (await isWindows($))
        ? ['taskkill', '/PID', String(live.pid), '/T', '/F']
        : ['kill', String(live.pid)]
  if (argv === null) return false
  const ran = await $.process.run(argv, { timeoutMs: 30_000 }).catch(() => null)
  return ran?.exitCode === 0
}

// Explorer exits non-zero even when it opened what it was given, so it is not
// asked how it went.
export async function openExternally($: EngineInterface, target: string) {
  if (await isWindows($)) {
    await $.process.run(['explorer.exe', target]).catch(() => null)
    return
  }
  const opened = await $.process.run(['open', target]).catch(() => null)
  if (opened?.exitCode !== 0) await $.process.run(['xdg-open', target]).catch(() => null)
}
