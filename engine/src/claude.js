import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { parseStreamLine, extractJson, isAuthFailure, isUsageLimit, limitResetText } from './stream.js';

/** { limited, resets } for the text of a failed process, or nothing when it was not the usage limit. */
function limitOf(text) {
  return isUsageLimit(text) ? { limited: true, resets: limitResetText(text) } : {};
}

export const AUTH_HELP = 'Claude CLI is not logged in. Open a terminal, run `claude`, then type /login.';
const DEFAULT_TIMEOUT_MS = 90 * 60 * 1000;

export function buildArgs(o) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (o.model) args.push('--model', o.model);
  if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
  if (o.name) args.push('-n', o.name);
  if (o.systemPromptFile) args.push('--append-system-prompt-file', o.systemPromptFile);
  if (o.schema) args.push('--json-schema', JSON.stringify(o.schema));
  if (o.resume) args.push('--resume', o.resume);
  if (o.disallowedTools?.length) args.push('--disallowedTools', o.disallowedTools.join(','));
  if (o.effort) args.push('--effort', o.effort);
  // Isolated: no MCP servers and no skills in the process; a settings file can turn off hooks.
  if (o.isolate) args.push('--strict-mcp-config', '--disable-slash-commands');
  if (o.settingsFile) args.push('--settings', o.settingsFile);
  return args;
}

/** Kill a process and all its children (Claude spawns MCP servers and hooks). */
export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } else {
      // The engine is started detached, so it leads a process group holding every claude it
      // spawned: -pid stops that whole tree. A claude child leads no group, so its descendants
      // (MCP servers, hooks) are found with pgrep and signalled before the child itself.
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        for (const child of posixDescendants(pid)) {
          try { process.kill(child, 'SIGTERM'); } catch { /* already gone */ }
        }
        process.kill(pid, 'SIGTERM');
      }
    }
  } catch { /* already gone */ }
}

const MAX_TREE_DEPTH = 6;

/** Every descendant pid of pid on macOS/Linux, deepest first; empty if pgrep is unavailable. */
export function posixDescendants(pid, depth = 0) {
  if (depth >= MAX_TREE_DEPTH) return [];
  const out = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  if (out.error || out.status !== 0) return [];
  const children = out.stdout.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return children.flatMap((c) => [...posixDescendants(c, depth + 1), c]);
}

/**
 * Run one headless Claude Code process. The prompt goes over stdin, so there is no
 * command-line length or quoting limit. Resolves (never rejects) with a summary.
 * Aborts (signal) and the watchdog (timeoutMs) kill the whole process tree.
 */
export function runClaude(o) {
  return new Promise((resolve) => {
    if (o.signal?.aborted) { resolve({ ok: false, error: 'aborted', aborted: true }); return; }
    const log = o.logFile ? fs.createWriteStream(o.logFile, { flags: 'a' }) : null;
    log?.on('error', () => {});
    let child;
    try {
      child = spawn(o.bin, buildArgs(o), {
        cwd: o.cwd,
        env: { ...process.env, ...(o.env || {}) },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, error: `could not start claude: ${err.message}` });
      return;
    }
    let buffer = '';
    let stderr = '';
    let final = null;
    let sessionId = null;
    let killedFor = null;
    const kill = (reason) => { killedFor = killedFor || reason; killTree(child.pid); };
    const onAbort = () => kill('aborted');
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const watchdog = setTimeout(() => kill('timed out'), o.timeoutMs || DEFAULT_TIMEOUT_MS);
    const handle = (line) => {
      log?.write(`${line}\n`);
      for (const ev of parseStreamLine(line)) {
        if (ev.kind === 'init') sessionId = ev.sessionId;
        if (ev.kind === 'result') final = ev;
        try { o.onEvent?.(ev); } catch (err) { stderr += `\nevent handler error: ${err.message}`; }
      }
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      lines.filter((l) => l.trim()).forEach(handle);
    });
    child.stderr.on('data', (c) => { stderr = (stderr + c.toString('utf8')).slice(-4000); });
    child.on('error', (err) => { stderr += `\n${err.message}`; });
    child.on('close', (code) => {
      clearTimeout(watchdog);
      o.signal?.removeEventListener('abort', onAbort);
      if (buffer.trim()) handle(buffer);
      log?.end();
      if (killedFor) { resolve({ ok: false, sessionId, error: `claude ${killedFor}`, aborted: killedFor === 'aborted' }); return; }
      if (!final) {
        const error = `claude exited (${code}) without a result. ${stderr.trim()}`.trim();
        resolve({ ok: false, sessionId, error, ...limitOf(stderr) });
        return;
      }
      const auth = isAuthFailure(final.result);
      const structured = final.structured ?? (o.schema ? extractJson(final.result) : null);
      const error = auth ? AUTH_HELP : (final.ok ? null : final.result || stderr.trim());
      resolve({
        ok: final.ok && !auth,
        sessionId: final.sessionId || sessionId,
        result: final.result,
        structured,
        cost: final.cost,
        error,
        auth,
        ...(final.ok || auth ? {} : limitOf(`${final.result}\n${stderr}`)),
      });
    });
    child.stdin.on('error', () => { /* process exited early; close handler reports it */ });
    child.stdin.end(o.prompt);
  });
}
