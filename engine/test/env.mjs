// Loaded before every test file (node --import): the engine's per-user folder (config, catalog override,
// process slots) points at a fresh temporary directory, so tests never share state with a real HQ run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.HQ_HOME) process.env.HQ_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hqhome-'));
