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
  setApiAuthToken,
  useAgentStream,
  useSendUserMessage,
  useUser,
  useUserActivity,
  useUserPosition,
  useVault,
  useVaultSnapshot,
} from "./hooks";

export { useAuthBridge } from "./auth-bridge";
export { deriveAuthBaseUrl, getAuthSession } from "./auth";
export type { AuthSession } from "./auth";
