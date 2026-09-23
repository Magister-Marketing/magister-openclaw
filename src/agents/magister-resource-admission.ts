import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type MagisterResourceAdmission = {
  enabled: boolean;
  memoryRatio: number | null;
  allowPreprocessing: boolean;
  allowChild: boolean;
  allowTool: boolean;
  reason?: string;
};

async function memoryRatio(cgroupRoot: string): Promise<number> {
  const [currentRaw, maximumRaw] = await Promise.all([
    fs.readFile(path.join(cgroupRoot, "memory.current"), "utf8"),
    fs.readFile(path.join(cgroupRoot, "memory.max"), "utf8"),
  ]);
  const current = Number(currentRaw.trim());
  const maximum = maximumRaw.trim() === "max" ? os.totalmem() : Number(maximumRaw.trim());
  if (!Number.isFinite(current) || current < 0 || !Number.isFinite(maximum) || maximum <= 0) {
    throw new Error("invalid cgroup memory telemetry");
  }
  return Math.min(1, current / maximum);
}

export async function resolveMagisterResourceAdmission(params?: {
  env?: NodeJS.ProcessEnv;
  cgroupRoot?: string;
}): Promise<MagisterResourceAdmission> {
  const env = params?.env ?? process.env;
  if (env.MAGISTER_RESOURCE_ADMISSION_ENABLED !== "1") {
    return {
      enabled: false,
      memoryRatio: null,
      allowPreprocessing: true,
      allowChild: true,
      allowTool: true,
    };
  }
  try {
    const ratio = await memoryRatio(params?.cgroupRoot ?? "/sys/fs/cgroup");
    return {
      enabled: true,
      memoryRatio: ratio,
      allowPreprocessing: ratio < 0.7,
      allowChild: ratio < 0.7,
      allowTool: ratio < 0.8,
      ...(ratio >= 0.8
        ? { reason: "machine_memory_critical" }
        : ratio >= 0.7
          ? { reason: "machine_memory_high" }
          : {}),
    };
  } catch {
    return {
      enabled: true,
      memoryRatio: null,
      allowPreprocessing: false,
      allowChild: false,
      allowTool: false,
      reason: "machine_memory_telemetry_unavailable",
    };
  }
}
