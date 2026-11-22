import type { ConnectionStatus } from '@ade/contracts';

type Account = ConnectionStatus['github']['account'];

/**
 * The email to suggest for Git commits: the account's public email, or GitHub's private no-reply address
 * (`ID+login@users.noreply.github.com`), which links commits to the account without publishing an address.
 */
export function suggestedGitEmail(account: Account): string {
  if (account?.email) return account.email;
  if (account?.id) return `${account.id}+${account.login}@users.noreply.github.com`;
  return 'you@example.com';
}

/** Double quotes would end the quoted argument in every shell ADE supports; drop them. */
const quoted = (value: string) => `"${value.replace(/"/g, '')}"`;

/** The `git config` commands that fill in what is missing from the Git identity, prefilled from GitHub. */
export function gitIdentityCommands(git: ConnectionStatus['git'], account: Account): string[] {
  const out: string[] = [];
  if (!git.name) out.push(`git config --global user.name ${quoted(account?.name ?? account?.login ?? 'Your Name')}`);
  if (!git.email) out.push(`git config --global user.email ${quoted(suggestedGitEmail(account))}`);
  return out;
}
