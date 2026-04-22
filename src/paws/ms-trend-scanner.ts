export const msTrendScannerPhaseInstructions = {
  observe:
    'Find concise, high-fit content opportunities for ClaudePaw. This is not a general news roundup.\n' +
    'Focus only on stories that could clearly become one of: a YouTube video, a newsletter item, or a LinkedIn post.\n' +
    'Prioritize AI agent security, LLM security, enterprise AI governance, agent-runtime risk, and security tools the operator can explain with authority.\n' +
    'Only include breach stories when there is a strong ClaudePaw angle beyond "big brand got hacked".\n' +
    'Exclude generic breach roundups, commodity CVEs, weakly sourced claims, repetitive vendor drama, and stories with no clear the operator angle.\n' +
    'Gather at most 5 candidate stories with headline, source, date, and the likely best target: youtube, newsletter, linkedin, or ignore.',
  analyze:
    'Compare candidate stories against previous cycle findings and only keep truly new opportunities.\n' +
    'Mark is_new=true only for stories NOT surfaced in a previous cycle.\n' +
    'Only emit a finding when there is one clear next step and one clear target: youtube, newsletter, or linkedin.\n' +
    'Hard cap: emit at most 3 findings total per cycle. If more qualify, keep the strongest 3 by fit + urgency.\n' +
    'Severity guide:\n' +
    '- 5 = must-cover in the next 24h; strong the operator angle; clear audience fit; clear action\n' +
    '- 4 = strong fit this week; good angle; worth logging, not urgent enough to interrupt\n' +
    '- 3 = interesting but too broad, crowded, or weakly differentiated\n' +
    '- 2 = minor note\n' +
    '- 1 = ignore / already covered\n' +
    'Do not score generic brand-name breach news above 3 unless the story has a concrete AI-agent, governance, or supply-chain angle the operator can own.\n' +
    'In each finding detail, include: Target, Why the operator, Recommended action, and Shelf life.',
  act:
    'Only act on severity 5 findings.\n' +
    'Send exactly one concise iMessage to 267-746-0682 summarizing the top opportunities.\n' +
    'Format:\n' +
    'MATTEI OPS: <N> timely content opportunity\n' +
    '1. [TARGET] <topic> - <recommended action>\n' +
    '2. [TARGET] <topic> - <recommended action>\n' +
    'Keep it under 3 items and keep each line short.\n' +
    'Do not send anything for severity 4 or below.',
  report:
    'Report only new, high-fit opportunities since last cycle. Maximum 3 items.\n' +
    'Format per item:\n' +
    '- Target: YOUTUBE | NEWSLETTER | LINKEDIN\n' +
    '- Topic\n' +
    '- Why the operator has a differentiated angle\n' +
    '- Recommended action in one sentence\n' +
    '- Shelf life: 24h | days | week+\n\n' +
    'If nothing qualifies, say "No focused content opportunities since last scan." Keep it tight and action-oriented.',
} as const
