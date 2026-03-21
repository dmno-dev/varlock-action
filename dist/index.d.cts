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
declare function getInputs(): ActionInputs;
declare function findLocalVarlockBinary(workingDirectory: string): string | undefined;
declare function checkVarlockInstalled(varlockCommand?: string): boolean;
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

export { checkForEnvFiles, checkVarlockInstalled, findLocalVarlockBinary, getInputs, installVarlock, outputJsonBlob, runVarlockLoad, setEnvironmentVariables };
