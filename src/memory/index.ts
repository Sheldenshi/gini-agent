// Hindsight memory module barrel.
//
// The legacy MemoryRecord JSON store (CRUD on RuntimeState.memories) lives
// in ./legacy and stays the source-of-truth for user-facing memory CRUD
// until phase 6 migrates everything into the SQLite four-network store.
// Phase 2+ adds retain/recall/reflect on top of the SQLite layer; those
// surfaces are exported alongside the legacy CRUD here.

export {
  archiveMemory,
  createMemoryFromInput,
  editMemory,
  updateMemory
} from "./legacy";

export { retain } from "./retain";
export type { RetainInput, RetainOutput } from "./retain";

export { recall } from "./recall";
export type { RecallInput, RecallOutput, RecallScoredUnit, RecallChannel } from "./recall";

export { reflect, verbalizeProfile, buildReflectSystemMessage } from "./reflect";
export type { ReflectInput, ReflectOutput } from "./reflect";

export { reinforceOpinionsForUnits, applyVerdict } from "./reinforce";

export { migrateLegacyMemories, migrateIfNeeded, legacyMigrationStatus } from "./migrate";
export type { MigrationReport } from "./migrate";
