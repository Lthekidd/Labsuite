const decryptScriptText = `#!/usr/bin/env python3
import os
import sys
import platform
import urllib.request
import zipfile
import tarfile
import subprocess
import tempfile
import shutil
import getpass
import hashlib

RCLONE_VERSION = "1.75.2"

def get_rclone_download_url():
    system = platform.system().lower()
    machine = platform.machine().lower()
    version_tag = RCLONE_VERSION if RCLONE_VERSION.startswith("v") else f"v{RCLONE_VERSION}"
    
    if system == "windows":
        if "arm64" in machine or "aarch64" in machine:
            arch = "arm64"
        elif "64" in machine:
            arch = "amd64"
        else:
            arch = "386"
        return f"https://downloads.rclone.org/{version_tag}/rclone-{version_tag}-windows-{arch}.zip", "zip", "rclone.exe"
    elif system == "darwin":
        arch = "amd64" if "x86_64" in machine else "arm64"
        return f"https://downloads.rclone.org/{version_tag}/rclone-{version_tag}-osx-{arch}.zip", "zip", "rclone"
    elif system == "linux":
        if "aarch64" in machine or "arm64" in machine:
            arch = "arm64"
        elif "64" in machine:
            arch = "amd64"
        else:
            arch = "386"
        return f"https://downloads.rclone.org/{version_tag}/rclone-{version_tag}-linux-{arch}.zip", "zip", "rclone"
    else:
        print(f"[-] Unsupported operating system: {system}")
        sys.exit(1)

def verify_checksum(archive_path, archive_filename):
    version_tag = RCLONE_VERSION if RCLONE_VERSION.startswith("v") else f"v{RCLONE_VERSION}"
    sums_url = f"https://downloads.rclone.org/{version_tag}/SHA256SUMS"
    try:
        sums_req = urllib.request.Request(sums_url, headers={"User-Agent": f"rclone/{version_tag}"})
        with urllib.request.urlopen(sums_req) as resp:
            sums_text = resp.read().decode("utf-8", errors="replace")
        expected_hash = None
        for line in sums_text.splitlines():
            parts = line.strip().split()
            if len(parts) >= 2 and parts[-1].lstrip("*") == archive_filename:
                expected_hash = parts[0].lower()
                break
        if not expected_hash:
            print(f"[-] Could not find {archive_filename} in upstream SHA256SUMS.")
            sys.exit(1)

        hasher = hashlib.sha256()
        with open(archive_path, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                hasher.update(chunk)
        actual_hash = hasher.hexdigest().lower()
        if actual_hash != expected_hash:
            print(f"[-] Checksum mismatch for {archive_filename}: expected {expected_hash}, got {actual_hash}")
            sys.exit(1)
        print(f"[*] Verified SHA256 checksum for {archive_filename}.")
    except Exception as e:
        print(f"[-] Checksum verification failed: {e}")
        sys.exit(1)

def download_and_extract(url, archive_type, binary_name, dest_dir):
    version_tag = RCLONE_VERSION if RCLONE_VERSION.startswith("v") else f"v{RCLONE_VERSION}"
    archive_filename = url.split("/")[-1]
    archive_path = os.path.join(dest_dir, f"rclone_archive.{archive_type}")
    print(f"[*] Downloading rclone {RCLONE_VERSION} from {url}...")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": f"rclone/{version_tag}"})
        with urllib.request.urlopen(req) as resp, open(archive_path, "wb") as out_file:
            shutil.copyfileobj(resp, out_file)
    except Exception as e:
        print(f"[-] Failed to download rclone: {e}")
        sys.exit(1)

    verify_checksum(archive_path, archive_filename)

    print("[*] Extracting archive...")
    extracted_binary = None
    if archive_type == "zip":
        with zipfile.ZipFile(archive_path, 'r') as zip_ref:
            for member in zip_ref.namelist():
                if not member.endswith('/') and member.replace('\\\\', '/').split('/')[-1] == binary_name:
                    target_path = os.path.join(dest_dir, binary_name)
                    with zip_ref.open(member) as source, open(target_path, "wb") as target:
                        shutil.copyfileobj(source, target)
                    extracted_binary = target_path
                    break
    
    if not extracted_binary or not os.path.exists(extracted_binary):
        print("[-] Failed to find rclone binary inside the extracted files.")
        sys.exit(1)
        
    if platform.system().lower() != "windows":
        os.chmod(extracted_binary, 0o755)
        
    return extracted_binary

def main():
    print("====================================================")
    print("        LabSuite Zero-Knowledge Recovery Tool      ")
    print("====================================================")
    print("This script will decrypt and restore your files from")
    print("Google Drive without needing the LabSuite client installed.")
    print("----------------------------------------------------")
    
    password = getpass.getpass("Enter your LabSuite Master Password: ")
    if not password:
        print("[-] Password cannot be empty.")
        sys.exit(1)

    local_restore_path = input("Enter local directory to restore files to (e.g. C:\\\\Restore): ").strip()
    if not local_restore_path:
        print("[-] Local restore path cannot be empty.")
        sys.exit(1)
        
    if not os.path.exists(local_restore_path):
        os.makedirs(local_restore_path, exist_ok=True)

    temp_dir = tempfile.mkdtemp()
    try:
        url, archive_type, binary_name = get_rclone_download_url()
        rclone_bin = download_and_extract(url, archive_type, binary_name, temp_dir)
        
        config_path = os.path.join(temp_dir, "rclone.conf")
        print("[*] Generating temporary configuration...")
        
        print("\\n[*] Initializing Google Drive OAuth. Your browser will open to authorize access.")
        print("[*] Please complete the authorization in the browser.\\n")
        
        subprocess.run([
            rclone_bin, "--config", config_path,
            "config", "create", "gdrive", "drive", "scope=drive"
        ], check=True)
        
        subprocess.run([
            rclone_bin, "--config", config_path,
            "config", "create", "gdrive-crypt", "crypt",
            "remote=gdrive:LabSuite-Encrypted",
            "filename_encryption=standard",
            "directory_name_encryption=true",
            f"password={password}"
        ], check=True)
        
        print(f"\\n[*] Starting encrypted restore to: {local_restore_path}...")
        print("[*] This may take a while depending on your vault size and internet speed.\\n")
        
        cmd = [
            rclone_bin, "--config", config_path,
            "copy", "gdrive-crypt:/", local_restore_path,
            "--progress"
        ]
        
        subprocess.run(cmd, check=True)
        print("\\n[+] Decryption recovery complete!")
        print(f"[+] Files have been successfully restored to: {local_restore_path}")

    except KeyboardInterrupt:
        print("\\n[-] Operation cancelled by user.")
        sys.exit(130)
    except Exception as e:
        print(f"\\n[-] An unexpected error occurred: {e}")
        sys.exit(1)
    finally:
        print("[*] Cleaning up temporary files...")
        shutil.rmtree(temp_dir, ignore_errors=True)

if __name__ == '__main__':
    main()
`;

module.exports = { decryptScriptText };
