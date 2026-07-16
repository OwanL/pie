const GIT_REPOSITORY_ENV = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
]);

/** Keep hook-local repository state out of child test repositories. */
export function withoutGitRepositoryEnv(source) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (GIT_REPOSITORY_ENV.has(normalized) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(normalized)) {
      delete env[key];
    }
  }
  return env;
}
