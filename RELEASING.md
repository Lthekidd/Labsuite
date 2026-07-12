# Releasing LabSuite updates

LabSuite uses GitHub Releases and `electron-updater` to deliver Windows updates. Packaged clients check shortly after startup and every six hours. Updates download in the background and install when LabSuite exits, avoiding interruption of an active backup.

## One-time setup

1. Push this source tree to the public repository `Lthekidd/Labsuite`. The repository is currently empty, so review the files before the first push. Local databases, rclone credentials, binaries, build outputs, and installers are excluded by `.gitignore`.
2. In **Settings → Actions → General**, keep workflow permissions set to read/write, or rely on the workflow's `contents: write` permission if organization policy allows it.

LabSuite currently uses unsigned personal-use installers, so no paid Authenticode certificate or signing secrets are required. Windows will display an **Unknown publisher** warning during installation. Only install releases published from your own `Lthekidd/Labsuite` repository.

Never commit a Google token, `rclone.conf`, LabSuite database, or any other private credential.

## Publish an update

1. Update the semantic version in `package.json` and `package-lock.json`.
2. Add the release notes to `CHANGELOG.md`.
3. Commit and push the tested source to `main`.
4. Create and push a matching tag. For version `2.2.1`:

   ```powershell
   git tag v2.2.1
   git push origin main
   git push origin v2.2.1
   ```

5. GitHub Actions runs the test suite, builds the unsigned NSIS installer, verifies `latest.yml` and the blockmap, and creates a **draft** release.
6. Download and test the draft installer on one computer.
7. In GitHub **Releases**, edit the draft and click **Publish release**. Only this final action makes the update visible to installed clients.

## Client behavior

- Updates are detected only by packaged installations, not `npm run dev`.
- A computer must be online and LabSuite must run long enough to perform a check.
- Publishing does not forcibly restart LabSuite. The update installs on the next normal exit, protecting in-progress backup work.
- GitHub Releases must include the installer, its `.blockmap`, and `latest.yml`; deleting or renaming any of them breaks update discovery.
- Keep the repository public for token-free client checks. A private GitHub update repository would require distributing credentials and is not recommended for desktop clients.
