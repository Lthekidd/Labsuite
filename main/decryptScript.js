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

RCLONE_VERSION = "v1.74.4"

def get_rclone_download_url():
    system = platform.system().lower()
    machine = platform.machine().lower()
    
    if system == "windows":
        arch = "amd64" if "64" in machine else "386"
        return f"https://downloads.rclone.org/{RCLONE_VERSION}/rclone-{RCLONE_VERSION}-windows-{arch}.zip", "zip", "rclone.exe"
    elif system == "darwin":
        arch = "amd64" if "x86_64" in machine else "arm64"
        return f"https://downloads.rclone.org/{RCLONE_VERSION}/rclone-{RCLONE_VERSION}-osx-{arch}.zip", "zip", "rclone"
    elif system == "linux":
        arch = "amd64" if "64" in machine else "386"
        return f"https://downloads.rclone.org/{RCLONE_VERSION}/rclone-{RCLONE_VERSION}-linux-{arch}.zip", "zip", "rclone"
    else:
        print(f"[-] Unsupported operating system: {system}")
        sys.exit(1)

def download_and_extract(url, archive_type, binary_name, dest_dir):
    archive_path = os.path.join(dest_dir, f"rclone_archive.{archive_type}")
    print(f"[*] Downloading rclone {RCLONE_VERSION} from {url}...")
    try:
        urllib.request.urlretrieve(url, archive_path)
    except Exception as e:
        print(f"[-] Failed to download rclone: {e}")
        sys.exit(1)

    print("[*] Extracting archive...")
    extracted_binary = None
    if archive_type == "zip":
        with zipfile.ZipFile(archive_path, 'r') as zip_ref:
            for member in zip_ref.namelist():
                if member.endswith(binary_name):
                    source = zip_ref.open(member)
                    target_path = os.path.join(dest_dir, binary_name)
                    with open(target_path, "wb") as target:
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
        ])
        
        subprocess.run([
            rclone_bin, "--config", config_path,
            "config", "create", "gdrive-crypt", "crypt",
            "remote=gdrive:LabSuite-Encrypted",
            "filename_encryption=standard",
            "directory_name_encryption=true",
            f"password={password}"
        ])
        
        print(f"\\n[*] Starting encrypted restore to: {local_restore_path}...")
        print("[*] This may take a while depending on your vault size and internet speed.\\n")
        
        cmd = [
            rclone_bin, "--config", config_path,
            "copy", "gdrive-crypt:/", local_restore_path,
            "--progress"
        ]
        
        subprocess.run(cmd)
        print("\\n[+] Decryption recovery complete!")
        print(f"[+] Files have been successfully restored to: {local_restore_path}")

    except KeyboardInterrupt:
        print("\\n[-] Operation cancelled by user.")
    except Exception as e:
        print(f"\\n[-] An unexpected error occurred: {e}")
    finally:
        print("[*] Cleaning up temporary files...")
        shutil.rmtree(temp_dir, ignore_errors=True)

if __name__ == '__main__':
    main()
`;

module.exports = { decryptScriptText };
