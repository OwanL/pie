export interface OwnerRequireOptions {
  layout?: 'current' | 'planned';
  repositoryRoot?: string;
  dependencyOwnerRoot?: string;
}

/** Create a Node resolver anchored to the selected application dependency owner. */
export function createOwnerRequire(options?: OwnerRequireOptions): NodeJS.Require;
