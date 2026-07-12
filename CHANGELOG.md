# Changelog

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
