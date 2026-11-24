import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SLOTS_DIR } from './config.js';
import { ensureDir } from './fsutil.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Live slot records across every HQ engine on the machine; stale ones are removed. */
export function liveSlots(dir = SLOTS_DIR) {
  ensureDir(dir);
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const pid = Number.parseInt(name, 10);
    if (Number.isFinite(pid) && isPidAlive(pid)) {
      out.push({ file, pid, name });
    } else {
      fs.rmSync(file, { force: true });
    }
  }
  return out;
}

function slotTs(file) {
  try {
    return Number(JSON.parse(fs.readFileSync(file, 'utf8')).ts) || Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER; // released between readdir and read: rank it last
  }
}

export function freeMemMB() {
  return Math.round(os.freemem() / 1048576);
}

/**
 * Wait for a global Claude-process slot. RAM-aware: a slot is granted only when fewer than
 * maxProcesses are live AND free memory is above the floor, except that when nothing at all is
 * running the floor is waived after starvationGraceSec so work cannot stall forever.
 */
export async function acquireSlot(opts) {
  const {
    maxProcesses, minFreeMemMB, starvationGraceSec = 30, pollMs = 2000,
    label = '', onWait, isStopped, dir = SLOTS_DIR, memFn = freeMemMB,
  } = opts;
  const start = Date.now();
  for (;;) {
    if (isStopped?.()) throw Object.assign(new Error('stopped'), { code: 'stopped' });
    const live = liveSlots(dir);
    const free = memFn();
    const starving = live.length === 0 && (Date.now() - start) / 1000 >= starvationGraceSec;
    if (live.length < maxProcesses && (free >= minFreeMemMB || starving)) {
      const file = path.join(dir, `${process.pid}-${randomUUID()}`);
      try {
        fs.writeFileSync(file, JSON.stringify({ pid: process.pid, label, ts: Date.now() }));
        // Two engines can pass the check together; order by (ts, name) and the later one backs off.
        const rank = liveSlots(dir).map((s) => ({ ...s, ts: slotTs(s.file) }))
          .sort((a, b) => a.ts - b.ts || a.name.localeCompare(b.name));
        if (rank.findIndex((s) => s.file === file) < maxProcesses) {
          return { file, lowMemory: free < minFreeMemMB, freeMB: free };
        }
      } catch { /* a concurrent release raced us; retry below */ }
      fs.rmSync(file, { force: true });
    }
    onWait?.({ live: live.length, freeMB: free });
    await sleep(pollMs);
  }
}

export function releaseSlot(slot) {
  if (slot?.file) fs.rmSync(slot.file, { force: true });
}
