export function serverNameError(name: string): string | null {
  if (!name.trim() || Array.from(name).length > 80 || /[\p{Cc}\u2028\u2029]/u.test(name)) {
    return 'Use a server name of 1–80 characters without line breaks or control characters.';
  }
  if (['all', 'ungrouped', 'managed'].includes(name.toLowerCase())) {
    return 'This server name is reserved';
  }
  return null;
}
