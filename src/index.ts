import * as core from '@actions/core';
import { execSync, spawnSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import path from 'path';

interface ActionInputs {
  workingDirectory: string;
  showSummary: boolean;
  failOnError: boolean;
  outputFormat: 'env' | 'json';
}

interface SerializedEnvGraphErrors {
  /** Per-item validation errors, keyed by config item key */
  configItems?: Record<string, string>;
  /** Root-level errors not tied to a specific config item */
  root?: Array<string>;
}

interface SerializedEnvGraph {
  basePath?: string;
  sources: Array<{
    label: string;
    enabled: boolean;
    path?: string;
  }>;
  settings: {
    redactLogs?: boolean;
    preventLeaks?: boolean;
  };
  config: Record<string, {
    value: any;
    isSensitive: boolean;
  }>;
  /** Present only when load produced errors (varlock 1.0+) */
  errors?: SerializedEnvGraphErrors;
}

export function getInputs(): ActionInputs {
  const showSummaryInput = core.getInput('show-summary');
  const failOnErrorInput = core.getInput('fail-on-error');
  const outputFormatInput = core.getInput('output-format');

  return {
    workingDirectory: core.getInput('working-directory') || '.',
    showSummary: showSummaryInput === '' ? true : showSummaryInput === 'true',
    failOnError: failOnErrorInput === '' ? true : failOnErrorInput === 'true',
    outputFormat: outputFormatInput === 'json' ? 'json' : 'env',
  };
}

/**
 * On Windows, resolve a bare command name (e.g. "varlock") to a concrete
 * executable path via `where`. Node's spawn with shell:false does not apply
 * PATHEXT, so a globally-installed `varlock.cmd` on PATH is invisible unless
 * resolved to its full path first. Prefers directly-runnable extensions
 * (.cmd/.bat/.exe). Returns undefined if nothing is found (caller falls back
 * to the bare name and surfaces the resulting spawn error).
 */
function resolveWindowsExecutable(command: string): string | undefined {
  const result = spawnSync('where', [command], { encoding: 'utf8', shell: false });
  if (result.status !== 0 || !result.stdout) return undefined;
  const matches = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return matches.find((match) => /\.(cmd|bat|exe)$/i.test(match)) ?? matches[0];
}

/**
 * Run an executable safely without shell interpretation. Args are passed as
 * an array, never concatenated into a command string. On Windows, .cmd/.bat
 * shims are invoked via cmd.exe /c since Node refuses to spawn them directly
 * (CVE-2024-27980) and we want to avoid `shell: true`.
 */
function runFile(
  file: string,
  args: string[],
  options: { cwd?: string } = {},
): { stdout: string; stderr: string; exitCode: number } {
  // A bare command name (no directory, no extension) won't resolve under
  // spawnSync({shell:false}) on Windows — resolve it to a real path first.
  let resolvedFile = file;
  if (process.platform === 'win32' && path.basename(file) === file && !path.extname(file)) {
    resolvedFile = resolveWindowsExecutable(file) ?? file;
  }

  const isWindowsCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedFile);
  const spawnFile = isWindowsCmd ? 'cmd.exe' : resolvedFile;
  const spawnArgs = isWindowsCmd ? ['/d', '/s', '/c', resolvedFile, ...args] : args;

  const result = spawnSync(spawnFile, spawnArgs, {
    cwd: options.cwd,
    encoding: 'utf8',
    // Explicit: no shell. Defends against accidental injection if file/args
    // contain spaces or shell metacharacters.
    shell: false,
  });

  if (result.error) {
    return { stdout: '', stderr: result.error.message, exitCode: 1 };
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

export function findLocalVarlockBinary(workingDirectory: string): string | undefined {
  if (workingDirectory.includes('\0')) return undefined;
  const dir = path.resolve(workingDirectory);
  const workspaceRoot = path.resolve(process.cwd());
  const relativeToWorkspace = path.relative(workspaceRoot, dir);
  if (relativeToWorkspace.startsWith('..') || path.isAbsolute(relativeToWorkspace)) {
    return undefined;
  }
  if (!existsSync(dir)) return undefined;
  try {
    if (!statSync(dir).isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const { root } = path.parse(dir);
  // Package managers create different bin shims on Windows: npm/pnpm produce a
  // `.cmd`, while bun produces a `.exe` launcher (and a bare `varlock` script).
  // Probe all of them so a locally-installed varlock is found regardless of the
  // package manager. Order matters: `.cmd`/`.exe` are directly runnable (see
  // runFile), the extensionless shim is the fallback.
  const binaryNames = process.platform === 'win32'
    ? ['varlock.cmd', 'varlock.exe', 'varlock']
    : ['varlock'];
  let cursor = dir;

  while (true) {
    for (const binaryName of binaryNames) {
      const candidate = path.join(cursor, 'node_modules', '.bin', binaryName);
      if (existsSync(candidate)) return candidate;
    }
    if (cursor === root) break;
    cursor = path.dirname(cursor);
  }

  return undefined;
}

export function checkVarlockInstalled(varlockCommand = 'varlock'): boolean {
  return runFile(varlockCommand, ['--version']).exitCode === 0;
}

const MIN_VARLOCK_VERSION: [number, number, number] = [1, 1, 0];

export function getVarlockVersion(varlockCommand = 'varlock'): string | undefined {
  const result = runFile(varlockCommand, ['--version']);
  if (result.exitCode !== 0) return undefined;
  const match = result.stdout.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

function isVersionAtLeast(version: string, min: [number, number, number]): boolean {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    if ((parts[i] ?? 0) > min[i]) return true;
    if ((parts[i] ?? 0) < min[i]) return false;
  }
  return true;
}

export function checkForEnvFiles(workingDir: string): boolean {
  try {
    const files = readdirSync(workingDir);
    const envFiles = files.filter((file: string) => file === '.env' || file.startsWith('.env.'));

    if (envFiles.length > 0) {
      core.info(`Found environment files: ${envFiles.join(', ')}`);
      return true;
    }

    return false;
  } catch (error) {
    core.warning(`Error reading directory ${workingDir}: ${error}`);
    return false;
  }
}

export function installVarlock(): void {
  core.info('Installing varlock...');
  try {
    execSync('npm install -g varlock', { stdio: 'inherit' });
  } catch {
    try {
      execSync('curl -fsSL https://raw.githubusercontent.com/dmno-dev/varlock/main/install.sh | sh', { stdio: 'inherit' });
    } catch (error) {
      core.setFailed(`Failed to install varlock: ${error}`);
    }
  }
}

export function countErrors(errors?: SerializedEnvGraphErrors): number {
  if (!errors) return 0;
  return (errors.root?.length ?? 0) + Object.keys(errors.configItems ?? {}).length;
}

export function formatValidationErrorMessage(
  errorCount: number,
  errors?: SerializedEnvGraphErrors,
  stderr?: string,
): string {
  const lines: string[] = [`Found ${errorCount} validation error(s):`];

  if (errors?.root) {
    for (const message of errors.root) {
      lines.push(`  - ${message}`);
    }
  }

  if (errors?.configItems) {
    for (const [key, message] of Object.entries(errors.configItems)) {
      lines.push(`  - ${key}: ${message}`);
    }
  }

  if (countErrors(errors) === 0 && stderr?.trim()) {
    lines.push('');
    lines.push(stderr.trim());
  }

  return lines.join('\n');
}

function runVarlockCommand(
  varlockCommand: string,
  args: string[],
  workingDirectory: string,
): { output: string; stderr: string; exitCode: number } {
  const result = runFile(varlockCommand, args, { cwd: workingDirectory });
  return { output: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

export function runVarlockLoad(inputs: ActionInputs): {
  output: string;
  errorCount: number;
  summaryOutput?: string;
  stderr?: string;
  exitCode: number;
  envGraph?: SerializedEnvGraph;
} {
  const varlockCommand = findLocalVarlockBinary(inputs.workingDirectory) ?? 'varlock';

  // Single invocation: JSON to stdout, redacted human summary to stderr.
  // `--summary-stderr` requires varlock >= 1.1.0.
  const args = ['load', '--format', 'json-full'];
  if (inputs.showSummary) args.push('--summary-stderr');

  const jsonResult = runVarlockCommand(varlockCommand, args, inputs.workingDirectory);

  let envGraph: SerializedEnvGraph | undefined;
  if (jsonResult.output.trim().length > 0) {
    try {
      envGraph = JSON.parse(jsonResult.output) as SerializedEnvGraph;
    } catch {
      envGraph = undefined;
    }
  }

  const stderr = jsonResult.stderr.trim() || undefined;

  return {
    output: jsonResult.output,
    errorCount: countErrors(envGraph?.errors),
    summaryOutput: inputs.showSummary ? stderr : undefined,
    stderr,
    exitCode: jsonResult.exitCode,
    envGraph,
  };
}

export function setEnvironmentVariables(envGraph: SerializedEnvGraph): void {
  let regularVars = 0;
  let secretVars = 0;

  for (const [key, itemInfo] of Object.entries(envGraph.config)) {
    if (itemInfo.value !== undefined && itemInfo.value !== null) {
      const value = String(itemInfo.value);

      if (itemInfo.isSensitive) {
        // Export sensitive values as secrets
        core.setSecret(value);
        core.exportVariable(key, value);
        secretVars++;
      } else {
        // Export non-sensitive values as regular environment variables
        core.exportVariable(key, value);
        regularVars++;
      }
    }
  }

  core.info(`✅ Exported ${regularVars} regular environment variables and ${secretVars} secrets`);
}

export function outputJsonBlob(envGraph: SerializedEnvGraph): void {
  // Create a clean JSON object with just the values (no sensitive flags)
  const jsonOutput: Record<string, any> = {};

  for (const [key, itemInfo] of Object.entries(envGraph.config)) {
    if (itemInfo.value !== undefined && itemInfo.value !== null) {
      jsonOutput[key] = itemInfo.value;
    }
  }

  // Output the JSON blob
  core.setOutput('json-env', JSON.stringify(jsonOutput, null, 2));
  core.info('✅ Output JSON blob with environment variables');
}

async function run(): Promise<void> {
  try {
    const inputs = getInputs();
    const localVarlockBinary = findLocalVarlockBinary(inputs.workingDirectory);
    const initialVarlockCommand = localVarlockBinary ?? 'varlock';

    core.info('🔍 Checking for varlock installation...');
    let varlockInstalled = checkVarlockInstalled(initialVarlockCommand);
    let activeVarlockCommand = initialVarlockCommand;

    if (!varlockInstalled) {
      core.info('📦 Varlock not found, installing...');
      installVarlock();
      varlockInstalled = checkVarlockInstalled('varlock');
      activeVarlockCommand = 'varlock';

      if (!varlockInstalled) {
        core.setFailed('Failed to install varlock');
        return;
      }
    }

    const version = getVarlockVersion(activeVarlockCommand);
    if (!version || !isVersionAtLeast(version, MIN_VARLOCK_VERSION)) {
      const found = version ?? 'unknown';
      const required = MIN_VARLOCK_VERSION.join('.');
      core.setFailed(
        `varlock-action requires varlock >=${required} but found ${found}. `
        + `Upgrade varlock, or pin to varlock-action@v1.0.1 to keep using older varlock versions.`,
      );
      return;
    }

    core.info(`✅ Varlock is available (v${version})`);

    core.info('🔍 Checking for environment files...');
    const hasEnvFiles = checkForEnvFiles(inputs.workingDirectory);

    if (!hasEnvFiles) {
      core.warning('No .env files detected');
      core.info('This action requires environment files (e.g., .env, .env.local, .env.production)');
      core.setFailed('No environment files found');
      return;
    }

    core.info('✅ Environment files found');

    core.info('🚀 Loading environment variables with varlock...');
    const {
      errorCount, envGraph, summaryOutput, exitCode, stderr,
    } = runVarlockLoad(inputs);

    const resolvedErrorCount = errorCount > 0 ? errorCount : (exitCode !== 0 ? 1 : 0);

    // Set outputs
    core.setOutput('error-count', resolvedErrorCount.toString());

    if (inputs.showSummary) {
      const summary = summaryOutput?.trim() || '';
      core.setOutput('summary', summary);
      if (summary) {
        core.info('📋 Environment Summary:');
        core.info(summary);
      }
    }

    if (!envGraph) {
      const failureMessage = stderr
        ? `varlock load --format json-full failed (exit code ${exitCode})\n\n${stderr}`
        : `varlock load --format json-full failed (exit code ${exitCode})`;
      core.setFailed(failureMessage);
      return;
    }

    if (inputs.outputFormat === 'env') {
      core.info('🔧 Setting environment variables...');
      setEnvironmentVariables(envGraph);
    } else if (inputs.outputFormat === 'json') {
      core.info('📄 Outputting JSON blob...');
      outputJsonBlob(envGraph);
    }

    if (resolvedErrorCount > 0 || exitCode !== 0) {
      const message = formatValidationErrorMessage(
        resolvedErrorCount || errorCount || 1,
        envGraph.errors,
        stderr,
      );
      if (inputs.failOnError) {
        core.setFailed(message);
        return;
      }
      core.warning(message);
    }

    core.info('✅ Environment variables loaded successfully');
  } catch (error: any) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
