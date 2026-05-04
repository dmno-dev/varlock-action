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
declare function getInputs(): ActionInputs;
declare function findLocalVarlockBinary(workingDirectory: string): string | undefined;
declare function checkVarlockInstalled(varlockCommand?: string): boolean;
declare function getVarlockVersion(varlockCommand?: string): string | undefined;
declare function checkForEnvFiles(workingDir: string): boolean;
declare function installVarlock(): void;
declare function runVarlockLoad(inputs: ActionInputs): {
    output: string;
    errorCount: number;
    summaryOutput?: string;
    exitCode: number;
    envGraph?: SerializedEnvGraph;
};
declare function setEnvironmentVariables(envGraph: SerializedEnvGraph): void;
declare function outputJsonBlob(envGraph: SerializedEnvGraph): void;

export { checkForEnvFiles, checkVarlockInstalled, findLocalVarlockBinary, getInputs, getVarlockVersion, installVarlock, outputJsonBlob, runVarlockLoad, setEnvironmentVariables };
