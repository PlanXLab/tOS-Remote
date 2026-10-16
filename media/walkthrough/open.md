# Open the Remote Workspace

Selecting **Open Remote Workspace** does the following:

1. Connects to the board and checks authentication
2. Syncs the board workspace to your local workspace folder
3. Opens the workspace in the window you choose (**Current Window** or **New Window**)

After it opens:

- **Terminal**: The terminal opens an SSH shell on the board. Local terminals restored from an earlier session are replaced with the board terminal.
- **Sync**: Changes made in VS Code, Windows Explorer, or the board terminal are synchronized in both directions.
- **F5**: Debugs the current Python file on tOS.
- **Ctrl+F5** or the editor Run button (**Run on tOS**): Runs the file on tOS without the debugger.
- **Path links**: Ctrl+click a `/home/tos/Workspace/...` path printed in the terminal to open that line in the local file.
- **Close**: Select **Close Remote Workspace** in the panel or status bar to finish pending uploads and close the workspace.

If you quit VS Code without closing the workspace, your local files stay intact and reconnect automatically the next time you start VS Code.