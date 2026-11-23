import assert from 'node:assert/strict';
import {mkdtempSync, openSync, closeSync, readFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publishTestMarker} from './publish-test-marker.mjs';

const dir=mkdtempSync(join(tmpdir(),'orange-marker-'));
try {
  // Check the old creation behavior through the same filesystem on which the driver runs.
  const old=join(dir,'old');
  const descriptor=openSync(old,'wx',0o600);
  try { assert.equal(readFileSync(old).length,0); } finally { closeSync(descriptor); }
  const current=join(dir,'receipt');
  const original=Buffer.from('5b6bce05-1e44-4b9b-9236-ddfcc0208662');
  publishTestMarker(current,original);
  assert.deepEqual(readFileSync(current),original);
  assert.equal(statSync(current).mode&0o777,0o600);
  assert.throws(()=>publishTestMarker(current,'replacement'),{code:'EEXIST'});
  assert.deepEqual(readFileSync(current),original);
  assert.deepEqual(readdirSync(dir).sort(),['old','receipt']);
  console.log('PASS complete private marker at first publication, no replacement or leftover attempt');
} finally {
  rmSync(dir,{recursive:true});
}
