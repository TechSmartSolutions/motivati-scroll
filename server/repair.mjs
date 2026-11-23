// One-off (and safe to repeat) repair: re-check downloaded videos and convert the ones iPhone cannot play.
// Uploaded files are left alone. Each file is checked once (`playableChecked`), so restarts are cheap.
import { promises as fs } from 'node:fs';
import { makePlayable } from './playable.mjs';

export async function repairLibrary(lib, log = console) {
  const todo = lib.list().filter((i) => i.kind === 'video' && i.source && !i.playableChecked);
  const stats = { checked: 0, fixed: 0, failed: 0 };
  for (const item of todo) {
    stats.checked++;
    try {
      const res = await makePlayable(lib.fileFor(item));
      if (res.output === lib.fileFor(item)) {
        await lib.mutate(async () => void (item.playableChecked = true));
        continue;
      }
      // New file name on purpose: media is served as immutable, and phones may have cached the broken one.
      const file = `${lib.newId()}.mp4`;
      const dest = `${lib.mediaDir}/${file}`;
      await fs.rename(res.output, dest);
      const { size } = await fs.stat(dest);
      const oldPath = lib.fileFor(item);
      await lib.mutate(async () => {
        item.file = file;
        item.size = size;
        item.playableChecked = true;
      });
      await fs.rm(oldPath, { force: true });
      stats.fixed++;
      log.log(`repaired ${item.name} (${res.action}: ${res.reason})`);
    } catch (e) {
      stats.failed++;
      log.error(`repair failed for ${item.name}: ${e.message}`);
    }
  }
  if (todo.length) log.log(`repair done: ${stats.checked} checked, ${stats.fixed} fixed, ${stats.failed} failed`);
  return stats;
}
