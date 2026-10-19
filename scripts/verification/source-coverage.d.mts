export interface SourceCoverageOptions {
  directory: string;
  root?: string;
  cwd?: string;
  includes?: readonly string[];
}

export interface SourceCoverageLocation {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export interface SourceCoverageBranch {
  type: string;
  loc: SourceCoverageLocation;
  locations: SourceCoverageLocation[];
  counts: number[];
}

export interface SourceCoverageFile {
  path: string;
  totalLineCount: number;
  coveredLineCount: number;
  coveredLinePercent: number;
  totalBranchCount: number;
  coveredBranchCount: number;
  coveredBranchPercent: number;
  totalFunctionCount: number;
  coveredFunctionCount: number;
  coveredFunctionPercent: number;
  lines: Array<{ line: number; count: number }>;
  branches: SourceCoverageBranch[];
}

export interface SourceCoverageReport {
  totalLineCount: number;
  coveredLineCount: number;
  coveredLinePercent: number;
  totalBranchCount: number;
  coveredBranchCount: number;
  coveredBranchPercent: number;
  totalFunctionCount: number;
  coveredFunctionCount: number;
  coveredFunctionPercent: number;
  files: SourceCoverageFile[];
  convertedScripts: number;
}

export function collectSourceCoverage(options: SourceCoverageOptions): Promise<SourceCoverageReport>;
