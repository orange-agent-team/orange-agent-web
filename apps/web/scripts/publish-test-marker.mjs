// Existence is the reader's completion signal. Never expose a partially written
// quote/operation identity or replace an already-observed test intent.
import {linkSync, unlinkSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

export function publishTestMarker(path, data) {
  const temporary = path + '.' + randomUUID() + '.pending';
  writeFileSync(temporary, data, {mode:0o600, flag:'wx'});
  try {
    linkSync(temporary, path);
  } finally {
    unlinkSync(temporary);
  }
}
