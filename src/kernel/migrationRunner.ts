import type { ProjectManifest } from "./types";

export interface MigrationResult {
  changed: false;
  manifest: ProjectManifest;
}

export class MigrationRunner {
  public async runNoop(manifest: ProjectManifest): Promise<MigrationResult> {
    return { changed: false, manifest };
  }
}
