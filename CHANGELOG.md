# Changelog

## 2.2.38 — 2026-07-20

### Added

- Added a "Re-authorize Account" button to Suite Settings that triggers browser authentication using the currently active personal Client ID and Client Secret (without needing to re-enter them).

### Fixed

- Exposed connection check error messages (e.g. "Google Drive login session expired") in the Backup Health Connectivity card rather than marking the drive as disconnected silently.

## 2.2.37 — 2026-07-20

### Fixed

- Increased the Google Drive connection and remote metadata check timeouts from 15 seconds to 45 seconds. This prevents connection dropouts and "Google Drive disconnected" states when rclone performs network-bound OAuth token refreshes on slower networks.

## 2.2.36 — 2026-07-19

### Added

- Transitioned LabSuite to a modular **App Hub** architecture. Optional tools (Sheets, Network Drive, VM Protect, and Todo) are now installable on-demand from the App Hub.
- Added multi-window support, allowing standalone apps (Sheets, Network Drive, VM Protect, and Todo) to open in their own separate, frameless windows with custom title bars.
- Notebook is now a dual-mode app: it opens embedded in the LabSuite main UI but launches as a standalone window when opening `.txt` files from Windows Explorer.
- Added database migration logic that preserves installed apps for existing users based on their previous sidebar visibility.

### Removed

- Removed the obsolete Disk Space Analyzer utility.

## 2.2.35 — 2026-07-19

### Fixed

- Telegram Desktop automation now writes each scan/export result to a temporary UTF-8 JSON file and LabSuite reads that file directly. This removes the PowerShell console-output/encoding path that could produce a false “no readable result” scan failure even when Telegram had returned valid chat data.

## 2.2.34 — 2026-07-19

### Fixed

- Telegram chat scanning now automatically dismisses a stray Telegram popup and retries once when Telegram Desktop returns an empty automation response. This prevents a transient scan failure from leaving the archive list empty.

## 2.2.33 — 2026-07-19

### Added

- Added **Sidebar** controls in Suite Settings. Optional tools can be hidden individually without disabling their schedules, backups, or local data; Home Dashboard, Backup Engine, and Settings remain available.

### Fixed

- Made the left tool list independently scrollable and pinned Suite Settings above the connection card, so Settings remains reachable in smaller non-fullscreen windows.
- At very short window heights, the connection card collapses before navigation controls do.

## 2.2.32 — 2026-07-19

### Added

- Added a persistent, copy-ready Telegram failure log for both readable chat archives and encrypted session backups. It records the exact failed stage, recent run events, LabSuite/Telegram/PowerShell details, archive write access, source-path availability, and local rclone configuration state.
- Added a global **Copy failure log** action to the Telegram page. Reports redact Windows user-profile paths and credential-like values, and never include message bodies, media contents, OAuth tokens, or rclone secrets.

### Changed

- Telegram archive and session uploads now retain a sanitized tail of rclone's real error instead of reporting only its exit code, making authentication, quota, configuration, and network failures distinguishable.
- Telegram failures now distinguish account/chat scanning, individual UI automation actions, local archive copying, session snapshot copying, and encrypted cloud copying.

### Compatibility

- The report calls out the current requirement for Telegram Desktop's interface language to be English and checks whether Telegram has a usable main window. LabSuite and Telegram should normally run at the same non-administrator privilege level.

## 2.2.31 — 2026-07-18

### Added

- Added readable Telegram chat archives that detect signed-in Telegram Desktop accounts and their chat lists without Telegram API credentials.
- Chats, including Saved Messages, can be selected individually; selected chats stay pinned at the top and are exported sequentially on a manual, hourly, six-hour, daily, or weekly schedule.
- The first run exports chat history. Later runs use the previous run checkpoint with a one-day safety overlap, deduplicate by Telegram message ID and content, and retain only new or edited records.
- Added a Telegram-style local archive viewer with sender-aware message bubbles, chat and message search, media counts, per-chat media controls, schedules, progress, and direct access to the archive folder.
- Exported media is stored by content hash, and immutable message segments plus new media files are copied through the configured encrypted rclone remote.

### Changed

