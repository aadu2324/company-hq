const AGENT_TOOLS = new Set(['Agent', 'Task']);

export function isAgentTool(name) {
  return AGENT_TOOLS.has(name);
}

/** Convert one `claude -p --output-format stream-json` line into normalised events. */
export function parseStreamLine(line) {
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  const parent = j.parent_tool_use_id || null;
  if (j.type === 'system' && j.subtype === 'init') {
    return [{ kind: 'init', sessionId: j.session_id, model: j.model }];
  }
  if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
    return j.message.content.flatMap((c) => {
      if (c.type === 'tool_use') return [{ kind: 'tool', id: c.id, name: c.name, input: c.input || {}, parent }];
      if (c.type === 'text' && c.text?.trim()) return [{ kind: 'text', text: c.text, parent }];
      return [];
    });
  }
  if (j.type === 'user' && Array.isArray(j.message?.content)) {
    return j.message.content
      .filter((c) => c.type === 'tool_result')
      .map((c) => ({ kind: 'tool_result', id: c.tool_use_id, isError: Boolean(c.is_error), parent }));
  }
  if (j.type === 'result') {
    return [{
      kind: 'result',
      ok: j.subtype === 'success' && !j.is_error,
      sessionId: j.session_id,
      result: typeof j.result === 'string' ? j.result : '',
      structured: j.structured_output ?? null,
      cost: Number(j.total_cost_usd) || 0,
      turns: j.num_turns,
    }];
  }
  return [];
}

/** Pull a JSON object out of free text (fenced block first, then outermost braces). */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  return null;
}

export function isAuthFailure(text) {
  return /failed to authenticate|oauth session expired|please run \/login|not logged in/i.test(text || '');
}

// Claude's own wording when a plan's usage limit stops a session, e.g.
// "You've hit your 5-hour limit · resets 4:20pm (America/Chicago)". Only ever tested against the
// text of a FAILED result, so a task that is about rate limiting never trips it.
const USAGE_LIMIT = /you['’]?ve hit your [^.\n]*limit|usage limit (reached|exceeded)|limit[^.\n]*\bresets?\b/i;
const RESETS = /\bresets?\s+(?:at\s+)?([^·\n]+?)\s*$/im;

export function isUsageLimit(text) {
  return USAGE_LIMIT.test(text || '');
}

/** "4:20pm (America/Chicago)" from a usage-limit message, or '' when it does not say. */
export function limitResetText(text) {
  return (RESETS.exec(String(text || '').replace(/Â/g, ''))?.[1] || '').trim();
}
