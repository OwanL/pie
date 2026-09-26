export interface ToolCallHeaderPathSummaryModel {
  kind: 'path';
  text: string;
  title?: string;
}

export interface ToolCallHeaderTextSummaryModel {
  kind: 'text';
  text: string;
}

export interface ToolCallHeaderCommandSummaryModel {
  kind: 'command';
  command: string;
  title: string;
  prefix?: string;
  detail?: string;
  pathLeadingQuote?: string;
  pathText?: string;
  pathTrailingQuote?: string;
  suffix?: string;
}

export type ToolCallHeaderSummaryModel =
  | ToolCallHeaderPathSummaryModel
  | ToolCallHeaderTextSummaryModel
  | ToolCallHeaderCommandSummaryModel;
