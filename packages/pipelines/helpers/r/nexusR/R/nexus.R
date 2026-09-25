# Nexus pipeline helpers for R scripts.
#
#   data <- nexus_input()                     # the data from the step before (a data frame)
#   start <- nexus_param("start_date")        # a pipeline parameter
#   key <- nexus_secret("warehouse_key")      # a secret stored in Nexus (never written in the script)
#   result <- data[data$status == "Completed", ]
#   nexus_output(result)                      # hand the result to the next step
#
# Data moves between steps as Parquet files; arrow is used when installed, otherwise nanoparquet.

.json_env <- function(name) {
  raw <- Sys.getenv(name, "")
  if (!nzchar(raw)) return(list())
  jsonlite::fromJSON(raw, simplifyVector = FALSE)
}

.has_arrow <- function() requireNamespace("arrow", quietly = TRUE)

#' Names of the steps this script receives data from.
nexus_inputs <- function() names(.json_env("NEXUS_INPUTS"))

#' The incoming data as a data frame. With several inputs, name the step: nexus_input("trips").
nexus_input <- function(name = NULL) {
  available <- .json_env("NEXUS_INPUTS")
  if (length(available) == 0) stop("This step has no input data. Connect a step before it in the pipeline.", call. = FALSE)
  if (is.null(name)) {
    if (length(available) > 1) stop(sprintf("This step has several inputs; say which one you want, e.g. nexus_input(\"%s\").", sort(names(available))[1]), call. = FALSE)
    name <- names(available)[1]
  }
  path <- available[[name]]
  if (is.null(path)) stop(sprintf("There is no input called \"%s\". Inputs: %s", name, paste(sort(names(available)), collapse = ", ")), call. = FALSE)
  if (.has_arrow()) return(as.data.frame(arrow::read_parquet(path)))
  as.data.frame(nanoparquet::read_parquet(path))
}

#' Hands the result (a data frame or tibble) to the next step.
nexus_output <- function(data) {
  path <- Sys.getenv("NEXUS_OUTPUT", "")
  if (!nzchar(path)) stop("nexus_output() only works inside a Nexus pipeline.", call. = FALSE)
  if (!is.data.frame(data)) data <- as.data.frame(data)
  tmp <- paste0(path, ".part")
  if (.has_arrow()) arrow::write_parquet(data, tmp) else nanoparquet::write_parquet(as.data.frame(data), tmp)
  if (!file.rename(tmp, path)) stop("Nexus couldn't save the script's result.", call. = FALSE)
  invisible(data)
}

#' A pipeline parameter (text, number, TRUE/FALSE, or a date as "YYYY-MM-DD").
nexus_param <- function(name, default = NULL) {
  params <- .json_env("NEXUS_PARAMS")
  value <- params[[name]]
  if (is.null(value)) default else value
}

#' All pipeline parameters as a named list.
nexus_params <- function() .json_env("NEXUS_PARAMS")

#' A secret stored in Nexus. Only secrets this script names are made available to it.
nexus_secret <- function(name) {
  value <- .json_env("NEXUS_SECRETS")[[name]]
  if (is.null(value)) stop(sprintf("The secret \"%s\" isn't available. Add it under Pipelines > Secrets, and name it literally in the script: nexus_secret(\"%s\").", name, name), call. = FALSE)
  value
}

#' Connection URL (postgresql://...) for a Nexus database; use it with DBI/RPostgres.
nexus_database <- function(name) {
  value <- .json_env("NEXUS_DATABASES")[[name]]
  if (is.null(value)) stop(sprintf("The database \"%s\" isn't available to this script. Name it literally: nexus_database(\"%s\").", name, name), call. = FALSE)
  value
}

#' "cuda" when an NVIDIA GPU may be used by this pipeline, otherwise "cpu".
nexus_execution_mode <- function() Sys.getenv("NEXUS_EXECUTION_MODE", "cpu")

#' TRUE while the pipeline runs in test mode (sample data, nothing is written for real).
nexus_is_test_run <- function() identical(Sys.getenv("NEXUS_TEST_RUN"), "1")
