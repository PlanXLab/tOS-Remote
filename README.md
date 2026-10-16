# tOS Remote

**English** | [한국어](README.ko.md)

A VS Code extension for opening the workspace of a tOS (tOS-Lite, Raspberry Pi 5) board from VS Code on your PC, and for editing, running, and debugging vision inference code on it. Jupyter cells (`#%%` in Python files and notebooks) also run on the board.

Nothing is installed on the board for VS Code: no VS Code Server is needed. The extension uses only the Dropbear SSH (SFTP) server already running on the board, so it uses no extra memory on the board.

## Features

- **Open/close the remote workspace**: Connects the board's working folder (default `/home/tos/Workspace`) as a Windows drive and opens it in a VS Code window.
- **Sidebar panel**: Board host, user, and path settings, connection test, SSH key registration, prerequisites (WinFsp, rclone, OpenSSH, uv), board tools (debugpy, Jupyter), and tools.
- **Getting Started walkthrough**: Guides you step by step: install WinFsp → install rclone → board settings → register an SSH key → open the workspace.
- **SSH terminal**: The default terminal of the workspace opens a shell on the board.
- **Run/debug** (for Python files in the remote workspace window)

  | Action | How |
  |---|---|
  | Debug on tOS | `F5`, or **Debug on tOS** in the Run button menu |
  | Run on tOS (without the debugger) | `Ctrl+F5`, or the Run button at the top right of the editor (**Run on tOS**) |

  - Output appears in the `Run on tOS: <file>` task in the terminal panel. The file is saved and its upload to the board is completed before it runs.
  - The terminal shows only the program's output. The ssh command line and the task messages are not shown; only a lost connection is reported in one line.
  - If `debugpy` is not installed on the board, `F5` offers to install it (see **Board tools**) and then starts debugging.
  - `Run Python File` in the Run button menu (from the Python extension) runs with the local Python on your PC, so do not use it in the remote workspace. The Run button remembers the last item you chose.
  - You do not need `Ctrl+Shift+B` (build task) to run on tOS.
- **Board tools**: Installs `debugpy` (remote debugging) and `jupyter_server` + `ipykernel` (Jupyter) into the board's global Python environment when they are missing. Nothing is installed if they are already there.
  - The board does not need internet access. Your PC resolves the packages for the board's Python version and platform with [uv](https://docs.astral.sh/uv/), downloads them from PyPI (SHA-256 verified), copies them to a temporary folder on the board, and installs them with `sudo pip install` (on tOS, `pip` installs into the global environment with uv). The temporary folder is deleted afterwards.
  - Any Python 3 version on the board works as long as the packages support it (checked with Python 3.8 to 3.14).
  - The sudo password is taken from the saved board password, or asked for when needed. It is sent only inside the script given to the board over SSH, never on a command line or in a log.
  - `/usr/local/bin/run_debug.sh` (the debugpy launcher of the tOS image) is created with execute permission if it does not exist. An existing file is not changed.
- **Jupyter on the board**: Starts a Jupyter server on the board in the background (listening only on `127.0.0.1`, with a token), forwards it to your PC over SSH, and adds it to the Jupyter extension's kernel picker as **tOS Remote**. Cells (`#%%` in Python files, notebooks) then run on the board, keeping their state between cells.
- **Terminal path links**: `Ctrl+click` a `/home/tos/Workspace/...` path printed in the terminal (Python traceback, gcc, and pdb formats) to open that line in the local file. Board site-packages paths open the local cached copy.
- **IntelliSense**: Only the `.py`/`.pyi` files of the board's Python packages are copied locally for Pylance.
  - The global site-packages (`/var/lib/tos/...`) are **required**; a notification is shown if syncing them fails.
  - `~/.local` user packages and virtual environments in the workspace (folders with `pyvenv.cfg`, such as those created by `uv venv`, up to two levels deep) are **optional**; if they are missing or fail to sync, this is only logged.
  - Virtual environments created while you work are detected again when you select **Sync Python Libraries** in the panel.
