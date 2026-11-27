# WinGet Packaging Manifest (`SwSwordHoly.AgentsChat`)

Staged WinGet v1.6.0 manifests for AgentsChat Desktop (`0.2.2`), targeting Windows `x64` and `arm64` NSIS installers.

## Verify & Submit (on Windows)

1. Validate manifests locally:
   ```powershell
   winget validate --manifest desktop/packaging/winget/
   ```
2. Test local install (requires Developer Mode or local manifest policy enabled):
   ```powershell
   winget install --manifest desktop/packaging/winget/
   ```
3. Submit PR to `microsoft/winget-pkgs` (requires Microsoft CLA signature once):
   ```powershell
   wingetcreate submit desktop/packaging/winget/
   ```
