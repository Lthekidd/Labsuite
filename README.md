<p align="center">
  <img src="assets/icon.png" width="104" alt="LabSuite icon">
</p>

<h1 align="center">LabSuite</h1>

<p align="center">
  Encrypted Google Drive backups, cross-PC restore tools, private productivity apps, LAN transfers, and VM file protection in one Windows desktop application.
</p>

<p align="center">
  <a href="https://github.com/Lthekidd/Labsuite/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Lthekidd/Labsuite?style=flat-square"></a>
  <a href="https://github.com/Lthekidd/Labsuite/actions/workflows/release-windows.yml"><img alt="Windows release workflow" src="https://img.shields.io/github/actions/workflow/status/Lthekidd/Labsuite/release-windows.yml?style=flat-square&label=windows%20build"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square&logo=windows">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square">
</p>

<p align="center">
  <a href="https://github.com/Lthekidd/Labsuite/releases/latest"><strong>Download the latest Windows installer</strong></a>
  ·
  <a href="CHANGELOG.md">Changelog</a>
  ·
  <a href="RELEASING.md">Release guide</a>
</p>

> [!IMPORTANT]
> LabSuite is currently distributed as an unsigned personal-use application. Windows will show **Unknown publisher** during installation. Download it only from this repository, then choose **More info → Run anyway** if you trust the release.

## What LabSuite does

### Encrypted backup and restore

- Encrypts files locally before sending them to your Google Drive vault.
- Watches selected folders and backs up changes automatically.
- Supports manual, interval, night, custom-hour, idle, battery, and metered-network rules.
- Includes bandwidth profiles, scheduled limits, smart throttling, and common cache/build exclusions.
- Preserves deleted and overwritten files in version history according to the configured retention policy.
- Restores individual files, complete folders, retained versions, or a folder as it appeared at a restore point.
- Searches backed-up filenames, including files stored inside small-file packs.
- Opens configured folders through quick shortcuts such as Desktop, Documents, Downloads, Pictures, Music, and Videos.
- Can expose the decrypted vault through a local web browser or a read-only mounted Windows drive.
- Verifies backup integrity and provides restore-drill and diagnostic tools.

### Multiple computers and existing backups

- Keeps backups from multiple PCs under separate computer identities and friendly aliases.
- Browses and restores backups created on another computer.
- Reads compatible legacy VaultSync vaults without rewriting or migrating them.
- Supports encrypted vault migration or a verified replica on another Google Drive account.

### Network Drive

- Discovers LabSuite computers on the local network.
- Pairs trusted devices before allowing file access.
- Browses peer drives and queues uploads, downloads, folder transfers, and drop-inbox deliveries.

### VM Protect

- Discovers common VMware Workstation and Player installations.
- Protects selected guest files without copying an entire virtual disk.
- Uses an approved portable PowerShell helper with authenticated uploads and immutable retained revisions.
- Supports direct helper delivery through VMware `vmrun`/VIX or a one-time manual copy.

### Private productivity tools

- **Encrypted Tables** for structured rows and columns.
- **Secure Notebook** with retained note versions.
- **Task Board** for encrypted Kanban-style planning.
- **Crypto Portfolio** for locally managed holdings and market views.
- Delayed Windows shutdown controls for long-running backup jobs.

### Updates

- Checks GitHub Releases shortly after startup and every six hours.
- Provides **Suite Settings → Check for Updates** for a manual check.
- Downloads updates in the background and installs them after LabSuite fully exits.

## Requirements

