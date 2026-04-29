import { cookieStorage, createStorage } from "wagmi";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { base } from "@reown/appkit/networks";
import type { AppKitNetwork } from "@reown/appkit/networks";

export const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID;

if (!projectId) {
  throw new Error(
    "NEXT_PUBLIC_REOWN_PROJECT_ID is not set. Add it to .env.local — get one at https://cloud.reown.com.",
  );
}

export const networks: [AppKitNetwork, ...AppKitNetwork[]] = [base];

export const wagmiAdapter = new WagmiAdapter({
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  networks,
  projectId,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;
