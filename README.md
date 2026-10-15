# Workflow Mod

A Claude Code mod that puts Git worktrees, Claude chats, and GitHub pull request status in one pane. The plugin is named `worktrees`, and its command is `/worktrees`.

Use it to switch between active chats, resume older sessions, create workspaces, and see which chats need your attention.

## Requirements

- A current [Claude Code](https://code.claude.com/docs/en/overview) installation, signed in. Mods are enabled by default in the terminal starting with **Claude Code 2.1.287**. This repository does not declare a tested minimum version beyond requiring the mod APIs.
- **Git** available on your `PATH`.
- For the full experience: **Windows Terminal** and **Windows PowerShell** (`powershell.exe`). PowerShell 7 (`pwsh.exe`) is used for launching chats when available.
- Optional: the [GitHub CLI](https://cli.github.com/) (`gh`), authenticated to an account with access to your repositories, for PR status.

The pane renders in Claude Code's terminal and desktop surfaces. Automatic tab opening and focusing use Windows Terminal. On other platforms, launching a chat falls back to copying or showing a terminal command; transcript deletion and renaming closed chats also use Windows-specific scripts.

## Install on Windows

Run these commands in **PowerShell inside Windows Terminal**. The examples assume Claude Code's default configuration directory.

### 1. Clone the plugin

Claude Code loads folders containing `.claude-plugin/plugin.json` from your personal `~/.claude/skills/` directory. Clone this repository there:

```powershell
$pluginPath = Join-Path $env:USERPROFILE ".claude\skills\worktrees"
New-Item -ItemType Directory -Force -Path (Split-Path $pluginPath) | Out-Null
git clone https://github.com/ShiosOS/workflow-mod.git "$pluginPath"
claude plugin validate "$pluginPath"
```

If the repository is private, your GitHub account must have access and Git must be authenticated. If the destination already exists, use the update instructions below.

Keep the complete repository together, including `.claude-plugin/`, `hooks/`, `bin/`, and `types/`. The mod runs through Claude Code; there is no `npm install` or separate build step.

### 2. Start Claude Code in your project

Replace the example path with an existing Git repository:

```powershell
Set-Location "C:\path\to\your-project"
claude
```

Start a fresh session after installing. Inside Claude Code, enter:

```text
/worktrees
```

The **Worktrees** pane opens and includes the current repository. Click inside the pane before using its keyboard controls.

### Alternative: load it for one session

You can keep the clone elsewhere and load it explicitly. From the project you want to work in, run:

```powershell
claude --plugin-dir "C:\path\to\workflow-mod"
```

Point to the repository root containing `.claude-plugin/`. Repeat the flag each time you start a session this way. Chats launched by the mod do not explicitly receive this flag, so the personal-directory installation above is more convenient for using the pane across tabs.

These loading methods follow the [official local-plugin documentation](https://code.claude.com/docs/en/plugins/create#develop-without-a-marketplace). This repository currently has no marketplace manifest.

## Optional: enable GitHub PR status

Install `gh`, then authenticate from your terminal:

```powershell
gh auth login
gh auth status
```

The mod reads each project's `origin` remote and uses `gh api graphql` to look up pull requests by branch. GitHub.com remotes are supported. Without `gh` or access to the repository, the worktree and chat features still work, but PR information may be unavailable.

PR rows show review status, CI status, comments, and unresolved review threads. PR results are cached for two minutes; use **R** in the pane for a manual refresh.

## Use the pane

Add another Git repository:

```text
/worktrees add "C:\repos\another-project"
```

Remove an added repository from the list:

```text
/worktrees remove "C:\repos\another-project"
```

Removing a project from the list does not delete its files. The current repository is included automatically.

| Key | Action |
| --- | --- |
| `j` / `k`, or Down / Up | Move through the list |
| `h` / `l`, or Left / Right | Fold, unfold, or navigate the tree |
| Enter / `o` | Activate the selected row |
| `a` | Create a workspace |
| `n` | Start a new chat in the selected worktree |
| `r` | Rename a chat or workspace |
| `d` | Open the removal confirmation |
| `m` or right-click | Open the context menu |
| `P` | Add a project |
| `R` | Refresh the pane and PR information |
| `q` | Close the pane |

The context menu also offers folder opening, resume-command copying, merged-workspace cleanup, and pruning missing worktrees. Workspace removal can stop running chats; the discard-changes option can remove uncommitted work. Review the confirmation before continuing.

## Update

Pull changes into the same clone:

```powershell
$pluginPath = Join-Path $env:USERPROFILE ".claude\skills\worktrees"
git -C "$pluginPath" pull --ff-only
claude plugin validate "$pluginPath"
```

Restart your Claude Code session to load the updated code.

## Troubleshooting

- **`/worktrees` is missing:** check `claude --version`, start a fresh session, and inspect the Errors tab in `/plugin`. Confirm that the plugin root contains `.claude-plugin/plugin.json` and `hooks/hooks.json`. Mod availability can also be restricted by your organization's settings; see [mod loading controls](https://code.claude.com/docs/en/plugins/mods/overview#turn-mods-on-or-off).
- **The pane is behind another pane:** select its Worktrees tab, or run `/worktrees` again.
- **No repositories appear:** start Claude Code inside a Git repository, or add one with `/worktrees add`.
- **A chat does not open in a new tab:** run Claude Code inside Windows Terminal and check that `powershell.exe` is available. Outside Windows Terminal, follow the command the mod copies or displays.
- **PR information is missing:** check `gh auth status` and `git remote get-url origin` from the project. The mod skips PR lookup for shared branches named `main`, `master`, `develop`, and `trunk`.
- **Chat history is missing:** the mod reads the local Claude configuration directory, including `projects/` and `history.jsonl`. It honors `CLAUDE_CONFIG_DIR` when reading those files.

## Validate and run the existing tests

From the plugin's repository root, with a compatible Claude Code installation:

```powershell
claude plugin validate .
claude plugin test .
```

The tests use Claude Code's own `claude-code/testing` runtime. See the [official plugin command reference](https://code.claude.com/docs/en/plugins/cli-reference).

## Stop loading the mod

For a one-session load, start Claude Code without `--plugin-dir`. For the personal-directory installation, close affected sessions and move the `worktrees` folder outside `~/.claude/skills/`, then start a fresh session.