| Requirement | Needed for |
| --- | --- |
| Windows 10 or Windows 11, 64-bit | LabSuite desktop application |
| Google account with available Drive storage | Encrypted cloud backup and cross-PC restore |
| Internet connection and a web browser | Google authorization, backups, restores, and updates |
| A master password you can retain safely | Encrypting and decrypting the vault |
| [WinFsp](https://winfsp.dev/) (optional) | Mounting the restore vault as a Windows drive |
| VMware Workstation/Player with `vmrun` or VIX (optional) | Automatic VM Protect helper deployment |

LabSuite bundles its supported rclone executable. You do not need to install rclone separately for normal use.

## Install and create a backup

1. Open the [latest release](https://github.com/Lthekidd/Labsuite/releases/latest) and download `LabSuite-v*-Setup.exe`.
2. Run the installer. For the unsigned build, select **More info → Run anyway** when Windows SmartScreen appears.
3. Open LabSuite and connect the Google account that will hold the encrypted vault.
4. Create a strong master password and store it somewhere safe. LabSuite cannot recover a lost master password.
5. Select the folders you want to protect.
6. Run **Back Up Now** and wait for the first backup to complete.
7. Open **Health** and verify at least one folder, then test a small restore before relying on the backup.

Keep another independent copy of irreplaceable data. A sync or backup application should not be the only copy of important files until you have tested recovery.

## Restore on another computer

1. Install the latest LabSuite release on the other Windows PC.
2. Connect the Google account containing the vault.
3. Choose the option to access an existing backup.
4. Enter the exact master password used when the files were backed up.
5. Open **Backup Engine → Restore** and select the computer, shortcut, file, folder, version, or restore point.

Existing VaultSync backups use the same process. Temporary Google Drive timeouts do not necessarily mean the password is incorrect; retry after active transfers finish.

## Disk Mount and local web restore

The Restore workspace offers two browse-first options:

- **Disk Mount** creates a read-only Windows drive backed by the encrypted vault. Install WinFsp when LabSuite prompts for it. The first mount can take up to 45 seconds.
- **Web Server** starts a local-only browser view for previewing and downloading decrypted files without restoring an entire tree.

Mounted restore data is intentionally read-only to prevent accidental changes to the backup vault.

## Automatic update behavior

Only published, non-draft GitHub Releases are offered to installed computers. A valid update release contains:

- `LabSuite-vX.Y.Z-Setup.exe`
- `LabSuite-vX.Y.Z-Setup.exe.blockmap`
- `latest.yml`

When an update finishes downloading, fully quit LabSuite from its system-tray menu and reopen it. The window close button normally hides the application instead of exiting it, allowing backups to continue.

## Security and recovery notes

- Files selected for backup are encrypted before upload.
- The master password must match the vault that created the backup.
- Losing the master password means the encrypted files cannot be recovered.
- Export the emergency recovery sheet and standalone recovery script from **Suite Settings** and store them securely away from the PC.
- The Windows installer is unsigned, so Windows cannot verify a commercial publisher certificate. Verify that downloads come from `github.com/Lthekidd/Labsuite`.
- Do not commit or share `rclone.conf`, Google tokens, LabSuite databases, master passwords, or recovery material.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Windows says Unknown publisher | Expected for the unsigned personal build. Confirm the download came from this repository. |
| Google Drive shows disconnected | Check the internet connection, then reconnect the Google account if authorization expired. |
| Existing vault will not unlock | Confirm the Google account and use the exact original master password. |
| Vault folder cannot be opened | Refresh the computer-backup catalog; the cloud folder and local catalog may be temporarily out of sync. |
| Disk Mount fails | Install WinFsp, let active backup work finish, and allow up to 45 seconds for the mount. |
| Another PC is missing | Confirm it used the same Google Drive vault, then refresh the Restore computer list. |
| Update is not detected | Confirm the release is published, its version is newer, and all three update assets are present. |

Use **Backup Engine → Health → Export Diagnostics** when investigating a repeatable backup or restore failure.

## Build from source

Developer requirements:

- Windows
- Node.js 22 and npm
- Git

```powershell
git clone https://github.com/Lthekidd/Labsuite.git
cd Labsuite
npm ci
npm run dev
```

Validation and packaging:

```powershell
npm test
npm run build
npm run test:ui-smoke
npm run build:prod
```

The unsigned NSIS installer and update metadata are written to `dist-packaged/`. See [RELEASING.md](RELEASING.md) for the tag, GitHub Actions, draft review, and publication workflow.

## Project structure

```text
main/        Electron main process, backup services, IPC, restore, LAN, and VM Protect
renderer/    React user interface and LabSuite workspaces
scripts/     Verification, packaging, and UI smoke-test utilities
assets/      Application and tray icons
build/       NSIS installer customization
.github/     Windows release automation
```

## Compatibility

LabSuite 2.2.x keeps existing LabSuite and compatible VaultSync encrypted backups in place. It does not require a backup-format or master-password migration.

## License

LabSuite is released under the MIT license as declared in `package.json`.
