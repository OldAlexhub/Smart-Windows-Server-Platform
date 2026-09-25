"""
Nexus pipeline helpers for Python scripts.

    from nexus import input_data, output_data, param, secret

    df = input_data()                      # the data from the step before (a pandas DataFrame)
    start = param("start_date")            # a pipeline parameter
    token = secret("shop_api")             # a secret stored in Nexus (never written in the script)
    result = df[df["status"] == "Completed"]
    output_data(result)                    # hand the result to the next step

Data moves between steps as Parquet files; this module hides that. It works with pandas
(default), polars and pyarrow.
"""

import json
import os

__all__ = ["input_data", "output_data", "param", "params", "secret", "database", "execution_mode", "inputs", "is_test_run"]

_output_written = False


def _json_env(name, default):
    raw = os.environ.get(name)
    return json.loads(raw) if raw else default


def inputs():
    """Names of the steps this script receives data from."""
    return list(_json_env("NEXUS_INPUTS", {}).keys())


def input_data(name=None, kind="pandas"):
    """
    The incoming data. With several inputs, pass the step name: input_data("trips").
    kind: "pandas" (default), "polars" or "arrow".
    """
    available = _json_env("NEXUS_INPUTS", {})
    if not available:
        raise RuntimeError("This step has no input data. Connect a step before it in the pipeline.")
    if name is None:
        if len(available) > 1:
            raise RuntimeError("This step has several inputs; say which one you want, e.g. input_data(%r)." % sorted(available)[0])
        name = next(iter(available))
    if name not in available:
        raise RuntimeError("There is no input called %r. Inputs: %s" % (name, ", ".join(sorted(available))))
    path = available[name]
    if kind == "polars":
        import polars as pl
        return pl.read_parquet(path)
    import pyarrow.parquet as pq
    table = pq.read_table(path)
    if kind == "arrow":
        return table
    return table.to_pandas()


def output_data(data):
    """Hands the result to the next step: a pandas or polars DataFrame, an Arrow table, or a list of dicts."""
    global _output_written
    path = os.environ.get("NEXUS_OUTPUT")
    if not path:
        raise RuntimeError("output_data() only works inside a Nexus pipeline.")
    tmp = path + ".part"
    module = type(data).__module__.split(".")[0]
    if module == "pandas":
        data.to_parquet(tmp, index=False)
    elif module == "polars":
        data.write_parquet(tmp)
    else:
        import pyarrow as pa
        import pyarrow.parquet as pq
        if isinstance(data, pa.Table):
            table = data
        elif isinstance(data, list):
            table = pa.Table.from_pylist(data)
        elif isinstance(data, dict):
            table = pa.Table.from_pydict(data)
        else:
            raise TypeError("output_data() needs a DataFrame, an Arrow table, a list of dicts or a dict of columns.")
        pq.write_table(table, tmp)
    os.replace(tmp, path)
    _output_written = True


def param(name, default=None):
    """A pipeline parameter, already converted to its type (text, number, true/false, date as 'YYYY-MM-DD')."""
    return _json_env("NEXUS_PARAMS", {}).get(name, default)


def params():
    """All pipeline parameters as a dict."""
    return dict(_json_env("NEXUS_PARAMS", {}))


def secret(name):
    """A secret stored in Nexus. Only secrets this script names are made available to it."""
    values = _json_env("NEXUS_SECRETS", {})
    if name not in values:
        raise KeyError("The secret %r isn't available. Add it under Pipelines > Secrets, and name it literally in the script: secret(%r)." % (name, name))
    return values[name]


def database(name):
    """Connection URL (postgresql://…) for a Nexus database, for use with SQLAlchemy, psycopg, etc."""
    values = _json_env("NEXUS_DATABASES", {})
    if name not in values:
        raise KeyError("The database %r isn't available to this script. Name it literally: database(%r)." % (name, name))
    return values[name]


def execution_mode():
    """'cuda' when an NVIDIA GPU may be used by this pipeline, otherwise 'cpu'."""
    return os.environ.get("NEXUS_EXECUTION_MODE", "cpu")


def is_test_run():
    """True while the pipeline runs in test mode (sample data, nothing is written for real)."""
    return os.environ.get("NEXUS_TEST_RUN") == "1"
