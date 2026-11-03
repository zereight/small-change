/**
 * The service a file belongs to: the first `depth` directories of its path (`services/payments`
 * for `services/payments/src/a.ts` at depth 2). A file closer to the root than `depth` belongs to
 * the directory it sits in, and a file at the repository root to `.`, which counts as a service
 * of its own.
 */
export function serviceOf(path: string, depth: number): string {
  const directories = path.split("/").slice(0, -1);
  return directories.slice(0, depth).join("/") || ".";
}

/** The distinct services of `paths`, sorted. */
export function affectedServices(paths: Iterable<string>, depth: number): string[] {
  const services = new Set<string>();
  for (const path of paths) {
    services.add(serviceOf(path, depth));
  }
  return [...services].sort();
}
