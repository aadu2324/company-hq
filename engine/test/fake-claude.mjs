// Stand-in for claude.exe in integration tests. Reads the prompt on stdin and emits
// stream-json like the real CLI: plan for the CEO, Agent delegation for managers,
// verdicts for review panels, and a decision for the board.
import fs from 'node:fs';

const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sid = `fake-${Math.random().toString(16).slice(2, 8)}`;
out({ type: 'system', subtype: 'init', session_id: sid });

const schema = args.includes('--json-schema') ? JSON.parse(args[args.indexOf('--json-schema') + 1]) : null;
const want = schema?.required || [];
let structured = null;

if (want.includes('tasks')) {
  structured = { goal: 'Launch landing page and outreach', doneMeans: 'drafts ready', questions: [], tasks: [
    { id: 'T1', department: 'web', title: 'Landing page', brief: 'build it', deliverable: 'page' },
    { id: 'T2', department: 'outreach', title: 'Cold emails', brief: 'draft them', dependsOn: ['T1'], reviewers: ['legal'] },
  ] };
} else if (want.includes('verdict')) {
  // First review of T1 asks for a revision; everything else is approved.
  const marker = `${process.env.FAKE_STATE_DIR}/reviewed-T1`;
  const isT1 = prompt.includes('Task T1');
  const revise = isT1 && !fs.existsSync(marker);
  if (isT1) fs.writeFileSync(marker, '1');
  structured = revise ? { verdict: 'revise', score: 5, summary: 'needs alt text', issues: ['add alt text'] } : { verdict: 'approve', score: 9, summary: 'good' };
} else if (want.includes('decision')) {
  structured = { decision: 'approve_with_conditions', summary: 'Ship after owner reviews emails.', concerns: ['verify addresses'] };
} else {
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'w1', name: 'Agent', input: { subagent_type: 'co-copywriter', description: 'write copy' } }] } });
  out({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'w1', is_error: false }] } });
  const m = prompt.match(/Write your deliverable summary to: (.+)/);
  if (m) fs.writeFileSync(m[1].trim(), `# done\n${prompt.includes('REVISION') ? 'revised' : 'first pass'}\n`);
}
out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'ok', total_cost_usd: 0.01, structured_output: structured });
