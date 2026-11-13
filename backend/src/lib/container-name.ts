/**
 * Slug a project name into a container_name that coding-containers accepts.
 * coding-containers enforces ^[a-zA-Z][a-zA-Z0-9\-_]{0,62}$ — start with a
 * letter, alnum/dash/underscore only, max 63 chars. Lowercase for stability.
 *
 * Lifted out of routes/projects.ts so the project Quality tab's
 * ensure-a-workspace step (services/project-quality.ts) derives the SAME name
 * the Provision button does, without a service importing a route module.
 */
export function slugContainerName(projectName: string): string {
  let slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Must start with a letter.
  if (!/^[a-z]/.test(slug)) slug = `p-${slug}`;
  return slug.slice(0, 63) || 'project';
}
