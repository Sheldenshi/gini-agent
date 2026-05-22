// Hindsight memory module barrel.
//
// The legacy MemoryRecord JSON store (`./legacy`) was removed when the
// state.memories pinned-memory surface was consolidated into USER.md /
// SOUL.md / Hindsight (see ADR runtime-identity-files.md). Hindsight
// (retain/recall/reflect/reinforce on the SQLite four-network store) is
// the sole memory surface in this barrel now.

export { retain } from "./retain";
export type { RetainInput, RetainOutput } from "./retain";

export { recall } from "./recall";
export type { RecallInput, RecallOutput, RecallScoredUnit, RecallChannel } from "./recall";

export { reflect, verbalizeProfile, buildReflectSystemMessage } from "./reflect";
export type { ReflectInput, ReflectOutput } from "./reflect";

export { reinforceOpinionsForUnits, applyVerdict } from "./reinforce";

export { migrateLegacyMemories, migrateIfNeeded, legacyMigrationStatus } from "./migrate";
export type { MigrationReport } from "./migrate";