- **Connection watchdog**: If rclone exits or the mount is lost, the extension reconnects automatically on the same drive.
- **Robust SSH terminal**: If the connection fails, it retries up to 3 times at 2-second intervals. No notification is shown for the remote shell's exit code when a session ends.
- **Display language**: Korean when the VS Code display language is Korean; English otherwise (only English and Korean are supported). To use Korean, install the Korean Language Pack and set VS Code's display language to Korean. Logs in the Output panel are written in English only. The Details and Changelog tabs of the extension page are always shown in English (`README.md`, `CHANGELOG.md`) because VS Code does not support per-language documents; the Korean versions are `README.ko.md` and `CHANGELOG.ko.md`.

## Requirements

| Item | Description |
|---|---|
| Windows 10/11 (x64, arm64) | Only Windows is supported for now. |
| [WinFsp](https://winfsp.dev) | Virtual drive. Install it with `winget` from the panel or the walkthrough (administrator approval required). |
| OpenSSH client | Included with Windows (`C:\Windows\System32\OpenSSH\ssh.exe`). |
| [rclone](https://rclone.org) | The extension downloads the latest version on first use and verifies its SHA-256. Once installed, it is not downloaded again or updated. For offline use, set `tosRemote.rclonePath`. |
| Python Debugger extension (`ms-python.debugpy`) | Required for remote debugging (F5). |
| Jupyter extension (`ms-toolsai.jupyter`) | Required to run Jupyter cells on the board. |
| [uv](https://docs.astral.sh/uv/) | Needed only to install board tools. Downloaded from PyPI (SHA-256 verified) the first time you install board tools (about 15 MB). The first resolution also downloads a Python runtime for uv (about 21 MB). Your PC must be online when installing board tools. |
| `debugpy`, `jupyter_server`, `ipykernel` on the board | Installed from the panel (**Board Tools**) if missing. |

## Usage

1. After installation, the **Getting Started** walkthrough opens. If you closed it, run `tOS: Getting Started` from the Command Palette.
2. Select the **tOS Remote** icon in the activity bar, check the board host, user, and workspace folder, then select **Test Connection**.
   - The workspace is always under the user's home directory, because the user has full access only there. /home/<user>/ is shown automatically from the **User** field; enter only the rest (for example Workspace or class/vision). The folder, including intermediate folders, is created on the board when you open the workspace if it does not exist.
3. Select **Register SSH Key** and enter the board password once. If your PC has no key, `~/.ssh/id_ed25519` is created and added to `~/.ssh/authorized_keys` on the board.
4. Select **Open Remote Workspace**. The drive is mounted and the window reloads with the workspace.
5. When you are done, select **Close Remote Workspace**. The drive is unmounted after all uploads to the board finish.

- The remote workspace can be open in only one window. Selecting Open in another window switches to the window that already has it open.
- If you quit VS Code without closing the workspace, the drive stays mounted and reconnects automatically the next time. Select **Unmount** in the panel to unmount it.
- If you connect with a password only, the terminal and **Run on tOS** ask for the password every time. Debugging, board tools, and Jupyter use the saved password. Registering an SSH key is recommended.

### Running Jupyter cells on the board

1. Open the remote workspace and check **Board Tools** in the panel. If Jupyter is not installed, select **Install** (the sudo password of the board may be asked for).
2. Select **Start** next to the Jupyter server (or run `tOS: Start Jupyter on tOS`). The server starts on the board and is forwarded to your PC.
3. In a Python file, add cells with `#%%` and select **Run Cell**. In **Select Kernel**, choose **tOS Remote** and then the Python kernel. If the server is not running yet, choosing **tOS Remote** starts it.
4. Select **Stop** when you are done. Closing the remote workspace also stops the server. Idle kernels without a connection are shut down after an hour, and the server stops an hour after the last kernel and request.

```python
#%%
import sys
#%%
print(sys.path)   # runs on the board
```

## Settings

| Setting | Default | Description |
|---|---|---|
| `tosRemote.host` | `192.168.254.1` | Board IP address |
| `tosRemote.port` | `22` | SSH port |
| `tosRemote.user` | `tos` | Board user account |
| `tosRemote.remoteWorkspace` | `Workspace` | Workspace folder under the user's home directory (`/home/<user>/`). Enter only the path after the home directory; `/home/<user>/` is filled in from the user account. Created on the board if it does not exist. |
| `tosRemote.driveLetter` | (auto) | Mount drive. If empty, a free letter starting from Z: is used. |
| `tosRemote.identityFile` | (auto) | SSH private key path |
| `tosRemote.pythonCommand` | `python3` | Python command on the board |
| `tosRemote.debugPort` | `5678` | debugpy port |
| `tosRemote.pythonLibraryPaths` | (auto-detect) | Board package paths to copy for IntelliSense. Paths set here are all treated as required. |
| `tosRemote.pathMappings` | `[]` | Additional path mappings for terminal links |
| `tosRemote.rclonePath` | (auto-install) | Path to an rclone.exe you provide |
| `tosRemote.packageExcludeNewer` | (empty) | Install board packages as they were on this date (for example `2026-10-01`). Use the same date on every PC to install identical versions on all boards in a class. If empty, the latest versions compatible with the board's Python are used. |

All settings are machine-specific and are not copied to other PCs by Settings Sync. Passwords are stored only in VS Code secret storage (SecretStorage), never in settings.

## How It Works

```
VS Code (extension) ──HTTP (127.0.0.1, random port/credentials)──▶ rclone rcd (detached)
     │                                                              │ SFTP
     │ ssh.exe (terminal, run, debug)                               ▼
     └─────────────────────────────────────────────────────────▶ Dropbear (board)
                                           WinFsp drive ◀── rclone mount
```

- rclone runs as a control server (`rclone rcd`) detached from the extension process, so the mount survives window reloads and VS Code restarts.
- The workspace file (`.code-workspace`) is created in the extension storage on your PC; nothing is written to the board.
- Before running or debugging after a save, the extension waits until rclone's write queue is empty so the board never runs an old file.
- The SSH terminal runs through `ssh-terminal.cmd` (cmd.exe) in the extension storage, which handles connection retries and exit codes. **Run on tOS** runs through `run-on-tos.cmd`, which receives the ssh command in environment variables so that it is not shown in the terminal.
- Python library sync uses at most 4 SSH connections because of the concurrent connection limit of the board (Dropbear), and starts 15 seconds after the workspace opens. The board tools (debugpy, Jupyter) are checked in the same SSH connection when the workspace opens.
- Writes to the drive are uploaded after a 200 ms delay. Files created on the board appear within 10 seconds (use **Refresh Drive** to see them right away).
- Board tools: uv on the PC resolves the packages for the board (`--python-version` and `--python-platform` from the board, wheels only, packages already on the board are kept). The wheels are downloaded from PyPI and verified with SHA-256, copied with rclone to `/tmp/tos-remote.XXXXXX` (mode 0700), and installed with `sudo pip install --no-index --find-links`. The resolver data stays in the extension storage (`uv.exe`, the uv Python runtime) and `%LOCALAPPDATA%\tOS Remote\uv-cache`.
- Jupyter: the server runs on the board as the board user (`python3 -m jupyter_server`, `127.0.0.1`, random port and token, terminals disabled), and its state and log are kept in `~/.local/state/tos-remote` (mode 0700). The PC forwards a free local port to it with `ssh -N -L` and registers it with the Jupyter extension (`createJupyterServerCollection`). If the forwarding drops, it reconnects automatically while the server is running.
- With password authentication, background ssh commands receive the saved password through `SSH_ASKPASS`: a small helper (`askpass.cmd`, which runs VS Code's own Node.js) reads it from a one-time named pipe opened by the extension.

## Security Notes

- **SSH host keys are not verified**, so the connection keeps working after the board is reinstalled. Use it only on trusted networks (direct connection or a lab network).
- While remote debugging, debugpy listens on `0.0.0.0:5678` on the board.
- The rclone control server listens only on `127.0.0.1` and uses random credentials each time it starts.
- The Jupyter server listens only on `127.0.0.1` on the board and requires a random token; it is reached only through the SSH tunnel.
- Board packages are installed into the global Python environment with sudo. The sudo password is not stored by this feature; the saved board password is reused if you saved one in the panel.

## Troubleshooting

- Check **Show Log** in the panel (Output panel `tOS Remote`) and the **rclone Log**. Board tool installation output is written to the same log.
- Error that the drive is in use: set the drive to `Auto` in the panel or choose another letter.
- If the connection to the board is lost, the status bar shows `Reconnecting` and the extension retries automatically.
- Jupyter cells run on your PC instead of the board: select **Select Kernel** → **tOS Remote**. To see the server log on the board, select **Jupyter Log** in the panel.
- Board tool installation fails with a resolution error: the board's Python version may be too old for the packages. Check the `[uv]` lines in the log.

## Development

```
src/               Extension source (plain JavaScript, no build step, no runtime dependencies)
media/             Sidebar panel (html/css/js), icon, walkthrough pages (English; ko/ Korean)
l10n/              Korean translations of runtime strings (bundle.l10n.ko.json; source strings are the English in the code)
package.nls*.json  Manifest strings (English default, .ko Korean)
test/run.js        Unit tests (node test/run.js, including checks for missing translations and placeholders)
test/integration/  VS Code extension host integration tests (local rclone SFTP server instead of the board; English and Korean display languages)
scripts/build-vsix.ps1         Builds a local-test .vsix (*-local.vsix) without Node.js; not for the Marketplace
scripts/integration-test.ps1   Runs the integration tests
```

```powershell
node test/run.js                       # Unit tests
.\scripts\build-vsix.ps1               # Local install testing only: dist\tos-remote-<version>-local.vsix (no Node.js needed)
npx @vscode/vsce package --out dist/   # Marketplace packaging and validation (Node.js needed)
npx @vscode/vsce publish               # Publish to the Marketplace (after vsce login PlanXLab)
.\scripts\integration-test.ps1 -CodePath <Code.exe>
```

The integration tests cannot start while another VS Code instance with the same user data is running. If you use a portable VS Code, pass the `Code.exe` of a copy without the `data` folder.

### Localization

- Write user-facing strings in English in the source and wrap them with `t('...')` (`src/i18n.js`, which uses `vscode.l10n.t`). Use single-quoted strings only.
- Add Korean translations to `l10n/bundle.l10n.ko.json`, keyed by the English source string. Add manifest strings to `package.nls.json` and `package.nls.ko.json` with the same key.
- Update the documents in both English (`README.md`, `CHANGELOG.md`) and Korean (`README.ko.md`, `CHANGELOG.ko.md`).
- `node test/run.js` checks for missing or unused translations and mismatched `{0}` placeholders.
- The integration tests install the Korean language pack (`MS-CEINTL.vscode-language-pack-ko`) into an isolated extensions folder and run once more with `--locale=ko`. Without a network connection, pass `-SkipKorean`.

## License

[GPL-3.0-or-later](LICENSE). Copyright (C) PlanXLab.

This extension does not bundle rclone, WinFsp, or uv. rclone (MIT) is downloaded from the official site on first use, uv (MIT or Apache-2.0) is downloaded from PyPI when you first install board tools, and WinFsp (GPLv3 with FLOSS exception) is installed by the user with winget. Board packages (debugpy, Jupyter) are downloaded from PyPI when you install them.
