#!/usr/bin/env python3
"""Private loopback test certificate; no system trust-store modification."""
import os
from pathlib import Path
import subprocess
root=Path(__file__).resolve().parents[1]/'.local/tls'
root.mkdir(parents=True,exist_ok=True,mode=0o700);os.umask(0o077)
if not (root/'key.pem').exists() or not (root/'cert.pem').exists():
    subprocess.run(['/opt/homebrew/opt/openssl@3/bin/openssl','req','-x509','-newkey','rsa:2048','-noenc',
        '-keyout',str(root/'key.pem'),'-out',str(root/'cert.pem'),'-days','30','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],
        stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True)
print('Local user Web test TLS files ready; no system trust changes')
