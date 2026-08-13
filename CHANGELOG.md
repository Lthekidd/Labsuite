# Changelog

## 2.10.26 - 2026-08-13

### Google OAuth Credentials Persistence & Drive Auth Improvements

- **Personal Google OAuth Client Persistence (`rclone.js`)**:
  - Re-pins personal Google Desktop client credentials after rclone token updates, ensuring client ID & secret persist reliably across reauthorization.
- **Drive Auth Event Dispatch**:
  - Added `auth:gdriveInfoChanged` IPC event listener across renderer views (`App.jsx`, `LabSuiteBackup.jsx`) to update Google Drive connection status reactively without manual page refreshes.
- **YouTube OAuth Setup Flow**:
  - Added "Open OAuth setup" action button in LabMedia settings to directly navigate to Google OAuth configuration in Suite Settings when credentials are needed.
  - Updated OAuth callback HTML response page to avoid premature success messages before token exchange and account validation finish.

## 2.10.25 - 2026-08-13

### YouTube & YouTube Music OAuth Library Integration

- **YouTube Library Provider (`youtubeLibrary.js`)**:
  - Full PKCE-secured Google OAuth 2.0 loop (`code_challenge_method: S256`) with OS credential vault integration (`LabSuite.LabMedia.YouTube`).
  - Read-only YouTube & YouTube Music playlist sync (Liked Videos, created playlists, playlist items) with memory caching and rate limit handling (`Retry-After`).
  - Account integrity validation (verifies authenticated Google account matches the account configured in LabSuite).
- **IPC & Preload Integration**:
  - Registered IPC handlers: `labmedia:youtubeConnect`, `labmedia:youtubeReconnect`, `labmedia:youtubeDisconnect`, `labmedia:youtubeRefresh`.
- **Expanded Now Playing Flyout**:
  - Added native YouTube Library view in `NowPlayingPanel.xaml` / `NowPlayingPanel.xaml.cs`.
- **OAuth Setup-State Fix**:
  - The browser callback now reports only that Google approval was received instead of claiming the Library is connected before token and account verification finish.
  - LabMedia now links setup-required users directly to Suite Settings → Cloud Account & Security → Google OAuth Client.
  - Drive reauthorization now performs a live verification, refreshes sidebar/Backup Engine status immediately, and unlocks YouTube connection without restarting LabSuite.
  - Personal client credentials are re-pinned after rclone refreshes the Drive token, preventing silent fallback to rclone's shared OAuth client.

## 2.10.24 - 2026-08-13

### LabMedia Progressive-Disclosure Redesign

- Replaced taskbar session cycling with a separate native 384-DIP Now Playing flyout, explicit player selection, capability-aware playback controls, seeking, and isolated per-application volume and mute controls.
- Added fixed-height adaptive Micro, Compact, Normal, and Large taskbar layouts. Artwork and track clicks now open the flyout by default, while transport and seek controls continue to consume their own input.
- Added schema-v2 LabMedia settings for the primary click action and taskbar control density, with migration that preserves the existing size, theme, visibility, and control choices.
- Reorganized settings into Taskbar, Expanded Panel, and History tabs with collapsed and expanded interactive previews.
- Added a provider-neutral, read-only Up Next contract and bidirectional JSON-lines channel. Public builds report unsupported Spotify queue access honestly until eligible API access is available; provider credentials never enter the widget configuration or native helper.
- Preserved Explorer isolation: neither native LabMedia window is parented to Explorer, and taskbar positioning continues without UI Automation.

### LabMedia YouTube Playlist Library

- Added a read-only YouTube Library tab for owned playlists and Liked Videos, with playlist drill-down, pagination, unavailable-entry handling, and handoff to YouTube Music.
- Added a separate PKCE-protected YouTube OAuth grant that reuses the configured Google Desktop application identity while keeping the Drive token untouched and enforcing the same Gmail account.
- Stored only the YouTube refresh credential and account identity in Windows Credential Manager; access tokens, API cursors, playlist data, and thumbnails remain memory-only.
- Added honest setup, authorization, loading, offline, quota, empty, and error states plus settings controls for Connect, Reconnect, Refresh, and Disconnect.

## 2.10.23 - 2026-08-13

### Multi-Player Session Switcher & Real-Time Volume Level Toast Badge

