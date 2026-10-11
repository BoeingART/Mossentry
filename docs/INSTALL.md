# Mossentry v0.1.0

## macOS

- Requires macOS 13 or later.
- Apple Silicon (M1/M2/M3/M4 and later): download `Mossentry-0.1.0-macOS-arm64.dmg`.
- Intel: download `Mossentry-0.1.0-macOS-x64.dmg`.
- Open the disk image and drag Mossentry to Applications. ZIP copies are also available.
- Python, the SSH client and the interface are bundled. No separate runtime setup is needed.
- This release is not Developer ID signed or notarized. macOS may require allowing
  the application in System Settings → Privacy & Security after the first launch attempt.

## Windows

- Download `Mossentry-0.1.0-Windows-x64-Setup.exe` and run the installer.
- Requires 64-bit Windows 10/11. Python and the SSH client are bundled.
- No WSL, Python, Ansible or OpenSSH installation is required on the client.
- This release is unsigned, so Windows may show an unverified-publisher warning.
- Configure SSH private-key paths using Windows paths, such as
  `C:\Users\yourname\.ssh\id_ed25519`. Known hosts are read from
  `%USERPROFILE%\.ssh\known_hosts`. Encrypted private keys requiring a passphrase
  are not supported by this release.
- Application data is stored under `%APPDATA%\Mossentry\data` and is preserved
  during uninstall.

## SSH setup

Use your own server addresses and SSH credentials. The initial inventory contains
the project's example hosts; edit or remove them in Servers before connecting.
Verify each server's SSH host-key fingerprint and add it to your local `known_hosts`
before connecting in Mossentry. The bundled SSH client uses `~/.ssh/known_hosts` on each platform.
Remote account management and resource monitoring currently require Linux, `/usr/bin/python3` and appropriate sudo permissions. SSH connection tests can also reach macOS hosts with `/usr/bin/python3`; macOS account management and monitoring are not implemented in v0.1.0. Merely launching the application does not change remote accounts.

## Checksums

The release includes `SHA256SUMS.txt` for the installers and ZIP archives.
On macOS use `shasum -a 256 <file>`; on Windows use `Get-FileHash <file> -Algorithm SHA256`.