- The original encrypted `tdata` session backup remains available under **Session Backups**, while readable selected-chat archives are now the default Telegram view.
- Telegram automation restores the previously focused window and mouse position after scans and exports.

## 2.2.30 — 2026-07-18

### Fixed

- Telegram Backup staging now uses the current PC's local Windows temp directory instead of deriving a drive from the first configured backup folder. This prevents `ENOENT` failures when a folder references a drive that is unavailable on another PC.

## 2.2.29 — 2026-07-18

### Added

- Added Telegram Backup with automatic Telegram Desktop discovery, account-aware `tdata` backups, scheduling, progress reporting, and cross-PC restore.
- Telegram backups use VSS snapshots when required so files can be captured safely while Telegram is running.

### Fixed

- Unblocked Windows release packaging after a GitHub-hosted runner produced a false failure in the nested PowerShell VM Protect runtime check. The runtime check still runs on normal Windows development machines, while protocol, transfer, parser, and Telegram verification continue to run in release CI.
- Synchronized the package lock version with the application release version.

## 2.2.27 — 2026-07-14

### Added

- Rebuilt VM Protect as a manifest-based VM agent that protects multiple folders and files, keeps a durable local queue, installs per-user startup, and provides copyable diagnostics.
- VM agents now batch small files, resume large files in chunks, and can transfer up to four large files in parallel.

### Changed

- VM Protect commits a verified batch into one current staging tree and passes one coalesced job to the encrypted backup engine; deleted files now mirror to the current backup while normal retention keeps history recoverable.
- The VM Protect page now creates portable and bulk VM agents. Each VM chooses its own folders and files instead of relying on a shared per-file helper list.

### Compatibility

- Existing VM Protect v1 helpers remain supported and are labeled as legacy until they are replaced with a v2 agent.

## 2.2.26 — 2026-07-13

### Fixed

- VM Protect uploads now sign a path-safe Base64URL representation, preventing HTTP 401 signature failures for VM file paths containing spaces or special characters.
- Helpers correct for host/VM clock differences using the receiver’s enrollment time.
- Upload and enrollment failures now include the receiver’s structured error reason in the helper output and diagnostics.

## 2.2.25 — 2026-07-13

### Added

- VM Protect helpers now generate and automatically copy a safe diagnostic report with Windows, PowerShell, network-profile, and receiver reachability details when setup fails.
- Helpers support a manual `-Diagnostics` mode and save the copyable report to `%LOCALAPPDATA%\LabSuiteVMProtect\diagnostic.txt`.

### Changed

- Auto-approved bulk helpers now surface unreachable-receiver failures after 45 seconds instead of waiting silently for the full invitation lifetime.

## 2.2.24 — 2026-07-13

### Fixed

- New VM Protect bulk helpers now replace stale or different local pairings instead of silently skipping enrollment and file selection.
- Portable helpers keep the PowerShell result visible, show connection progress, and save startup diagnostics to `%LOCALAPPDATA%\LabSuiteVMProtect\last-run.log`.

## 2.2.23 — 2026-07-13

### Fixed

- VM Protect now refreshes running states automatically, detects both VMware Workstation and Player guests, and falls back to VMware runtime locks when Windows hides a VM process command line.

## 2.2.22 — 2026-07-13

### Changed

- GitHub release builds now publish updater releases automatically so installed PCs can detect new LabSuite versions without a manual draft-release step.

## 2.2.21 — 2026-07-13

### Added

- VM Protect can now create a passwordless bulk helper that auto-pairs multiple VMs for 24 hours without per-VM Windows credentials or approval prompts.

### Fixed

- Network Drive Quick Drop now creates the receiving inbox automatically before writing the first dropped file.

## 2.2.20 — 2026-07-13

### Fixed

- Resolved reference error in the local Space Analyzer directory scanner by exporting `SKIP_TREE_WINDOWS` from filesystem module.

## 2.2.19 — 2026-07-13

### Added

- Added a Space Analyzer app under the Productivity section, allowing users to visualize and navigate local folder/disk space usage.

## 2.2.18 — 2026-07-13

### Added

- Added a "Clear Activity" button to the dashboard header actions, allowing users to clear both live session sync queue and historical activity records.

