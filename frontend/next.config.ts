import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @wagmi/connectors barrel-exports a fleet of wallet connectors
  // (porto, tempo, walletConnect, coinbase, metamask, baseAccount)
  // each with their own peer deps that we don't install — AppKit
  // uses its own WalletConnect connector and we don't ship the
  // others. Mark the unresolvable peers as externals so webpack
  // stops trying to bundle them; if any of those connectors does
  // actually run, the dynamic import throws and is caught upstream.
  webpack: (config, { isServer }) => {
    config.externals = config.externals || [];
    config.externals.push(
      "pino-pretty",
      "lokijs",
      "encoding",
      "porto",
      "porto/internal",
      "accounts",
      "@walletconnect/ethereum-provider",
      "@coinbase/wallet-sdk",
      "@metamask/sdk",
      "@metamask/connect-evm",
      "@base-org/account",
    );
    // Next 15.5's minifier ("WebpackError is not a constructor")
    // crashes on AppKit's lit-element scaffold-ui bundles. The error
    // wrapper inside next/dist/build/webpack/plugins/minify-webpack-
    // plugin is broken — it can't even surface what the underlying
    // failure is. Disable JS minification so the production build
    // passes; the wallet UI ships unminified, which is acceptable
    // for a hackathon submission and trivial to revert once the
    // upstream Next.js fix lands.
    if (!isServer && config.optimization) {
      config.optimization.minimize = false;
    }
    return config;
  },
};

export default nextConfig;
