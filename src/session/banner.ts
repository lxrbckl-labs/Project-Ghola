import * as os from 'os';
import * as path from 'path';
import type { ModuleHandle } from '../modules/handle';

export interface BannerTeamInput {
  perfCores: number;
  perfModel: string;
  effCores: number;
  effModel: string;
  qaCount: number;
  qaModel: string;
}

export interface BannerInput {
  enabledModules: ModuleHandle[];
  /** Kept for callers that still track composed agent ids; not rendered in the box. */
  composedAgentIds: string[];
  version: string;
  /** Resolved terminal work dir; undefined when no repo/workspace is in play. */
  cwd: string | undefined;
  /** Current git branch, or "" when the effective dir is not a git repo. */
  branch: string;
  team: BannerTeamInput;
  cliCommand: string;
  sessionCommand: string;
}

/** Label column width: every row's value starts at the same column. */
const LABEL_WIDTH = 10;

/** Hard cap on the box's inner content width, so a long branch/module list can't blow out the terminal. */
const MAX_INNER_WIDTH = 52;

export function formatBanner(input: BannerInput): string {
  const title = `GHOLA v${input.version}`;
  const warMode = isWarMode(input.enabledModules);

  const workRepoValue = formatWorkRepo(input.cwd);
  const branchValueRaw = input.branch !== '' ? stripBranchToTicket(input.branch) : '(not a git repo)';
  const ticketValue = formatTicket(input.branch);
  const modeValue = formatMode(input.enabledModules);
  const crewLabel = warMode ? 'Gholas' : 'Team';
  const crewValue = warMode ? formatGholas() : formatTeam(input.team);
  const modulesValue = `${input.enabledModules.length} enabled`;
  const triggerValue = `${input.sessionCommand} → ${input.cliCommand}`;

  // All rows are single-line now — the Modules row was the only one that ever
  // wrapped, and it is now just a count, so every row fits the same simple path.
  const singleLineRows: Array<{ label: string; value: string }> = [
    { label: 'Work repo', value: workRepoValue },
    { label: 'Branch', value: branchValueRaw },
    { label: 'Ticket', value: ticketValue },
    { label: 'Mode', value: modeValue },
    { label: crewLabel, value: crewValue },
    { label: 'Modules', value: modulesValue },
    { label: 'Trigger', value: triggerValue },
  ];

  // Natural (untruncated) content width across every row — this is what decides
  // how wide the box "wants" to be before the cap is applied.
  const naturalMax = Math.max(...singleLineRows.map((r) => LABEL_WIDTH + 1 + r.value.length));

  // Cap the box width, but never so tight the title can't fit on the top border.
  const innerWidth = Math.max(Math.min(naturalMax, MAX_INNER_WIDTH), title.length + 2);
  const valueBudget = innerWidth - (LABEL_WIDTH + 1);

  const contentLines: string[] = [];
  for (const row of singleLineRows) {
    const value = truncateToWidth(row.value, valueBudget);
    contentLines.push(row.label.padEnd(LABEL_WIDTH) + ' ' + value);
  }

  const lines: string[] = [];
  lines.push(`╭─ ${title} ${'─'.repeat(Math.max(innerWidth - title.length - 1, 1))}╮`);
  for (const content of contentLines) {
    const clamped = content.length > innerWidth ? content.slice(0, innerWidth) : content;
    lines.push(`│ ${clamped.padEnd(innerWidth)} │`);
  }
  lines.push(`╰${'─'.repeat(innerWidth + 2)}╯`);

  return lines.join('\n');
}

/**
 * Strip a branch name down to its ticket key when one is present, e.g.
 * `feature/CMMS-2791-automated-testing---receiving` -> `feature/CMMS-2791`.
 * The lazy `.*?` keeps the workflow prefix (`feature/`, `bugfix/`, ...) and
 * stops at the first `KEY-NUMBER` match. Branches with no ticket key (e.g.
 * `main`, `release/2024-01`) are returned unchanged. Case is preserved as-is
 * since this is display of the raw branch string, not the derived ticket id.
 */
function stripBranchToTicket(branch: string): string {
  const match = branch.match(/^(.*?[A-Za-z]+-[0-9]+)/);
  return match ? match[1] : branch;
}

/** Truncate a value to fit `maxLen`, adding a trailing "..." when it doesn't. */
function truncateToWidth(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  if (maxLen <= 3) return value.slice(0, Math.max(maxLen, 0));
  return value.slice(0, maxLen - 3) + '...';
}

/** Replace a leading home-directory prefix with `~`. */
function collapseHome(p: string): string {
  const home = os.homedir();
  if (home && (p === home || p.startsWith(home + path.sep))) {
    return '~' + p.slice(home.length);
  }
  return p;
}

function formatWorkRepo(cwd: string | undefined): string {
  if (!cwd) return '(none - launched outside a repo)';
  return collapseHome(cwd);
}

/** Derive a Jira-style ticket key from a branch name, e.g. `feature/CMMS-2791-foo` -> `CMMS-2791`. */
function formatTicket(branch: string): string {
  if (!branch) return '(none detected)';
  const stripped = branch.replace(/^(feature|bugfix|hotfix|release)\//i, '');
  const segments = stripped.split('/');
  const last = segments[segments.length - 1] ?? stripped;
  const match = last.match(/^([A-Za-z]+-[0-9]+)/);
  return match ? `${match[1]}  (from branch)` : '(none detected)';
}

function formatMode(enabled: ModuleHandle[]): string {
  const modes = enabled
    .filter((h) => h.manifest.id.startsWith('mode.'))
    .map((h) => h.manifest.id.slice('mode.'.length));
  return modes.length > 0 ? modes.join(', ') : 'unconstrained';
}

function formatTeam(team: BannerTeamInput): string {
  return (
    `${team.perfCores} perf·${team.perfModel}  ` +
    `${team.effCores} eff·${team.effModel}  ` +
    `${team.qaCount} QA·${team.qaModel}`
  );
}

/** True when `mode.war` (Ghola mode) is among the enabled modules. */
function isWarMode(enabled: ModuleHandle[]): boolean {
  return enabled.some((h) => h.manifest.id === 'mode.war');
}

/**
 * Ghola mode (`mode.war`) replaces the fixed TPM/SWE/QA team with a free-form,
 * subject-locked, persistent roster that TPM grows and retires dynamically per
 * modules/mode.war/ghola.md ("Gholas — free-form, subject-locked, persistent" /
 * "there is no fixed roster shape") — so there is no stable count to report here.
 */
function formatGholas(): string {
  return 'autonomous crew · free-form roster, sized by mission decomposition';
}
