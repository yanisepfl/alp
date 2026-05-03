"use client";

import React, { useState } from "react";
import { WagmiProvider, cookieToInitialState, type Config } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAppKit } from "@reown/appkit/react";
import { networks, projectId, wagmiAdapter, wagmiConfig } from "@/lib/wagmi";

// Singleton AppKit instance. Created lazily on first client-side
// mount so the module body is safe to evaluate during SSR — the
// `typeof window` guard in initializeAppKit is load-bearing because
// createAppKit reaches for `window` internally.
let _appKit: ReturnType<typeof createAppKit> | null = null;

export function getAppKit() {
  return _appKit;
}

function initializeAppKit() {
  if (_appKit || typeof window === "undefined" || !projectId) return _appKit;
  _appKit = createAppKit({
    adapters: [wagmiAdapter],
    networks,
    defaultNetwork: networks[0],
    projectId,
    metadata: {
      name: "alps",
      description: "An onchain basket vault.",
      url: window.location.origin,
      icons: ["/logo.png"],
    },
    themeMode: "dark",
    themeVariables: {
      "--w3m-accent": "#FFFFFF",
      "--w3m-border-radius-master": "8px",
    },
    features: {
      analytics: false,
      email: false,
      socials: false,
    },
  });
  return _appKit;
}

export function Web3Provider({
  children,
  cookies,
}: {
  children: React.ReactNode;
  cookies: string | null;
}) {
  initializeAppKit();
  const [queryClient] = useState(() => new QueryClient());
  const initialState = cookieToInitialState(wagmiConfig as Config, cookies);
  return (
    <WagmiProvider config={wagmiConfig as Config} initialState={initialState}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
