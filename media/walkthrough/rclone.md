# rclone

tOS Remote uses [rclone](https://rclone.org) to exchange files with the board.

1. Uses an installed supported version of rclone when available.
2. If rclone is missing, uses an available system package manager (winget/Scoop/Chocolatey, Homebrew/MacPorts, or common Linux managers).
3. If no manager is available or its version is too old, downloads the matching official binary for Windows, Linux, or macOS and verifies it with `SHA256SUMS`.

The verified binary is stored in the extension storage. Package-manager installations remain managed by that manager; the extension does not automatically update rclone.

If you are offline, provide your own rclone executable and set its path in the `tosRemote.rclonePath` setting.