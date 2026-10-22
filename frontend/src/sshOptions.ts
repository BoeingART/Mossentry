// Keep OpenSSH values verbatim: ProxyCommand and quoted paths are not shell-parsed.
export function sshOption(text: string, keyword: string): string {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([a-z][a-z0-9]*)\s*(?:=\s*|\s+)(.*?)\s*$/i);
    if (match?.[1].toLowerCase() === keyword.toLowerCase()) return match[2];
  }
  return '';
}
export function setSshOption(text: string, keyword: string, value: string): string {
  const lines = text.split(/\r?\n/).filter(line => {
    const match = line.match(/^\s*([a-z][a-z0-9]*)(?:\s|=)/i);
    return match?.[1].toLowerCase() !== keyword.toLowerCase();
  });
  if (value.trim()) lines.push(`${keyword} ${value.trim()}`);
  return lines.filter(line => line.trim()).join('\n');
}
