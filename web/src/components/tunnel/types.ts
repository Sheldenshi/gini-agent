// The tunnel UI mirrors the gateway's tunnel contract. Re-export the runtime
// types so the BFF client and the gateway can't drift — a type-only import is
// erased at build time, so it doesn't breach the HTTP-only runtime boundary.
// This matches the convention in web/src/lib/view-types.ts.
export type {
  TunnelProviderId,
  TunnelProvider,
  TunnelStatus,
  TunnelState
} from "@runtime/types";
