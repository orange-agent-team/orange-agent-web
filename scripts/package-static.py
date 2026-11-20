#!/usr/bin/env python3
"""Reproduce a static client from two clean committed-source trees, then serve its archived bytes to Chrome."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import urlsplit

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument("--cache",type=Path,default=ROOT/".local/npm-cache")
parser.add_argument("--node",type=Path,default=Path.home()/".nvm/versions/node/v22.23.2/bin/node")
args=parser.parse_args()
if sys.version_info[:2]!=(3,12) or not __debug__:raise SystemExit("Python 3.12 with assertions required")
node=args.node.resolve()
if subprocess.check_output([node,"--version"],text=True).strip()!="v22.23.2":raise SystemExit("Pinned Node 22.23.2 required")
npm=node.parent.parent/"lib/node_modules/npm/bin/npm-cli.js"
cache=args.cache.resolve()
if not cache.is_dir():raise SystemExit("Prepare the lockfile's npm cache before the offline build")
commit=subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()
sha=lambda b:hashlib.sha256(b).hexdigest()

def assemble(tree, output):
    with tempfile.TemporaryFile() as src:
        subprocess.run(["git","archive",commit],cwd=ROOT,stdout=src,check=True);src.seek(0)
        with tarfile.open(fileobj=src) as tgz:tgz.extractall(tree,filter="data")
    apps=[p for p in (tree/"apps").iterdir() if p.name in ("web","admin") and (p/"package.json").is_file()]
    if len(apps)!=1:raise ValueError("Expected one standalone public Web or Admin app")
    app=apps[0]
    lock=(app/"package-lock.json").read_bytes()
    for name,package in json.loads(lock)["packages"].items():
        if not name:continue
        remote=urlsplit(package.get("resolved",""))
        if remote.scheme!="https" or remote.hostname!="registry.npmjs.org" or not package.get("integrity","").startswith("sha512-"):
            raise ValueError("Unpinned external package: "+name)
    env=dict(os.environ,PATH=str(node.parent)+os.pathsep+os.environ["PATH"],TZ="UTC",NPM_CONFIG_CACHE=str(cache),
             NPM_CONFIG_OFFLINE="true",NPM_CONFIG_AUDIT="false",NPM_CONFIG_FUND="false")
    for variable in ("ORANGE_ADMIN_TLS_DIR","ORANGE_WEB_TLS_DIR","ORANGE_ADMIN_API","ORANGE_USER_API"):
        env.pop(variable,None)
    subprocess.run([node,npm,"ci","--offline","--ignore-scripts","--no-audit","--no-fund"],cwd=app,env=env,check=True)
    subprocess.run([node,tree/"scripts/check.mjs"],cwd=tree,env=env,check=True)
    dist=app/"dist"
    inputs={}
    for f in sorted(dist.rglob("*")):
        if f.is_symlink():raise ValueError("Unexpected symlink in generated site")
        if not f.is_file():continue
        name=f.relative_to(dist).as_posix()
        if name.startswith(".vite/"):n="metadata/"+name.removeprefix(".vite/")
        elif name=="bundle-report.json":n="metadata/"+name
        else:n="site/"+name
        inputs[n]=f.read_bytes()
    if "site/index.html" not in inputs or not any(k.startswith("site/assets/") for k in inputs):raise ValueError("Missing client entry or assets")
    snapshot=(tree/"docs/contracts/snapshot.json").read_bytes()
    inputs["metadata/contract-snapshot.json"]=snapshot
    inputs["metadata/package-lock.json"]=lock
    inputs["DEPLOYMENT.md"]=(tree/"docs/static-distribution.md").read_bytes()
    manifest={"schema":"orange-static-release-v1","surface":app.name,"source":commit,
              "node":subprocess.check_output([node,"--version"],text=True).strip(),"npm":subprocess.check_output([node,npm,"--version"],text=True).strip(),
              "server_contract_source":json.loads(snapshot)["source_commit"],"lock_sha256":sha(lock),
              "sha256":{name:sha(data) for name,data in sorted(inputs.items())}}
    inputs["manifest.json"]=(json.dumps(manifest,indent=2)+"\n").encode()
    prefix="orange-"+app.name
    with output.open("xb") as raw,gzip.GzipFile(fileobj=raw,mode="wb",filename="",mtime=0) as gz,tarfile.open(fileobj=gz,mode="w") as archive:
        for name,data in sorted(inputs.items()):
            item=tarfile.TarInfo(prefix+"/"+name);item.size=len(data);item.mode=0o644
            archive.addfile(item,io.BytesIO(data))
    return app,manifest

dest=ROOT/".local/static-distributions";dest.mkdir(mode=0o700,parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(dir=dest,prefix=".verify-") as tmp:
    scratch=Path(tmp);outputs=[]
    for i in range(2):
        tree=scratch/str(i);tree.mkdir(mode=0o700);out=scratch/(str(i)+".tar.gz")
        app,manifest=assemble(tree,out);outputs.append(out)
    data=outputs[0].read_bytes()
    if data!=outputs[1].read_bytes():raise ValueError("Two isolated archives differ")
    with tarfile.open(outputs[0]) as tar:tar.extractall(scratch,filter="data")
    release=scratch/("orange-"+app.name)
    for name,expected in manifest["sha256"].items():
        if sha((release/name).read_bytes())!=expected:raise ValueError("Extracted file digest mismatch")
    smoke=json.loads(subprocess.check_output([node,app/"scripts/qualify-static-release.mjs",release,app.name],text=True,cwd=app))
    digest=sha(data);published=dest/f"orange-{app.name}-static-{digest[:16]}.tar.gz"
    if published.exists():
        if sha(published.read_bytes())!=digest:raise ValueError("Previously archived content differs")
    else:os.link(outputs[0],published)
    record={"archive":published.name,"sha256":digest,"bytes":len(data),"source":commit,"target":"static-"+app.name,
            "identical_archives":2,"clean_offline_npm_installs":2,"server_contract_source":manifest["server_contract_source"],
            "files":len(manifest["sha256"]),"smoke":smoke}
    published.with_suffix(".json").write_text(json.dumps(record,indent=2)+"\n")
    print(json.dumps(record))