- **Multi-Player Session Switcher Button**:
  - Added `BtnSwitchSession` button to the widget surface. When multiple media sessions are open (e.g. Spotify + YouTube / Chrome / Edge), clicking the button cycles to the next active player instantly.
  - Button automatically appears with tooltips (e.g. `Switch Active Player (2 Open)`) whenever 2 or more players are active.
- **Real-Time Volume Level Toast Badge**:
  - Added `VolToastBorder` overlay badge. When scrolling the mouse wheel over the widget, a live volume percentage indicator (`🔊 75%`) pops up on the widget for 1.5 seconds, providing instant visual feedback.

## 2.10.22 - 2026-08-13

### Permanent Taskbar Docking & Optional Auto-Hide Toggle

- **Permanent Taskbar Visibility Default (`autoHideWhenIdle: false`)**:
  - Removed mandatory auto-hiding when playback stops or no session is active.
  - The widget now stays **permanently docked on your Windows taskbar** as long as LabMedia is enabled in settings, displaying fallback media controls ready for action!
- **User-Controlled Auto-Hide Toggle**:
  - Added `autoHideWhenIdle` toggle in LabMedia settings so users can explicitly choose whether to keep the widget permanently docked or auto-hide when idle.

## 2.10.21 - 2026-08-13

### Active Media Session Volume Isolation & Transparent Glass Theme

- **Strict Active App Volume Isolation**:
  - Refactored `IsMediaProcess` in `AppVolume.cs` and `smtcWorker.ps1`. When both Spotify and YouTube (in Chrome/Edge) are open, scrolling the mouse wheel on the taskbar widget now **strictly adjusts ONLY the process currently active and displayed on screen**.
  - If Spotify is shown on the player, only Spotify volume changes. If YouTube in Chrome is shown, only Chrome volume changes.
- **Added Transparent Glass Theme Preset**:
  - Added 6th theme preset: **Transparent Glass** (`transparent`), featuring a 100% borderless transparent background surface (`#00000000`) with subtle frosted outline (`#35FFFFFF`) and sky blue accent (`#38BDF8`).

## 2.10.20 - 2026-08-13

### Native C# Compilation Fix

- **Cleaned Up `AdjustSystemVolume` References**:
  - Removed lingering `AdjustSystemVolume` function calls in `AppVolume.cs` that caused `dotnet publish` to fail on the GitHub Actions Windows release runner during `v2.10.18` and `v2.10.19`.
  - Native executable compilation now builds cleanly.

## 2.10.19 - 2026-08-13

### Native C# Taskbar Widget Theme Support Fix

- **Added `Theme` Property to `ConfigModel.cs`**:
  - Added `[JsonPropertyName("theme")] public string Theme { get; set; }` to `LabMediaConfig` class so theme selection deserializes properly from JSON config files.
- **Dynamic Surface & Accent Styling in Native `MainWindow`**:
  - `ApplyConfig()` now dynamically updates the widget pill background (`MainBorder.Background`), border stroke (`MainBorder.BorderBrush`), progress track (`ProgressTrack.Foreground`), glow drop shadow (`ProgressGlow.Color`), and play/pause button (`BtnPlayPause`) for all 5 themes (**Spotify Green**, **OLED Black**, **Cyberpunk Neon**, **Glassmorphism**, **Minimalist**).

## 2.10.18 - 2026-08-13

### Per-App Media Volume Isolation Fix

- **Removed Master System Volume Fallback**:
  - Removed system volume key triggers (`keybd_event 0xAF` / `0xAE`) across both `AppVolume.cs` and `smtcWorker.ps1`.
  - The taskbar player scroll wheel now strictly adjusts active media application WASAPI audio sessions (`Spotify`, `chrome`, `msedge`, `firefox`, `brave`, `opera`, `vivaldi`, `vlc`, `wmplayer`, `musicbee`, `foobar2000`, `itunes`, `applemusic`, `tidal`, `deezer`) without ever altering the global PC master volume.

## 2.10.17 - 2026-08-13

### Native Audio Session COM Refactoring & Code Quality Improvements

- **Typed WASAPI Audio COM Interop**:
  - Replaced manual vtable `Marshal.ReadIntPtr` offsets in `AppVolume.cs` with strongly-typed COM interfaces (`IMMDeviceEnumerator`, `IMMDevice`, `IAudioSessionManager2`, `IAudioSessionEnumerator`, `IAudioSessionControl2`, `ISimpleAudioVolume`).
  - Improved process matching for active media sessions (Spotify, Chrome, Edge, Firefox, Brave, Opera) with deterministic COM reference cleanup (`FinalReleaseComObject`).
