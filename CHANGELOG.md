# Changelog

**English** | [한국어](CHANGELOG.ko.md)

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
