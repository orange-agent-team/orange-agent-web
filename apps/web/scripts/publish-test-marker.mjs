// Existence is the reader's completion signal. Never expose a partially written
// quote/operation identity or replace an already-observed test intent.
import {closeSync, linkSync, openSync, unlinkSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

export function publishTestMarker(path, data) {
  const temporary = path + '.' + randomUUID() + '.pending';
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, data);
    } finally {
      closeSync(fd);
    }
    linkSync(temporary, path);
  } finally {
    unlinkSync(temporary);
  }
}
