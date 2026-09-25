import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, get } from "./api";
import type { JobState } from "@nexus/shared/contracts";

export interface Loadable<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/** GET a resource, optionally re-polling while the page is visible. */
export function useApi<T>(path: string | null, pollMs?: number): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(async () => {
    if (!pathRef.current) return;
    try {
      const d = await get<T>(pathRef.current);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(String(e), 0, "network", null));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(!!path);
    setData(null);
    void reload();
    if (!pollMs || !path) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, pollMs);
    return () => clearInterval(t);
  }, [path, pollMs, reload]);

  return { data, error, loading, reload };
}

export interface JobQuestion {
  id: string;
  prompt: string;
  choices: { value: string; label: string; description?: string }[];
}
export type JobView = JobState & { question: JobQuestion | null; log: string[] };

/** Follows a long-running job (deploy, backup, restore) until it finishes. */
export function useJob(jobId: string | null): JobView | null {
  const { data } = useApi<JobView>(jobId ? `/jobs/${jobId}` : null, 700);
  return data;
}