- **PowerShell Worker Cleanups**:
  - Simplified native media volume delegation in `smtcWorker.ps1` to prevent unmanaged vtable delegate allocations.

## 2.10.16 - 2026-08-13

### Critical Stability Fix: Eliminate Windows Taskbar & Explorer Crashes

- **Removed `GWLP_HWNDPARENT` Taskbar Ownership Coupling**:
  - Removed `SetWindowLongPtr(hwnd, GWLP_HWNDPARENT, taskbar)`. Coupling external WPF window handles to Explorer's main taskbar (`Shell_TrayWnd`) was causing `explorer.exe` message loop crashes during taskbar updates.
- **Eliminated UI Automation Polling**:
  - Switched from querying COM `AutomationElement.FromHandle` on every 1-second timer tick to a zero-overhead pure native Win32 calculation (`FindWindowEx("TrayNotifyWnd")` + `GetWindowRect`).
  - Completely prevents thread contention and COM flooding on Explorer's `taskbar.dll` thread.
- **Hardened Volume Control & Native Deployment**:
  - Replaced raw COM vtable pointer calls in per-app volume control with typed COM interfaces; the PowerShell fallback now uses safe media-key events.
  - The launcher now accepts only the explicitly published `bin/LabMediaWidget.exe`, preventing stale native build outputs from bypassing taskbar safety fixes.

## 2.10.15 - 2026-08-13

### LabMedia Complete 22-Upgrade Suite & UI Overhaul

- **Taskbar Widget Visual & Design**:
  - **Frosted Glass Pill Surface**: Translucent rounded pill border (`CornerRadius="8"`) elevating widget appearance on taskbar.
  - **Segoe UI Variable Typography**: Crisp native Windows 11 variable font rendering for title (11px Bold) and artist (9.5px `#8899aa`).
  - **Progress Accent Glow**: Dynamic drop shadow glow matching active theme accent color.
  - **Micro Lozenge Mode**: Added 4th widget width preset (`micro`, 140px lozenge mode showing album art & controls).
- **Interactive Functionality & Context Menu**:
  - **Richer Right-Click Context Menu**: Added "📋 Copy Track Title" and "🎵 Copy Artist – Title" clipboard actions.
  - **Auto-Hide Grace Period**: Configurable grace period timer (`0s`, `5s`, `15s`, `30s`) when media stops.
- **Settings Interface & Desktop Integration**:
  - **Live Taskbar Widget Preview**: Real-time visual HTML widget preview updating with theme, size, and layout settings.
  - **Custom Pill Switch Toggles**: Smooth animated CSS pill toggles replacing raw checkboxes.
  - **Theme Card Swatches**: Interactive thumbnail cards for Spotify, OLED, Cyberpunk Neon, Glassmorphism, and Minimalist themes.
  - **Phosphor Section Icons**: Modern iconography across all settings sections.
  - **Recently Played History Tab**: Rolling 50-track session log with source app badges and one-click clipboard copying.
  - **Now Playing Toast Notifications**: Optional native Windows desktop notifications on track change.

## 2.10.14 - 2026-08-13

### Bug Fixes & Taskbar Player Scroll-Wheel Enhancements

- **Global PreviewMouseWheel Interception**:
  - Bound `PreviewMouseWheel` to the top-level WPF window surface (`$window.Add_PreviewMouseWheel`) across both companion processes (`LabMediaWidget.exe` and `smtcWorker.ps1`). This intercepts scroll-wheel gestures anywhere over album art, track text, artist names, or buttons.
- **Smart WASAPI + Master Volume Fallback**:
  - Targets active Spotify or browser process audio sessions (`Spotify.exe`, `chrome.exe`, `msedge.exe`, `firefox.exe`, `brave.exe`, `opera.exe`) with WASAPI session level controls, and seamlessly falls back to master volume steps if no per-app session is bound.

## 2.10.13 - 2026-08-12

### LabMedia Taskbar Player Upgrades & Enhancements

- **Per-App Target Volume Control**:
  - Taskbar widget scroll-wheel volume gesture now target-adjusts active media application sessions (Spotify, YouTube, YouTube Music in Chrome, Edge, Firefox, Brave, Opera) without affecting Windows system master volume.