## 2.2.17 — 2026-07-13

### Fixed

- Resolved directory mismatch errors during backup verification and safety checks for single-file sync folders.

## 2.2.16 — 2026-07-13

### Fixed

- Corrected the release-test assertion used by v2.2.15 so Windows installer builds validate the checkpoint file-restore path reliably on GitHub.

## 2.2.15 — 2026-07-13

### Fixed

- Restore Checkpoint now opens checkpoints imported from other PCs by matching folder identifiers consistently across numeric and string catalog formats.
- Snapshot Explorer normalizes Windows path separators so nested folders display correctly.
- Restoring one file from a checkpoint now uses its full encrypted Google Drive path instead of its browser-relative path.
- Snapshot loading failures are shown explicitly instead of being presented as an empty directory.

### Changed

- Unchanged 15-minute quick scans no longer create duplicate zero-change checkpoint dates. Verified daily scans and successful backups with changes still create restore points.

## 2.2.14 — 2026-07-13

### Fixed

- Duplicate LabSuite processes now exit immediately before they can initialize watchers, schedulers, rclone transfers, or database writers.
- Update relaunch races can no longer start several simultaneous backups against the same file and Google Drive destination.
- Prevents the `EBUSY` backup-copy and `EPERM` database-rename errors revealed by the v2.2.12 failure report.

## 2.2.13 — 2026-07-13

### Fixed

- Standalone-file backups no longer append the filename twice to their Google Drive destination.
- A selection such as `Desktop/oldpctext.txt` now uploads to that exact remote file instead of incorrectly targeting `Desktop/oldpctext.txt/oldpctext.txt`.
- Standalone file creation, modification, packed migration, and deletion now use file-aware operations rather than folder batch commands.

### Changed

- Activity's failure diagnostic action is now **Copy Failure Log** and writes the sanitized report directly to the clipboard without creating a JSON file.

## 2.2.12 — 2026-07-13

### Fixed

- rclone's `Source doesn't exist or is a directory` response is now recognized when the previous active Google Drive copy is already absent during version promotion.
- A valid staged upload is promoted normally instead of being marked failed just because there was no older cloud copy to move into history.
- LabSuite no longer records a nonexistent previous cloud copy as a backup-history version.
- When Windows can read a local file but rclone rejects its path, LabSuite retries through a fresh local staging copy.

### Added

- Activity now includes **Export Failure Log**, producing a sanitized diagnostic report with failed manifest entries, recorded and current local-path checks, source sizes, retry counts, and LabSuite/rclone log tails.
- Every new backup failure writes a structured `BACKUP_FAILURE` entry containing its local-versus-cloud context.

## 2.2.11 — 2026-07-13

### Added

- Downloaded updates now show a **Restart & Install** button in Suite Settings.
- LabSuite safely stops background services, flushes its database, installs the downloaded update silently, and relaunches itself automatically.
- Restart installation is deferred when a backup is actively running to avoid interrupting protected data transfers.

## 2.2.10 — 2026-07-13

### Fixed

- A lone small backup item is now uploaded directly instead of creating a temporary one-file bundle that rclone could report as missing.
- If creation or upload of a multi-file bundle fails, LabSuite automatically retries the original files directly instead of leaving them in a permanent retry loop.
- Temporary small-file pack and metadata write failures are now detected before rclone starts, preserving the real failure reason and enabling the direct-upload fallback.

## 2.2.9 — 2026-07-13

### Added

- The sidebar connection card now identifies the current Windows PC by hostname with a compact computer icon and **This PC** label.
- The PC identity remains visible when Google Drive is disconnected, making multiple LabSuite installations easier to distinguish.

## 2.2.8 — 2026-07-13

### Fixed

- A selected standalone file that has been deleted or replaced by a directory no longer retries forever as `CRITICAL: Source doesn't exist or is a directory`.
- LabSuite now preserves the existing Google Drive copy in deleted-item history before automatically disabling a missing standalone-file backup.
- Missing standalone files that were never uploaded are removed from the pending manifest and disabled without creating a false backup failure.
- Successful cleanup clears the folder's stored failure state, allowing Backup Health and the sidebar issue badge to recover automatically.

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
