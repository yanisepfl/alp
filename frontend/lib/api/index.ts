// Public surface of the ALP data layer.
//
// Only types and hooks are exported. The transport (`client.ts` /
// `stub.ts`) is internal — consumers pick a hook, not a transport.

export type {
  ActionCategory,
  AgentHandlers,
  ApiClient,
  ApiError,
  ClientFrame,
  ErrorCode,
  SendResult,
  StreamFrame,
  Topic,
  TokenSymbol,
  Unsubscribe,
  UserActivityRow,
  UserHandlers,
  UserPosition,
  UserSnapshot,
  VaultAllocation,
  VaultHandlers,
  VaultPool,
  VaultPoolPosition,
  VaultSnapshot,
  VaultTick,
  WireChip,
  WireMessage,
  WireSource,
} from "./types";

export {
  setApiWallet,
  useAgentStream,
  useApiWallet,
  useSendUserMessage,
  useUser,
  useUserActivity,
  useUserPosition,
  useVault,
  useVaultSnapshot,
} from "./hooks";