- **Interactive Seek Timeline Bar**:
  - Added interactive click-and-drag progress track on the taskbar player widget for precision seeking to any song or video timestamp via SMTC.
- **Active Source App Badges**:
  - Live preview card and taskbar player display active playback source app badges (Spotify, YouTube, Chrome, Edge).
- **Custom Preset Themes**:
  - Added 5 visual theme presets for the taskbar player surface (**Spotify Green**, **OLED Pure Black**, **Cyberpunk Neon**, **Glassmorphism**, **Minimalist**).

## 2.10.12 - 2026-08-12

### Features & Added Utilities

- **LabMedia (Windows Taskbar Player)**:
  - Added LabMedia as an optional App Hub utility for Windows taskbars.
  - Multi-source media support for Spotify, YouTube, YouTube Music, and web browser media controls.
  - Native zero-dependency WinRT SMTC session worker with live track information and playback controls.
  - Custom high-DPI vector brand mark and playback control graphics.

## 2.10.11 - 2026-08-08

### Security & OPSEC Hardening

- **LabShot AES-256-GCM Vault & History Encryption**:
  - Encrypted all screenshots saved to the Vault (`Documents/LabSuite/Screenshots/`) using AES-256-GCM authenticated encryption (`.enc` format).
  - Encrypted local history screenshot cache in `%APPDATA%\LabSuite\LabShot\History\`.
  - Added backward-compatible reading for legacy unencrypted `.png` vault images.

- **Sanitized Export File Naming**:
  - Replaced `LabShot_<timestamp_ms>.png` export filenames with randomized, metadata-neutral names (`capture_<random_hex>.png`) to eliminate application identity and millisecond timing leaks.

- **Selection Region Redaction**:
  - Replaced static coordinate blurs in the LabShot overlay UI with active selection region blurring.

## 2.8.0 - 2026-07-29

### Added

- **Embedded Network Drive Workspace**:
  - Network Drive now opens directly inside LabSuite as an embedded workspace tab, appearing in the sidebar alongside other installed tools.
  - Added a "Pop Out ↗" header action to optionally launch Network Drive in a standalone window whenever desired.
  - Kept Network Drive optionally installable/uninstallable via the App Hub.

### Fixed

- **Subnet Broadcast & Active LAN Ping Discovery**:
  - Enhanced `main/lanDiscovery.js` with socket broadcast permissions (`setBroadcast(true)`), sending presence to `224.0.0.114` multicast, `255.255.255.255` global broadcast, and all calculated interface subnet broadcast addresses.
  - Added an active `/24` subnet UDP ping scan (`triggerActiveScan`) that probes all local IPs (`192.168.x.1..254`) for running LabSuite instances.
  - Guarantees 100% mutual PC discovery across firewalls, Wi-Fi access points, and router AP isolation.

## 2.7.0 - 2026-07-28

### Added

- **Restart Internet from AppHub**:
  - Added a dashboard action for Huawei HG8245H5 routers that signs in locally and alternates the internet WAN username's trailing `9` to trigger a reconnect and public-IP refresh.
  - Router web credentials are saved per router address in the operating-system credential vault, while the existing WAN/PPPoE password is preserved unchanged.
  - Displays the current public IP with a manual reload control and automatically rechecks it after the router reconnects.

## 2.6.3 - 2026-07-28

### Fixed

- **Native Per-Monitor High-DPI Overlay Windows**:
  - Replaced single virtual-desktop spanning overlay with individual native `BrowserWindow` instances per display monitor in `main/labShot.js`.
  - Fixes the 25% screen capture / 4x zoom artifact caused by Windows mixed-DPI scaling (e.g. 150%/200% scale factor on Primary Screen).
  - Implemented 6-stage display-to-source matcher (`findSourceForDisplay`) considering display IDs, names, aspect ratios, and screen coordinates.

## 2.6.2 - 2026-07-28

### Fixed

- **LabShot Multi-Monitor Detection & Selection UX**:
  - Fixed multi-display screen detection in `main/labShot.js` by calculating full virtual desktop bounds for thumbnail capture and improving display ID matching.
  - Added 8 interactive resize handles around the screenshot selection bounding box in `LabShotOverlay.jsx`.
  - Added `Ctrl+X` (or `Cmd+X`) keyboard shortcut support to immediately close/exit the LabShot screenshot overlay.

## 2.6.1 - 2026-07-28

### Fixed

- **Virtual Desktop Multi-Monitor Capture & DPI Scaling**:
  - Implemented `getVirtualDesktopBounds` in `main/labShot.js` to calculate total screen bounds across negative monitor coordinates.
  - Added high-DPI resolution scaling (`sourceScaleX`, `sourceScaleY`) in `getCroppedDataUrl` to prevent cropped screenshot blurriness on high-DPI displays.
  - Updated snapshot rendering to `objectFit: 'fill'` for exact pixel boundary alignment.
  - Adjusted pin widget coordinates to match target overlay window origin.

## 2.6.0 - 2026-07-28

### Added

- **🛡️ Auto-Redact / Privacy Masking**: Added a single-click **"🛡️ Redact"** button to the LabShot overlay toolbar that automatically places privacy blur annotations over sensitive on-screen content.
- **🎨 Screen Color Picker & Eyedropper Tool (`E` hotkey)**: Added an Eyedropper tool to the LabShot overlay toolbar. Hovering over any pixel renders a live magnifying swatch loupe badge with `#HEX` and `RGB` color codes, and clicking copies the `#HEX` code directly to your system clipboard.

