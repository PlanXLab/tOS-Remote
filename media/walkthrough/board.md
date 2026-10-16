# Board Connection Settings

Select the **tOS Remote** icon in the activity bar to open the panel.

| Item | Default | Description |
|---|---|---|
| Host | `192.168.254.1` | Board IP address |
| Port | `22` | SSH (Dropbear) port |
| User | `tos` | Board user account |
| Workspace | `/home/tos/` + `Workspace` | Folder under the home directory. `/home/<user>/` is filled in from the user account; enter only the rest. Created if it does not exist. |
| Local Folder | (prompt on first open) | Local folder on this PC where the remote workspace copy is kept and synced. |

**Test Connection** checks that the SSH port responds and which authentication method works (SSH key or saved password).