# Register an SSH Key

With an SSH key registered, you can use the following without a password:

- The SSH terminal
- **Ctrl+F5** (Run Without Debugging) and the Run button (**Run on tOS**)
- **F5** remote debugging (key authentication required)

Registration steps:

1. If your PC has no `~/.ssh/id_ed25519` key, a new one is created.
2. Enter the board password once to add the public key to `~/.ssh/authorized_keys` on the board.
3. Key authentication is verified.

The password you enter is stored only in VS Code secret storage (SecretStorage), never in settings files.