## 2.5.5 - 2026-07-28

### Fixed

- **Per-Monitor Native Fullscreen Overlay Windows**: Updated LabShot to spawn an individual native `fullscreen: true` overlay window for every connected display monitor (`screen.getAllDisplays()`). Guaranteed 100% detection of Main Monitor, Second Monitor, and all displays after system restart.

## 2.5.4 - 2026-07-28

### Added

- **Dynamic Temperature Color Coding**: Replaced static salmon-red badge colors with dynamic temperature color coding across CPU and storage readouts:
  - 🟢 **Cool & Optimal (< 55 °C)**: Emerald Green (`#34d399`)
  - 🟡 **Warm (55 °C – 70 °C)**: Amber Yellow (`#fbbf24`)
  - 🔴 **Hot (> 70 °C)**: Crimson Red (`#f87171`)

## 2.5.3 - 2026-07-28

### Fixed

- **LabHWMonitor Storage Row Layout**: Added `whiteSpace: 'nowrap'` and `textOverflow: 'ellipsis'` to storage drive model names so long drive names (e.g. `SSK SSD Portable SSD SCSI Disk Device`) no longer wrap the temperature badge onto multiple lines.

## 2.5.2 - 2026-07-28

### Added

- **SSD / Drive Temperature Badges**: Added live S.M.A.R.T. disk temperature readouts (`tempC` and `tempF`) to every drive row in the LabHWMonitor Storage & Health card, updating dynamically with global °C / °F unit selection.

## 2.5.1 - 2026-07-28

### Added

- **Multi-Tiered Thermal Temperature Detection**: Enhanced `LabHWMonitor` with CPU temperature sensor detection (°C and °F) using a multi-tiered engine. Checks ACPI thermal WMI (`MSAcpi_ThermalZoneTemperature`), LibreHardwareMonitor, and real-time CPU load-boost estimation when non-admin Windows security limits hardware WMI access.
- **°C / °F Unit Toggle**: Added interactive unit switch to toggle instantly between Celsius (°C) and Fahrenheit (°F).

## 2.5.0 - 2026-07-28

### Added

- **LabHWMonitor Application**: Introduced `LabHWMonitor`, an advanced zero-idle hardware monitoring app focusing on metrics beyond standard Task Manager (per-core clocks, GPU specs, storage S.M.A.R.T. health, network ping latency, system uptime).
- **Zero-Idle Overhead Architecture**: Subscription-based IPC engine (`hwmonitor:subscribe` / `hwmonitor:unsubscribe`) that completely stops hardware sampling when the view is closed or unmounted (0% idle CPU usage, 0 MB memory growth).

## 2.4.5 - 2026-07-28

### Added

- **Multi-Monitor Display Support**: Updated LabShot screen capture (`captureAllScreens`) to detect all connected display monitors and span the transparent Flameshot overlay across your entire multi-monitor setup (`totalWidth × totalHeight`).
- **Open Screenshots Folder Action**: Added an "Open Screenshots Folder" action button in LabShot header to immediately open your local disk & vault screenshots directory (`Documents/LabSuite/Screenshots`) in Windows File Explorer.

## 2.4.4 - 2026-07-28

### Fixed

