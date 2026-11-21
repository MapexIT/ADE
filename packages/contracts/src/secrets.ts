/**
 * Patterns for secrets, shared by the terminal guard rails (SM-14) and the audit export (HI-07). Pure.
 * The last pattern keeps the key name and hides only the value.
 */
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/, 'a private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, 'a GitHub token'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/, 'an API key'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/\b((?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?)([^\s"']{8,})/i, 'a password or key'],
];

/** Kinds of secret found in a text. */
export function findSecrets(text: string): string[] {
  return [...new Set(SECRETS.filter(([re]) => re.test(text)).map(([, what]) => what))];
}

/** The text with every secret replaced by `[redacted]`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re] of SECRETS) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    out = out.replace(global, (match, key?: string) => (typeof key === 'string' && /[:=]/.test(key) ? `${key}[redacted]` : '[redacted]'));
  }
  return out;
}
