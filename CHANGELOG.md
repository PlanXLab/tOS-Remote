# Changelog

**English** | [한국어](CHANGELOG.ko.md)

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
