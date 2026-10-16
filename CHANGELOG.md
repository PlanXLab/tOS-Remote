# Changelog

**English** | [한국어](CHANGELOG.ko.md)

## 0.6.1

- **Remote debugging lifecycle**: Disconnecting leaves the remote process running, and Restart prepares a new debuggee if the previous process has exited.
- **Cross-window workspace status**: Closing the remote workspace updates its state in other VS Code windows.

## 0.6.0

- **Cross-platform support**: tOS Remote now runs on Windows, Linux, and macOS (x64/arm64), using each platform's OpenSSH client, password helper, and terminal scripts.
- **Use the host's package tools**: an installed supported rclone is reused; otherwise the extension tries winget/Scoop/Chocolatey, Homebrew/MacPorts, or common Linux package managers, then offers the SHA-256-verified official binary if needed. Existing uv installations on `PATH` or in `~/.local/bin` are also reused; the downloaded uv fallback now matches the host OS and architecture.
- **Platform-specific cache locations**: rclone and Python package caches now use the standard user cache directory on each OS.
- **Cross-platform regression tests**: CI checks real rclone/uv downloads, executable permissions, and SFTP synchronization on Windows, Linux, and macOS before packaging.

## 0.5.2

- **Jupyter extension is optional**: It is no longer recommended automatically; install it only when you want to use Jupyter cells.
- **Safe window switching**: If the remote workspace is already open in another window, the extension opens the window switcher instead of replacing the current folder.
- **Jupyter kernel selected automatically**: In the remote workspace window, opening a notebook or a Python file with `#%%` cells starts Jupyter on the board (when it is installed) and selects the board's kernel, so you no longer need **Select Another Kernel > tOS Remote > Python 3 (ipykernel)** every time. The first time on each board, the board's kernel list appears once; your choice is remembered. Interactive windows reuse the board kernel because the server is already running when they open. New setting `tosRemote.jupyterAutoSelectKernel` (default `true`).
- **Getting Started matches the current setup**:
  - The WinFsp step is removed; WinFsp is no longer installed or checked (the **Install WinFsp** command is removed too).
  - Steps are checked from the actual state, without **Mark Done**: rclone installed, connection verified (a successful connection test, a working SSH key, or a workspace that has been opened), SSH key registered, and remote workspace opened. The results are kept across VS Code restarts.

## 0.5.1

- **Remote terminal on open**: When the remote workspace window opens and VS Code restores terminals from an earlier session (or creates one automatically), those local Windows terminals are replaced with the tOS SSH terminal. Only one board connection is opened, and Run on tOS task terminals are left alone. Local terminals that you open yourself afterwards are not changed.

## 0.5.0

- **Choose the window**: When opening the remote workspace, choose **Current Window** or **New Window**, so you can keep working in the window you already have open.
- **Two-way sync**: Changes made outside VS Code are now synchronized too. Files and folders (including empty folders) created, changed, or deleted in Windows Explorer are sent to the board, and changes made on the board (for example, in the remote terminal) appear locally within a few seconds. If the same file changes on both sides, the more recently modified copy wins.
- **Run on tOS**: Starts faster (only the file being run and pending changes are uploaded first, without rescanning the whole workspace). When the program exits, the terminal shows a termination message and waits for a key press.
- **Debug on tOS**: A notification shows that debugging is being prepared, so it is clear the request was received.
- **Fewer notifications**: Jupyter installation prompts no longer appear on their own; install Jupyter from the panel when you need it. The "unmet dependencies" warning after installing board tools is now written to the log only.

## 0.4.0

- **Hybrid Architecture (Local Workspace + Instant SFTP Sync)**:
  - Eliminated the WinFsp virtual drive mount dependency. Files are stored directly on your PC's local SSD for lightning-fast Pylance indexing and responsive editor operations without Dropbear/SFTP bottlenecks or Explorer freezes.
  - User-specifiable local workspace path (`tosRemote.localWorkspace`): prompt to select a folder on first open or configure via panel / settings.
  - Automatic initial pull on connection and debounced (200ms) background upload on save via `rclone rcd operations/copyfile`.
  - Reliable pre-run sync: `F5` (debug) and `Ctrl+F5` (run) flush pending uploads to the board before starting remote execution.
  - Added **Pull from Board** command (`tosRemote.refreshDrive`) to pull board-side modifications into the local copy.
  - Remote debugging binds debugpy to `127.0.0.1` on the board with SSH port forwarding (`-L`), improving network security.
  - WinFsp is no longer a prerequisite for opening remote workspaces.

## 0.3.0

- **Board tools**: Installs `debugpy` and `jupyter_server` + `ipykernel` into the board's global Python environment from the panel (**Board Tools**) or commands when they are missing. Nothing is installed if they are already there.
  - The board does not need internet access. Your PC resolves the packages for the board's Python version (3.x) and platform with uv, downloads them from PyPI (SHA-256 verified), copies them to a temporary folder on the board, and installs them with `sudo pip install`.
  - Package versions already on the board are kept, and only the missing packages are downloaded.
  - The sudo password is taken from the saved board password, or asked for when it is missing or not accepted.
  - `/usr/local/bin/run_debug.sh` is created with execute permission if it does not exist.
  - New setting `tosRemote.packageExcludeNewer`: install the versions available on a given date (identical versions on all boards in a class).
  - uv is downloaded from PyPI and verified with SHA-256 the first time it is needed (shown in Prerequisites).
