import type { IsolationProvider } from "./types";

export type IsolationPreference = "auto" | string;

export interface IsolationChoice {
  provider: IsolationProvider;
  reason: string;
}

/**
 * Keeps the available isolation technologies and picks one per app.
 * Normal users never see this; Advanced mode can pin a provider per app.
 */
export class IsolationRegistry {
  private readonly providers = new Map<string, IsolationProvider>();

  register(p: IsolationProvider): void {
    this.providers.set(p.id, p);
  }

  get(id: string): IsolationProvider | undefined {
    return this.providers.get(id);
  }

  list(): IsolationProvider[] {
    return [...this.providers.values()];
  }

  async status(): Promise<{ id: string; label: string; available: boolean; reason?: string }[]> {
    return Promise.all(this.list().map(async (p) => ({ id: p.id, label: p.label, ...(await p.available()) })));
  }

  /**
   * - An explicit preference wins when that provider is available.
   * - Apps that can only run on Linux (e.g. Dockerfile-only) use a container provider.
   * - Otherwise the always-available isolated process provider is used: it is faster,
   *   needs no extra components, and works on Windows Home.
   */
  async choose(opts: { preference?: IsolationPreference; requiresLinux?: boolean }): Promise<IsolationChoice> {
    const pref = opts.preference && opts.preference !== "auto" ? this.providers.get(opts.preference) : undefined;
    if (pref) {
      const a = await pref.available();
      if (a.available) return { provider: pref, reason: "Chosen in Advanced settings" };
    }
    if (opts.requiresLinux) {
      for (const p of this.list()) {
        if (p.id === "process") continue;
        if ((await p.available()).available) return { provider: p, reason: "This application needs Linux" };
      }
      throw new Error("This application needs Linux containers, which are not set up on this computer yet.");
    }
    const proc = this.providers.get("process");
    if (!proc) throw new Error("No isolation provider is registered.");
    return { provider: proc, reason: "Runs natively on Windows" };
  }
}
