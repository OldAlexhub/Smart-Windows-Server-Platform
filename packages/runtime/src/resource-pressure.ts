/** Only reclaim idle apps' cold pages under sustained pressure. Never shrink a heap or kill an app. */
export class ResourcePressurePolicy {
  private pressured = false;
  private readonly idleSamples = new Map<string, number>();

  sample(totalBytes: number, usedBytes: number, apps: { appId: string; cpuPercent: number }[]): Map<string, boolean> {
    const fraction = totalBytes > 0 ? usedBytes / totalBytes : 0;
    if (fraction >= 0.88) this.pressured = true;
    else if (fraction <= 0.78) this.pressured = false;
    const live = new Set(apps.map((app) => app.appId));
    for (const id of this.idleSamples.keys()) if (!live.has(id)) this.idleSamples.delete(id);
    return new Map(apps.map((app) => {
      const idle = app.cpuPercent < 0.5 ? (this.idleSamples.get(app.appId) ?? 0) + 1 : 0;
      this.idleSamples.set(app.appId, idle);
      return [app.appId, this.pressured && idle >= 3];
    }));
  }
}