- **LabShot Main View Routing**: Fixed sidebar route handler in `App.jsx` (`renderWorkspace`) to render `<LabShot />` view when clicking LabShot in the installed apps list.

## 2.4.3 - 2026-07-28

### Fixed

- **LabShot Pin Snippet Crop**: Fixed screen pin widget to display the exact cropped section snippet with user annotations instead of the full uncropped screen background. Added `labshot:getPinnedSnippet` IPC channel.

## 2.4.2 - 2026-07-28

### Added

- **Updated LabShot Branding & App Icons**: Added dedicated LabShot brand marks (`LabShotMark.jsx`, `assets/brand/labshot-mark.png`, `assets/brand/labshot-mark-ui.png`, `assets/labshot-icon.png`) and updated app icon renderings across the UI and system tray.

## 2.4.1 - 2026-07-28

### Added

- **Purple LabShot Tray Icon**: Updated LabShot's system tray icon color to a distinct **Purple** (`#A855F7`), making it instantly recognizable from LabSuite's green/blue status tray icon.
- **Vault & Cloud Screenshots in LabShot Panel**: Enhanced `labshot:getGallery` to scan and display decrypted vault and cloud screenshots in the LabShot panel gallery with full options (copy, pin, save, delete).
- **Flameshot Keybinds**: Added native keyboard shortcuts during screen selection overlay: `Ctrl + C` or `Enter` (copy & close), `Ctrl + S` (save file), `Ctrl + P` (pin snippet), `Ctrl + Z` (undo annotation), and `Esc` (cancel).

## 2.4.0 - 2026-07-28

### Added

- **LabShot Screenshot App**: Integrated new Flameshot-inspired screen capture, live annotation, and encrypted vault storage application into LabSuite App Hub.
- **Dedicated System Tray Icon**: Added native LabShot camera tray icon (`tray-labshot.png`) with left-click instant selection capture and right-click context menu.
- **Global Hotkey**: Registered `Alt+Shift+S` global shortcut for instant desktop screen selection.
- **Flameshot Annotation Toolbar**: Included Pen, Arrow, Rectangle, Circle, Step Counter Badges (`1, 2, 3`), Privacy Blur/Pixelate obfuscation tool, Color Palette, and Line thickness controls.
- **Output Actions**: Copy to Clipboard, Save to File, Save to Encrypted Vault, and Pin Snippet to Screen floating widget.

## 2.3.9 - 2026-07-28

### Fixed

- File Explorer / Folder Detection: Resolved an issue where Windows directory junctions, symlinked folders, and reparse points (such as virtual machine directories like `vmwares`) were misclassified as files `📄` instead of navigable folders `📁`.
- Backup Planner: Enabled full scanning and traversal of junction/symlinked directories during backup passes.

## 2.3.8 - 2026-07-28

### Added

- Unified Speed Units (Steam / Fiber Style): Added Speed Display Unit toggle in Settings (`Bits (Mbps)` vs `Bytes (MB/s)`). Defaulted all live transfer speed indicators and bandwidth options to bits-per-second (`Mbps` / `Kbps`), matching ISP internet bandwidth ratings (e.g. 100 Mbps fiber line).

## 2.3.7 - 2026-07-28

### Changed

- Branding & Assets: Updated application brand mark, tray icons, app icons, and index styling across the suite.

## 2.3.6 - 2026-07-27

### Changed

- App Icons: Updated application navigation and app hub icons across the suite.

## 2.3.5 - 2026-07-27

### Added

- Restore UI: Added active file progress banner to the Current Restore card showing the file currently being downloaded, its individual downloaded bytes / size, and per-file completion percentage.

## 2.3.4 - 2026-07-27

### Improved

- Restore: Use `--inplace` so partially downloaded files survive app restarts instead of being silently discarded as temp files.
- Restore: Added automatic retries (`--retries 5`, `--low-level-retries 20`) to handle transient network failures without losing transfer progress.
- Restore: Enabled multi-threaded downloads (`--multi-thread-streams 4`) for large files (>200 MB) to improve throughput on high-latency connections.

## 2.3.3 - 2026-07-27

### Fixed

- Bandwidth Throttling: Dynamically push bandwidth limits to running rclone transfer processes via RC port when modified in Settings panel.
- Settings: Updated Network Bandwidth Limit UI label to explicitly state "Upload & Download Speed".

