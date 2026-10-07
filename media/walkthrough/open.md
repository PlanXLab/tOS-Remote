# Open the Remote Workspace

Selecting **Open Remote Workspace** does the following:

1. Connects to the board and checks authentication
2. Mounts the board workspace as a drive
3. Opens the workspace window (the window reloads)

After it opens:

- **Terminal**: A new terminal opens an SSH shell on the board.
- **F5**: Debugs the current Python file on tOS.
- **Ctrl+F5** or the editor Run button (**Run on tOS**): Runs the file on tOS without the debugger.
- **Path links**: Ctrl+click a `/home/tos/Workspace/...` path printed in the terminal to open that line in the local file.
- **Close**: Select **Close Remote Workspace** in the panel or status bar to finish uploads and unmount the drive.

If you quit VS Code without closing the workspace, the drive stays mounted and reconnects automatically the next time you start VS Code.