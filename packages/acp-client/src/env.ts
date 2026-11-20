/**
 * Minimal environment for agent processes (CN-06). Only allow-listed variables are passed through;
 * everything else in the user's environment stays behind.
 */
const BASE_ALLOW = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'TERM',
  'COLORTERM',
  'LANG',
  'LANGUAGE',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
];

const BASE_PREFIXES = ['LC_'];

export interface EnvPolicy {
  /** Extra exact names the agent documents (for example `ANTHROPIC_API_KEY`). */
  names?: readonly string[];
  /** Extra prefixes the agent documents (for example `CLAUDE_CODE_`). */
  prefixes?: readonly string[];
}

export function buildAgentEnv(source: NodeJS.ProcessEnv, policy: EnvPolicy = {}): Record<string, string> {
  const names = new Set([...BASE_ALLOW, ...(policy.names ?? [])].map((n) => n.toUpperCase()));
  const prefixes = [...BASE_PREFIXES, ...(policy.prefixes ?? [])].map((p) => p.toUpperCase());
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (names.has(upper) || prefixes.some((p) => upper.startsWith(p))) out[key] = value;
  }
  return out;
}

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)/i;

/** Redacts values of secret-looking keys in a JSON string (WA-05: credentials in env or headers are redacted). */
export function redactSecrets(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), (key, value: unknown) => {
      if (typeof value === 'string' && SECRET_KEY.test(key)) return '[redacted]';
      // ACP env and headers are arrays of { name, value }.
      if (value && typeof value === 'object' && 'name' in value && 'value' in value) {
        const v = value as { name: unknown; value: unknown };
        if (typeof v.name === 'string' && SECRET_KEY.test(v.name)) return { ...v, value: '[redacted]' };
      }
      return value;
    });
  } catch {
    return json;
  }
}
