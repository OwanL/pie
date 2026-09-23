// Ambient stub for the `@earendil-works/pi-*` peer package.
//
// Provided by the pi runtime (globally installed); not in this repo's
// node_modules, so tsc cannot resolve it. Declared opaque (every export `any`)
// so this extension's tsconfig typecheck gate covers its INTERNAL types
// (schema, store) — the real goal — without flagging drift against the evolving
// pi API surface. Mirrors session-reviewer's types-global.d.ts.
declare module '@earendil-works/pi-coding-agent' {
  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: any) => any): any;
    registerTool(tool: any): any;
  }
  export interface ExtensionContext {
    cwd: string;
    hasUI: boolean;
    ui: {
      confirm(title: string, message: string, options?: unknown): Promise<boolean>;
      notify(message: string, type?: string): void;
    };
  }
}
