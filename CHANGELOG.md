# Changelog

## 2.2.7 — 2026-07-13

### Fixed

- Files and temporary directories that disappear while a backup scan is running are now skipped or preserved as deletions instead of being counted as failed uploads.
- Electron Builder's `dist-packaged` output is treated as disposable build output by Smart Exclusions, alongside `dist`, `node_modules`, and other development artifacts.
- Stale dirty manifest entries for newly created files that no longer exist are removed automatically on the next backup.
- The sidebar health badge now considers only enabled backups owned by the current PC, refreshes periodically, displays the number of affected folders, and exposes the stored reason as a tooltip.

### Resolved on the development PC

- Seventy-four transient `ENOENT` errors from `E:\\LabSuite\\dist-packaged\\win-unpacked.tmp` no longer keep the suite in a failing state after a successful retry.

## 2.2.6 — 2026-07-13

### Fixed

- VM Protect's Secure Receiver now offers **Allow Through Firewall** when its scoped Windows rule needs administrator approval.
- The UAC prompt elevates only the firewall operation; LabSuite and the receiver continue running with normal user privileges.
- Existing valid VM Protect rules are accepted without trying to modify them, avoiding false firewall warnings for standard users.
- VM Protect firewall state is shared between automatic receiver startup and the UI, so the status card remains accurate after navigation or restart.

## 2.2.5 — 2026-07-13

### Fixed

- Network Drive now offers an **Allow Through Firewall** action when Windows rejects unelevated firewall changes.
- LabSuite requests UAC only for the firewall operation; the main application continues running without administrator rights.
- LAN file-access and discovery rules are validated, deduplicated, and restricted to the local subnet on Private and Public Windows network profiles.
- Canceling the Windows approval prompt leaves Network Drive running locally and provides a retryable explanation instead of telling users to restart the entire app as administrator.

## 2.2.4 — 2026-07-13

### Added

- Onboarding fields for a personal Google OAuth Desktop client, with a direct link to rclone's official setup guide.
- A **Suite Settings → Google OAuth Client** migration tool for existing installations that preserves the encrypted vault and refreshes Google authorization.

### Fixed

- rclone's shared-client retirement notice no longer hides the real cause of a failed backup in Activity.
- Google reconnect temporarily pauses new backup work, refuses to run during an active transfer, restores the previous configuration if approval fails, and never exposes the stored token or client secret to the renderer.

### Important

- rclone's shared Google Drive client ID is being retired during 2026. Each LabSuite PC should be updated to a personal Google OAuth Desktop client from Suite Settings.

## 2.2.3 — 2026-07-13

### Fixed

- Installed builds now find the bundled rclone executable in `resources/bin`, matching the electron-builder `extraResources` layout.
- Google Drive connection, encrypted app sync, and local WebDAV restore share one packaged-binary resolver with a legacy-layout fallback.
- Release verification now checks that the packaged rclone binary is present and runnable before an installer can be published.
- Fresh GitHub release runners download the checksum-verified rclone binary before tests and packaging.

## 2.2.2 — 2026-07-12

### Improved

- VM Protect portable helpers retry transient uploads and now report a real failure when a one-time protection run cannot upload every selected file.
- GitHub Actions captures PowerShell helper diagnostics, handles equivalent Windows short and long paths, and supports manual validation runs before a release tag is created.

## 2.2.1 — 2026-07-12

### Added

- A manual **Check for Updates** control with live checking, download, and ready-to-install status in Suite Settings.

### Changed

- Windows installers and GitHub update releases now use an unsigned personal-use build policy, avoiding paid certificate requirements.

## 2.2.0 — 2026-07-12

### Added

- GitHub Releases auto-update support with startup and six-hour checks.
- A signed Windows release workflow that creates reviewable draft releases from version tags.
- Backup shortcuts in Restore that open configured backup roots directly.
- Automatic shortcuts for Desktop, Documents, Downloads, Pictures, Music, Videos, and common OneDrive folders found in legacy backups.
- A matching **Backup shortcuts** folder in mounted restore disks.
- Legacy VaultSync vault discovery and validation when newer LabSuite metadata is absent.

### Improved

- VaultSync and LabSuite system namespaces are selected automatically, including version history, control data, packs, staging, and retention folders.
- Restore browsing now resolves rclone's relative directory results against the folder being viewed.
- Google Drive listing timeouts allow for real-world API latency and distinguish connectivity failures from incorrect master passwords.
- Disk Mount waits for WinFsp and Google Drive initialization instead of terminating a healthy mount too early.
- Mounted restore disks are read-only to protect cloud backup data.
- Computer aliases and shortcut labels make backups from multiple PCs easier to identify.

### Fixed

- “Backup destination was not found” when opening an existing backup from another PC.
- Empty Version History when opening a VaultSync-created vault in LabSuite.
- False master-password mismatch messages caused by temporary Google Drive failures.
- Duplicate root entries that made one computer backup appear under two names.
- Disk Mount failures caused by the mount point appearing just after the previous readiness deadline.

### Compatibility

- Existing encrypted VaultSync and LabSuite backups remain in place and are not migrated or rewritten by this update.
- No backup format or master-password change is required.
