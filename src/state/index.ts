// Barrel re-export. Mirrors the public surface of the previous
// monolithic src/state.ts so importers can keep `from "../state"` /
// `from "./state"` paths unchanged. Add a new name here when promoting
// an internal helper to public; everything that was exported before the
// split must remain re-exported here.

export { now, id } from "./ids";
export { assertInsideWorkspace, assertInsideWorkspaceNoSymlinkEscape, hashSecret } from "./security";
export {
  createEmptyState,
  readState,
  writeState,
  mutateState,
  seedDefaultAgentFromRuntimeConfig,
  isTerminalTaskStatus
} from "./store";
export { appendTrace, readTrace, tracePath, appendLog } from "./trace";
export { addAudit, appendEvent } from "./audit";
export {
  getMemoryDb,
  closeMemoryDb,
  closeAllMemoryDbs,
  removeMemoryDb,
  ensureDefaultBank,
  ensureAgentBank,
  bankIdForAgent,
  deleteBankAndUnits,
  insertMemoryUnit,
  getMemoryUnit,
  countMemoryUnits,
  countByNetwork,
  countUnitsByEmbeddingModel,
  updateMemoryUnitEmbedding,
  insertEntity,
  linkUnitToEntity,
  insertLink,
  linksFrom,
  linksFromMany,
  listBanks,
  listMemoryUnits,
  recentMemoryUnitIds,
  unitsForEntity,
  upsertObservationUnit,
  updateMemoryUnitConfidence,
  updateMemoryUnitStats,
  findEntitiesByMentions,
  entityMentionsForUnit,
  getBank,
  updateBank,
  probeMemoryDb,
  serializeEmbedding,
  deserializeEmbedding,
  memoryDbPath,
  DEFAULT_BANK_ID,
  MEMORY_SCHEMA_VERSION
} from "./memory-db";
export type {
  MemoryBank,
  MemoryUnit as HindsightMemoryUnit,
  MemoryLink as HindsightMemoryLink,
  Entity as HindsightEntity,
  EntityMention,
  Network,
  LinkType,
  CausalSubtype,
  EntityType,
  MemoryUnitStatus,
  NetworkCounts,
  EmbeddingModelCount,
  MemoryDbProbe,
  InsertMemoryUnitInput,
  InsertEntityInput,
  InsertLinkInput,
  ListUnitsOptions,
  UpdateUnitStatsOptions,
  UpdateBankInput
} from "./memory-db";
export {
  taskCounts,
  upsertTask,
  appendTaskPartial,
  createTask,
  createRun,
  createPlanStep,
  createChatSession,
  deleteChatSession,
  renameChatSession,
  createChatMessage,
  createApproval,
  createMemory,
  createSkill,
  createJob,
  createJobRun,
  createImprovementProposal,
  createPairingCode,
  claimPairingCode,
  revokeDevice,
  findActiveDeviceByToken,
  createPromotionProposal,
  decidePromotion,
  createSnapshotRecord,
  createSubagentRecord,
  createMcpServerRecord,
  createMessagingBridgeRecord,
  createMessagingMessageRecord,
  createImportReport,
  createAgentRecord,
  createRelayRecord,
  createNotificationRecord,
  activateAgent,
  updateIdentityHealth
} from "./records";
