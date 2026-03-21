import * as core from '@actions/core';
import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import path from 'path';

interface ActionInputs {
  workingDirectory: string;
  showSummary: boolean;
  failOnError: boolean;
  outputFormat: 'env' | 'json';
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

function quoteCliPath(cliPath: string): string {
  return cliPath.includes(' ') ? `"${cliPath}"` : cliPath;
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
  try {
    execSync(`${quoteCliPath(varlockCommand)} --version`, { stdio: 'pipe', encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
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

function parseErrorCountFromOutput(output: string): number {
  const explicitCountMatch = output.match(/Found\s+(\d+)\s+validation error\(s\)/i);
  if (explicitCountMatch) return Number.parseInt(explicitCountMatch[1], 10);
  return (output.match(/error/gi) || []).length;
}

function runVarlockCommand(
  varlockCommand: string,
  args: string[],
  workingDirectory: string,
): { output: string; exitCode: number } {
  const command = `${quoteCliPath(varlockCommand)} ${args.join(' ')}`;

  try {
    const output = execSync(command, {
      cwd: workingDirectory,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return { output: output.toString(), exitCode: 0 };
  } catch (error: any) {
    const output = error?.stdout ? error.stdout.toString() : error?.message || '';
    return { output, exitCode: error?.status ?? 1 };
  }
}

export function runVarlockLoad(inputs: ActionInputs): {
  output: string;
  errorCount: number;
  summaryOutput?: string;
  exitCode: number;
  envGraph?: SerializedEnvGraph;
} {
  const varlockCommand = findLocalVarlockBinary(inputs.workingDirectory) ?? 'varlock';
  const jsonResult = runVarlockCommand(varlockCommand, ['load', '--format', 'json-full'], inputs.workingDirectory);

  let envGraph: SerializedEnvGraph | undefined;
  if (jsonResult.output.trim().length > 0) {
    try {
      envGraph = JSON.parse(jsonResult.output) as SerializedEnvGraph;
    } catch {
      envGraph = undefined;
    }
  }

  let summaryOutput: string | undefined;
  if (inputs.showSummary) {
    core.info('Running: varlock load');
    summaryOutput = runVarlockCommand(varlockCommand, ['load'], inputs.workingDirectory).output;
  }

  const errorCount = parseErrorCountFromOutput(summaryOutput ?? jsonResult.output);

  return {
    output: jsonResult.output,
    errorCount,
    summaryOutput,
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

    if (!varlockInstalled) {
      core.info('📦 Varlock not found, installing...');
      installVarlock();
      varlockInstalled = checkVarlockInstalled('varlock');

      if (!varlockInstalled) {
        core.setFailed('Failed to install varlock');
        return;
      }
    }

    core.info('✅ Varlock is available');

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
      output, errorCount, envGraph, summaryOutput, exitCode,
    } = runVarlockLoad(inputs);

    // Set outputs
    core.setOutput('error-count', errorCount.toString());

    if (inputs.showSummary) {
      const summary = summaryOutput ?? '';
      core.setOutput('summary', summary);
      core.info('📋 Environment Summary:');
      core.info(summary);
    }

    if (envGraph) {
      if (inputs.outputFormat === 'env') {
        // Export as environment variables and secrets
        core.info('🔧 Setting environment variables...');
        setEnvironmentVariables(envGraph);
      } else if (inputs.outputFormat === 'json') {
        // Output as JSON blob
        core.info('📄 Outputting JSON blob...');
        outputJsonBlob(envGraph);
      }
    } else {
      core.setFailed('ENV output requires valid varlock json-full output');
      return;
    }

    if (errorCount > 0 || exitCode !== 0) {
      const message = `Found ${errorCount} validation error(s)`;
      if (inputs.failOnError) {
        core.setFailed(message);
        return;
      } else {
        core.warning(message);
      }
    }

    core.info('✅ Environment variables loaded successfully');
  } catch (error: any) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
