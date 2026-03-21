import { sha256 } from "@noble/hashes/sha2.js";

export interface SensorBatch {
  readings: number[];   // 10 values around the phase baseline
  median: number;       // exact baseline value for this phase
  timestamp: number;    // Date.now()
  phase: number;
}

// Thresholds per phase (uSv/h)
export const PHASE_THRESHOLDS = [100.0, 10.0, 1.0, 0.5, 0.1, 0.1, 0.01];

export class SensorSimulator {
  private phase: number = 0;
  private baseReadings = [82.0, 7.5, 0.75, 0.3, 0.08, 0.08, 0.005];

  constructor(private facilityId: string) {}

  getCurrentBatch(): SensorBatch {
    const base = this.baseReadings[this.phase];
    // Vary readings by ±2% deterministically
    const readings: number[] = [];
    for (let i = 0; i < 10; i++) {
      const jitter = base * 0.02 * (((i * 7 + 3) % 11) / 10 - 0.5);
      readings.push(Number((base + jitter).toFixed(4)));
    }
    return {
      readings,
      median: base,
      timestamp: Date.now(),
      phase: this.phase,
    };
  }

  serializeBatch(b: SensorBatch): Buffer {
    // Deterministic JSON: sorted keys
    const obj = {
      median: b.median,
      phase: b.phase,
      readings: b.readings,
      timestamp: b.timestamp,
    };
    return Buffer.from(JSON.stringify(obj));
  }

  hashBatch(b: SensorBatch): Uint8Array {
    return sha256(this.serializeBatch(b));
  }

  advancePhase(): void {
    if (this.phase < 6) this.phase++;
  }

  getPhase(): number {
    return this.phase;
  }
}

// Self-test
if (process.argv[1]?.endsWith("sensor-simulator.ts") || process.argv[1]?.endsWith("sensor-simulator")) {
  const sim = new SensorSimulator("PLANT-FR-001");
  const thresholds = PHASE_THRESHOLDS;

  console.log("=== Sensor Simulator Self-Test ===\n");
  for (let p = 0; p < 7; p++) {
    const batch = sim.getCurrentBatch();
    const threshold = thresholds[p];
    const pass = batch.median < threshold;
    console.log(
      `Phase ${p}: ${batch.median} uSv/h < threshold ${threshold} -> ${pass ? "PASS" : "FAIL"}`
    );
    if (!pass) {
      console.error(`ERROR: Phase ${p} reading ${batch.median} exceeds threshold ${threshold}`);
      process.exit(1);
    }
    const hash = sim.hashBatch(batch);
    console.log(`  Hash: ${Buffer.from(hash).toString("hex").slice(0, 16)}...`);
    sim.advancePhase();
  }
  console.log("\nAll 7 phase readings are below threshold. OK");
}