- **Jupyter cells on the board**: Starts a Jupyter server on the board in the background (`127.0.0.1`, token), connects to it through SSH port forwarding, and registers it in the Jupyter extension's kernel picker as **tOS Remote**. `#%%` cells in Python files and notebooks run on the board.
  - Start and stop, server log, automatic reconnection when the forwarding drops, and reconnection to a running server when the window opens again
  - The server stops when you close the remote workspace; idle kernels and the server shut themselves down after an hour
  - The status bar shows when the server is running
- **Cleaner Run on tOS output**: The terminal no longer shows the ssh command line or the task messages (`Executing task ...`, `Terminal will be reused ...`, exit code messages); it shows only the program's output. Only a lost connection is reported in one line.
- **Debugging**: If debugpy is not installed on the board, `F5` offers to install it and then starts debugging.
- **Password authentication**: Remote debugging (F5), board tools, Jupyter, and Python library path detection now work with the saved password (an SSH_ASKPASS helper; the password is never put on a command line or in environment variables).
- The Jupyter extension is added to the workspace's recommended extensions.

## 0.2.1

- Workspace path is now relative to the user's home directory: the panel shows `/home/<user>/` automatically from the user account, and you enter only the rest (default `Workspace`). Paths outside the home directory and `.`/`..` segments are rejected.
- If the workspace folder does not exist, it is created on the board (including intermediate folders) when the workspace opens, with a clear message on permission errors.
- Existing settings in the old absolute form (`/home/<user>/Workspace`) are converted automatically.
- Development: `scripts/build-vsix.ps1` now creates `*-local.vsix` for local testing only (its manifest is not accepted by the Marketplace); Marketplace packages are built with `vsce`.

## 0.2.0

- Renamed the extension: **tOS-Lite Remote → tOS Remote**
  - Extension ID `PlanXLab.tos-lite-remote` → `PlanXLab.tos-remote` (installed as a new extension)
  - Setting keys `tosLite.*` → `tosRemote.*`, debug type `tos-lite` → `tos-remote`
  - Settings, saved passwords, and rclone from the previous extension are not carried over. The board defaults (192.168.254.1, tos) are unchanged.
- Renamed commands: **Run on Board / Debug on Board → Run on tOS / Debug on tOS**
- Display languages: English (default) and Korean. Korean is shown only when the VS Code display language is Korean.
  - Manifest (`package.nls.json`, `package.nls.ko.json`), runtime messages (`l10n/bundle.l10n.ko.json`), sidebar panel, walkthrough pages (`media/walkthrough`, `media/walkthrough/ko`), and SSH terminal messages
  - Logs in the Output panel are written in English only
- The sidebar panel status card now shows three lines: user and IP / workspace → virtual drive / authentication
- Removed rclone updates: once installed, rclone is not downloaded again, and the panel no longer shows an update link
- The extension Details and Changelog documents are now in English by default, with separate Korean documents (`README.ko.md`, `CHANGELOG.ko.md`)
- Marketplace metadata: GPL-3.0-or-later license, icon, and GitHub repository (github.com/PlanXLab/tOS-Remote)

## 0.1.2

- Run button (top right of the editor): reordered so that **Run on Board** is the default item (previously the Python extension's local `Run Python File` could appear first)
- Added **Debug on Board** to the Run button menu (always debugs on the board, regardless of the selected launch configuration)
- Verified with integration tests that `Ctrl+F5` (Run Without Debugging) runs directly on the board

## 0.1.1

- SSH terminal: fixed the `ssh.exe ... terminated with exit code: 255` notification when opening the workspace
  - Retries automatically up to 3 times when the connection fails; a final failure is shown in the terminal instead of a notification
  - No notification for the remote shell's exit code (for example, 1 after `exit`) when a session ends
- Python library sync
  - Global paths are required; `~/.local` and workspace virtual environments are optional (no notification when optional paths are missing or fail)
  - Detects and syncs virtual environments (`pyvenv.cfg`) in the workspace; manual sync detects them again
  - Merges paths that point to the same folder through symbolic links to avoid duplicate syncs
  - Limits concurrent SSH connections (up to 4) and starts 15 seconds after the workspace opens
- Sidebar panel: fixed rclone briefly showing "Download" every time a new window opened (shows the last check result and a checking indicator)

## 0.1.0

- Initial release
- Open/close the remote workspace (rclone rcd + WinFsp mount, one window only, mount kept after VS Code exits)
- Sidebar panel, status bar, and Getting Started walkthrough
- Automatic download of the latest rclone (SHA-256 verified) and WinFsp installation with winget
- SSH key registration and password storage in secret storage
- SSH terminal, run on board (Ctrl+F5), and debugpy remote debugging (F5)
- Terminal path links (merged from the former tOS-Lite Remote Path Link extension)
- Local Python library cache (Pylance), connection watchdog, and automatic reconnection