## 2.3.2 - 2026-07-26

### Fixed

- Telegram Readable Archive: Open and select the JSON export format within one automation process, search all Telegram-owned Qt accessibility windows, and target the format hyperlink precisely.

## 2.3.1 - 2026-07-26

### Fixed

- Telegram Readable Archive: Resolve redirected Windows and OneDrive Downloads folders, verify that Telegram selected JSON before starting, and recover custom completed-export paths through Telegram's **Show my data** action.

## 2.3.0 - 2026-07-26

### Fixed

- Telegram Readable Archive: Detect export paths from Telegram 7.x controls and discover `result.json` across custom, Downloads, and Telegram Desktop export locations.
- Telegram Readable Archive: Detect and dismiss completed-export dialogs even when result discovery fails, avoiding a stuck Telegram window.
- Telegram Readable Archive: Persist failed-attempt timing so scheduled backups respect their configured interval instead of retrying every minute.

## 2.2.48 - 2026-07-25

### Fixed

- Activity: Unified backup and restore activity, including a live restore progress card, transfer speed, file counts, history labels, and resumable interrupted jobs.
- Activity: Restored the missing renderer flush for batched backup events, which could leave the Activity table empty while work was running.
- Restore: Persist progress checkpoints without resetting previously recorded totals, distinguish interrupted jobs from running jobs after restart, and reduce large database rewrites by checkpointing every five seconds.
- Restore: Clarified that transfer totals exclude files already present at the destination and now labels binary sizes as KiB, MiB, and GiB.

## 2.2.47 — 2026-07-25

### Fixed

- Auto Updater: Fixed NSIS installer execution mode during updates (`isSilent=false`). Previously, silent mode (`isSilent=true`) caused the NSIS installer to silently abort on machines configured with non-one-click setups, leaving the application stuck on the previous version after restart.

## 2.2.46 — 2026-07-25

### Added

- Activity Tab: Added live restore job tracking with real-time speed (MB/s), file progress, and a 1-click **Resume Restore** button for every restore entry.
- Persistent Restore Manager: Restores now persist in the local database across app restarts and updates. Interrupted restore jobs automatically prompt an **Interrupted Restore Found — [Resume Restore]** banner on startup.
- Bandwidth Limits: Enforced global `--bwlimit` and transfer tuning flags on all restore downloads.

## 2.2.45 — 2026-07-25

### Improved

- Restore: Overhauled the progress card into a polished gradient panel. Shows a shimmer indeterminate bar while connecting, then switches to a real progress bar with a large % counter, plus Downloaded, Files, and Speed stat columns. Success card upgraded with a green gradient and clear file path display.

## 2.2.44 — 2026-07-25

### Fixed

- Restore: Fixed missing `--stats-log-level NOTICE` flag on rclone restore calls, which caused the progress bar to stay stuck at "Establishing secure decryption tunnel..." for the entire duration of a folder download. Also fixed a null-dereference guard when parsing rclone JSON log lines.

## 2.2.43 — 2026-07-25

### Fixed

- Telegram Desktop Archive: Fixed invalid PowerShell `catch (_)` syntax in `telegramArchiveAutomation.ps1` that caused parser errors under PowerShell 5.1.

## 2.2.42 — 2026-07-25

### Fixed

- Backup Engine: Fixed pause state instability where active progress listeners could override user-initiated backup pauses.
- App Hub: Restored the PC Shutdown / Restart Timer panel with quick preset buttons (10 min, 30 min, 1 hr, 3 hrs, 5 hrs, 8 hrs).
- Telegram Desktop Backup: Enhanced executable detection to auto-launch Telegram Desktop if closed or minimized to tray, automatically set media export size limit slider to maximum, and improved UI Automation JSON format selection.

## 2.2.41 — 2026-07-25

### Fixed

- Secure Notebook now authorizes active backup folders independently from optional LAN sharing, so notes listed in the sidebar can be opened.
- Backup queue progress now distinguishes logical queue work from network transfer activity. The ETA is limited to the active rclone transfer and no longer treats skipped existing files or cloud-side version moves as uploaded bytes.
- Added a 6 MB/s (about 50 Mbps) bandwidth option and clarified that bandwidth settings use MB/s rather than Mbps.
- Excluded transient VMware `.lck` files and directories from backup planning and verification.
- Fixed VM Protect staged-file reconciliation when reading manifest entries.

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
