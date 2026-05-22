import * as core from '@actions/core';
import { execSync, spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
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
  const isWindowsCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  const spawnFile = isWindowsCmd ? 'cmd.exe' : file;
  const spawnArgs = isWindowsCmd ? ['/d', '/s', '/c', file, ...args] : args;

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
  const dir = path.resolve(workingDirectory);
  const { root } = path.parse(dir);
  const binaryName = process.platform === 'win32' ? 'varlock.cmd' : 'varlock';
  let cursor = dir;

  while (true) {
    const candidate = path.join(cursor, 'node_modules', '.bin', binaryName);
    if (existsSync(candidate)) return candidate;
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

function countErrors(errors?: SerializedEnvGraphErrors): number {
  if (!errors) return 0;
  return (errors.root?.length ?? 0) + Object.keys(errors.configItems ?? {}).length;
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

  return {
    output: jsonResult.output,
    errorCount: countErrors(envGraph?.errors),
    summaryOutput: inputs.showSummary ? jsonResult.stderr : undefined,
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
      errorCount, envGraph, summaryOutput, exitCode,
    } = runVarlockLoad(inputs);

    // Set outputs
    core.setOutput('error-count', errorCount.toString());

    if (inputs.showSummary) {
      const summary = summaryOutput ?? '';
      core.setOutput('summary', summary);
      core.info('📋 Environment Summary:');
      core.info(summary);
    }

    if (!envGraph) {
      core.setFailed(`varlock load --format json-full failed (exit code ${exitCode})`);
      return;
    }

    if (inputs.outputFormat === 'env') {
      core.info('🔧 Setting environment variables...');
      setEnvironmentVariables(envGraph);
    } else if (inputs.outputFormat === 'json') {
      core.info('📄 Outputting JSON blob...');
      outputJsonBlob(envGraph);
    }

    if (errorCount > 0) {
      if (envGraph.errors?.root) {
        for (const msg of envGraph.errors.root) core.error(msg);
      }
      if (envGraph.errors?.configItems) {
        for (const [key, msg] of Object.entries(envGraph.errors.configItems)) {
          core.error(`${key}: ${msg}`);
        }
      }
      const message = `Found ${errorCount} validation error(s)`;
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
