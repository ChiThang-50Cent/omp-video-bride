export interface ProductionContractPermissions {
  createAssets: boolean;
  generateAudio: boolean;
  renderVideo: boolean;
}

export interface ProductionContractSpec {
  style?: string;
  format?: "landscape" | "portrait" | "square" | string;
  voice?: string;
  audience?: string;
  tone?: string;
  narrationMode?: "verbatim" | "restructured" | string;
  music?: "required" | "none" | string;
  [key: string]: unknown;
}

export interface ProductionContract {
  pipeline: "hyperframes-explainer" | "hyperframes-storybook" | string;
  spec: ProductionContractSpec;
  durationSec: number;
  brief: string;
  permissions: ProductionContractPermissions;
  revisionInstructions?: string;
  changedFrames?: (number | string)[];
  approvalNotes?: string;
  narrationSource?: string;
  [key: string]: unknown;
}

export interface BriefInput {
  pipeline: string;
  spec: ProductionContractSpec;
  durationSec: number;
  brief: string;
  permissions: ProductionContractPermissions;
  revisionInstructions?: string;
  changedFrames?: (number | string)[];
  approvalNotes?: string;
  narrationSource?: string;
  [key: string]: unknown;
}

export interface CreateContractOptions {
  update?: boolean;
}

export declare const SUPPORTED_PIPELINES: readonly string[];
export declare const FORMATS: {
  readonly landscape: "1920x1080";
  readonly portrait: "1080x1920";
  readonly square: "1080x1080";
};
export declare const VOICES: readonly string[];
export declare const NARRATION_MODES: readonly string[];
export declare const MUSIC_OPTIONS: readonly string[];

export declare function validateBriefInput(input: unknown): asserts input is BriefInput;
export declare function normalizeSpec(pipeline: string, spec: ProductionContractSpec): ProductionContractSpec;
export declare function createProductionContract(
  projectDir: string,
  briefInput: BriefInput,
  options?: CreateContractOptions
): ProductionContract;
