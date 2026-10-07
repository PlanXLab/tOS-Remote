# rclone

tOS Remote uses [rclone](https://rclone.org) to exchange files with the board.

1. Checks the latest version at `https://downloads.rclone.org/version.txt`.
2. Downloads the Windows zip to a temporary folder and verifies it with `SHA256SUMS`.
3. Installs only `rclone.exe` in the extension storage. It is kept when the extension is updated.

rclone is installed only once; the installed rclone is not downloaded again or updated.

If you are offline, download `rclone.exe` yourself and set its path in the `tosRemote.rclonePath` setting.