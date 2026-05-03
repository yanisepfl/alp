import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @wagmi/connectors barrel-exports a fleet of wallet connectors
  // (porto, tempo, walletConnect, coinbase, metamask, baseAccount)
  // each with their own peer deps that we don't install — AppKit
  // uses its own WalletConnect connector and we don't ship the
  // others. Alias them to `false` so webpack replaces the imports
  // with an empty module; the connectors never run anyway, and this
  // avoids the chunk-parse error that webpack's default `var` extern
  // emits for scoped/hyphenated names (`if(typeof @base-org/account
  // === ...)` is invalid JS).
  webpack: (config, { isServer }) => {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias as Record<string, string | false>),
      "pino-pretty": false,
      "lokijs": false,
      "encoding": false,
      "porto": false,
      "porto/internal": false,
      "accounts": false,
      "@walletconnect/ethereum-provider": false,
      "@coinbase/wallet-sdk": false,
      "@metamask/sdk": false,
      "@metamask/connect-evm": false,
      "@base-org/account": false,
    };
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
