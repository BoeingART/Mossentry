// Summarize `ufw show added` descriptions for display only. Mutations continue to
// use the original rule ID and revision, never these derived fields.
function words(description: string): string[] | null {
  const result: string[] = [];
  let word = '', quote = '', escaped = false, started = false;
  for (const char of description) {
    if (escaped) { word += char; escaped = false; started = true; }
    else if (char === '\\' && quote !== "'") { escaped = true; started = true; }
    else if (quote) { if (char === quote) quote = ''; else word += char; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) {
      if (started) { result.push(word); word = ''; started = false; }
    } else { word += char; started = true; }
  }
  if (quote || escaped) return null;
  if (started) result.push(word);
  return result;
}

function portSpec(value: string) {
  const match = value.match(/^(\d+(?::\d+)?(?:,\d+(?::\d+)?)*)(?:\/(tcp|udp))?$/i);
  if (!match) return null;
  for (const part of match[1].split(',')) {
    const bounds = part.split(':').map(Number);
    if (bounds.some(port => port < 1 || port > 65535) || bounds[0] > bounds.at(-1)!) return null;
  }
  return { ports: match[1], protocol: match[2]?.toLowerCase() };
}

export function summarizeFirewallRule(description: string): { type: string | null; ports: string | null } {
  const tokens = words(description);
  if (!tokens?.length) return { type: null, ports: null };
  const route = tokens[0] === 'route';
  const action = tokens[route ? 1 : 0];
  if (!['allow', 'deny', 'reject', 'limit'].includes(action)) return { type: null, ports: null };
  const type = route ? `route ${action}` : action;
  let args = tokens.slice(route ? 2 : 1);
  const comment = args.indexOf('comment');
  if (comment !== -1) args = args.slice(0, comment);
  while (['in', 'out', 'log', 'log-all'].includes(args[0])) args = args.slice(1);
  const short = portSpec(args[0] ?? '');
  if (short) return { type, ports: `${short.ports}${short.protocol ? `/${short.protocol}` : ''}` };
  const destination = args.indexOf('to');
  const port = destination === -1 ? -1 : args.indexOf('port', destination + 1);
  if (port !== -1) {
    const spec = portSpec(args[port + 1] ?? '');
    if (!spec) return { type, ports: null };
    const protocolIndex = args.indexOf('proto');
    const protocol = protocolIndex === -1 ? '' : args[protocolIndex + 1];
    return { type, ports: `${spec.ports}${spec.protocol ? `/${spec.protocol}` : ['tcp', 'udp'].includes(protocol) ? `/${protocol}` : ''}` };
  }
  // Application profiles and service names need server-side resolution; do not
  // label them as all ports or infer a port from their name or a comment.
  if (args.includes('app') || !args.some(token => ['from', 'to'].includes(token))) return { type, ports: null };
  return { type, ports: 'all' };
}
