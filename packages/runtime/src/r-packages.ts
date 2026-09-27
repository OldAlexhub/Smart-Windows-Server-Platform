/** CRAN mirror; the cloud mirror serves Windows binaries for current R versions. */
export const DEFAULT_CRAN = "https://cloud.r-project.org";

/** Single-quoted R strings only: Rscript on Windows re-quotes `-e` with double quotes when it starts R. */
const rString = (s: string) => `'${s.replace(/\\/g, "/").replace(/'/g, "\\'")}'`;
const PACKAGE = /^[A-Za-z][A-Za-z0-9.]*$/;

/**
 * R code that installs an application's packages into the library named by R_LIBS_USER.
 *   ["install", "shiny", "dplyr"]          CRAN packages (Windows binaries)
 *   ["restore", "renv.lock", "shiny", ...] the exact versions in renv.lock, then anything still missing
 * Packages that ship with R or are already in the library are skipped, so redeploys are quick.
 * Prints "NEXUS_MISSING: a,b" and exits 3 when something could not be installed.
 */
export function rPackagesScript(args: string[], repo = DEFAULT_CRAN): string {
  const [mode, ...rest] = args;
  const lockfile = mode === "restore" ? rest.shift() : undefined;
  if (mode !== "install" && mode !== "restore") throw new Error(`Unknown r-packages action "${mode}".`);
  const wanted = [...new Set(rest.filter((p) => PACKAGE.test(p)))];
  return [
    `lib <- Sys.getenv('R_LIBS_USER')`,
    `.libPaths(c(lib, .Library))`,
    `options(repos = c(CRAN = ${rString(repo)}), warn = 1, timeout = 600)`,
    `bin <- if (.Platform$OS.type == 'windows') 'binary' else getOption('pkgType')`,
    `have <- function() rownames(installed.packages(lib.loc = c(lib, .Library)))`,
    lockfile
      ? `if (!'renv' %in% have()) install.packages('renv', lib = lib, type = bin); renv::restore(lockfile = ${rString(lockfile)}, library = lib, prompt = FALSE, clean = FALSE)`
      : "",
    `want <- c(${wanted.map(rString).join(", ")})`,
    `need <- setdiff(want, have())`,
    `if (length(need)) install.packages(need, lib = lib, type = bin, dependencies = c('Depends', 'Imports', 'LinkingTo'))`,
    `missing <- setdiff(want, have())`,
    `if (length(missing)) { cat('NEXUS_MISSING:', paste(missing, collapse = ','), '\\n'); quit(status = 3) }`,
    `cat('R packages ready:', length(want), 'requested,', nrow(installed.packages(lib.loc = lib)), 'installed for this app\\n')`,
  ]
    .filter(Boolean)
    .join("; ");
}
