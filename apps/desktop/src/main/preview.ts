/** CR-10: only local web apps open in the preview window. Pure. */
export function isLocalPreviewUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(u.hostname);
  } catch {
    return false;
  }
}
