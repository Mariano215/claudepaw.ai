export const msChannelPulsePhaseInstructions = {
  observe:
    'Check ClaudePaw YouTube channel health with concise, decision-useful data only.\n' +
    'Run via Bash:\n' +
    '1. curl -s http://localhost:3000/api/v1/youtube/videos?project_id=default 2>/dev/null | head -300 || echo "YouTube API not available"\n' +
    '2. curl -s http://localhost:3000/api/v1/metrics?project_id=default&type=youtube 2>/dev/null | head -150\n' +
    'Use the API/metrics data as the source of truth. External web search is optional and only for a secondary sanity check.\n' +
    'Capture only the signals needed to decide whether to act: subscriber movement, recent video performance, obvious momentum shifts, and standout winners/underperformers.',
  analyze:
    'Only emit findings when there is a clear recommendation.\n' +
    'Hard cap: at most 3 findings total.\n' +
    'Prefer these categories only: breakout topic, performance drop, packaging issue, cadence gap, or stable/no action.\n' +
    'Do not emit generic metrics narration or minor fluctuations.\n' +
    'Severity guide:\n' +
    '- 5 = urgent opportunity or clear channel problem that deserves action in the next 24h\n' +
    '- 4 = meaningful shift this week with a specific next step\n' +
    '- 3 = notable but not action-worthy yet\n' +
    '- 2 = minor observation\n' +
    '- 1 = stable / no action\n' +
    'In each finding detail include: Target, Why it matters, Recommended action.\n' +
    'Target must be exactly one of: YOUTUBE, NEWSLETTER, LINKEDIN, NONE.\n' +
    'Mark is_new=true only for genuinely new shifts, not repeated stable status.',
  act:
    'Only act on severity 5 findings.\n' +
    'Send one concise iMessage to 267-746-0682 with at most 2 items.\n' +
    'Format:\n' +
    'CHANNEL OPS:\n' +
    '1. [TARGET] <topic> - <recommended action>\n' +
    '2. [TARGET] <topic> - <recommended action>\n' +
    'Do not send anything for severity 4 or below.',
  report:
    'Report only action-worthy changes since last cycle. Maximum 3 items.\n' +
    'Format per item:\n' +
    '- Target: YOUTUBE | NEWSLETTER | LINKEDIN | NONE\n' +
    '- Signal\n' +
    '- Why it matters\n' +
    '- Recommended action\n\n' +
    'If the channel is stable, say "Channel pulse stable -- no action needed."',
} as const
