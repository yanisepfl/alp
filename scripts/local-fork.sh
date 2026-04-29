#!/usr/bin/env bash
# One-shot bootstrap of an Anvil fork of Base mainnet with the full ALP stack
# deployed and one in-range V3 USDC/cbBTC position seeded.
#
# Usage:
#   BASE_RPC_URL=https://mainnet.base.org scripts/local-fork.sh
#
# After this exits successfully, anvil keeps running in the background. Copy
# the printed `# AGENT_ENV` block into agent/.env, then:
#
#   cd agent
#   pnpm local -- --dry            # see what the agent observes
#   pnpm local -- --force          # rebalance the seeded position
#
# To stop anvil:  pkill -f "anvil --fork-url"

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$REPO_ROOT/contracts"
ANVIL_LOG="$REPO_ROOT/.anvil.log"
RPC=http://localhost:8545

USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
SEED_USDC=10000000000  # 10k USDC (6 decimals)
SEED_ETH_HEX=0x56bc75e2d63100000  # 100 ETH for the deployer (covers gas + V4 native-ETH seed)

: "${BASE_RPC_URL:?BASE_RPC_URL must be set (e.g. https://mainnet.base.org)}"

# Reuse a running anvil if one is already up; otherwise start a fresh fork.
if ! lsof -i :8545 >/dev/null 2>&1; then
  echo "[bootstrap] starting anvil fork of Base mainnet..."
  anvil --fork-url "$BASE_RPC_URL" --chain-id 8453 --block-time 2 --silent \
    >"$ANVIL_LOG" 2>&1 &
  for _ in {1..30}; do
    if cast block-number --rpc-url $RPC >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  if ! cast block-number --rpc-url $RPC >/dev/null 2>&1; then
    echo "[bootstrap] anvil failed to start; check $ANVIL_LOG"
    exit 1
  fi
else
  echo "[bootstrap] reusing existing anvil on :8545"
fi

# -------- Pre-fund DEPLOYER with USDC via anvil storage manipulation --------
# USDC on Base is Circle's FiatTokenV2_2 proxy. The `balanceAndBlacklistStates`
# mapping (which carries the balance) lives at slot 9. We brute-force a few
# candidate slots until balanceOf returns the expected value.
echo "[bootstrap] funding $DEPLOYER with $SEED_USDC USDC (raw units)..."
fund_token() {
  local addr=$1
  local amount=$2
  local hex_amount
  hex_amount=$(cast --to-uint256 "$amount")
  for slot in 9 0 1 2 3 4 5 6 7 8 10 11; do
    local key
    key=$(cast index address "$addr" "$slot")
    cast rpc anvil_setStorageAt "$USDC" "$key" "$hex_amount" --rpc-url $RPC >/dev/null
    local bal
    bal=$(cast call "$USDC" "balanceOf(address)(uint256)" "$addr" --rpc-url $RPC | awk '{print $1}')
    if [ "$bal" = "$amount" ]; then
      echo "[bootstrap] balance slot found at $slot, balance=$bal"
      return 0
    fi
    # reset before trying the next slot
    cast rpc anvil_setStorageAt "$USDC" "$key" "0x0000000000000000000000000000000000000000000000000000000000000000" --rpc-url $RPC >/dev/null
  done
  echo "[bootstrap] failed to find balance slot for $USDC"
  return 1
}
fund_token "$DEPLOYER" "$SEED_USDC"

# Top up DEPLOYER ETH so V4 native-ETH seed has plenty of headroom
cast rpc anvil_setBalance "$DEPLOYER" "$SEED_ETH_HEX" --rpc-url $RPC >/dev/null
echo "[bootstrap] funded DEPLOYER with 100 ETH (for gas + native-ETH seed)"

echo "[bootstrap] running LocalBootstrap.s.sol against the fork..."
cd "$CONTRACTS"
FORGE_LOG=$(mktemp)
forge script script/LocalBootstrap.s.sol:LocalBootstrap \
  --rpc-url $RPC \
  --broadcast \
  --slow \
  -vvv 2>&1 | tee "$FORGE_LOG" | tail -60

# -------- Extract addresses + pool keys from the script's stdout --------
# console2.log emits `KEY= VALUE` with a leading space after `=`. We trim it.
extract() {
  local key=$1
  awk -v k="$key=" '
    {
      i = index($0, k)
      if (i > 0) {
        v = substr($0, i + length(k))
        sub(/^[[:space:]]+/, "", v)
        sub(/[[:space:]]+$/, "", v)
        print v
        exit
      }
    }
  ' "$FORGE_LOG"
}

VAULT=$(extract VAULT_ADDRESS)
REGISTRY=$(extract REGISTRY_ADDRESS)
V3_ADAPTER=$(extract V3_ADAPTER_ADDRESS)
V4_ADAPTER=$(extract V4_ADAPTER_ADDRESS)
UR_ADAPTER=$(extract UR_ADAPTER_ADDRESS)
V4_ETH_USDC=$(extract V4_ETH_USDC_KEY)
V3_USDC_CBBTC=$(extract V3_USDC_CBBTC_KEY)
V3_USDC_USDT=$(extract V3_USDC_USDT_KEY)
UR_USDC_WETH=$(extract UR_USDC_WETH_KEY)
UR_ETH_USDC=$(extract UR_ETH_USDC_KEY)
UR_USDC_CBBTC=$(extract UR_USDC_CBBTC_KEY)
UR_USDC_USDT=$(extract UR_USDC_USDT_KEY)

# -------- Write agent/pools.local.json from the extracted keys --------
# Three LP entries (V3 USDC/cbBTC, V3 USDC/USDT, V4 ETH/USDC), each paired
# with the matching UR entry for the swap path. Token / decimals / hooks /
# tickSpacing are static for the demo so we hardcode them here rather than
# round-tripping through the registry.
POOLS_JSON="$REPO_ROOT/agent/pools.local.json"
python3 - "$POOLS_JSON" <<EOF
import json, sys
p = sys.argv[1]
def toBytes32(decimal_str: str) -> str:
    return "0x" + format(int(decimal_str), "064x")
pools = [
    {
        "label": "USDC/cbBTC 0.05% (V3)",
        "kind": "v3",
        "lpKey":  toBytes32("$V3_USDC_CBBTC"),
        "urKey":  toBytes32("$UR_USDC_CBBTC"),
        "token0": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "token1": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
        "decimals0": 6,
        "decimals1": 8,
        "fee": 500,
        "tickSpacing": 10,
        "hooks": "0x0000000000000000000000000000000000000000",
        "profile": "mid"
    },
    {
        "label": "USDC/USDT 0.01% (V3)",
        "kind": "v3",
        "lpKey":  toBytes32("$V3_USDC_USDT"),
        "urKey":  toBytes32("$UR_USDC_USDT"),
        "token0": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "token1": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
        "decimals0": 6,
        "decimals1": 6,
        "fee": 100,
        "tickSpacing": 1,
        "hooks": "0x0000000000000000000000000000000000000000",
        "profile": "stable"
    },
    {
        "label": "ETH/USDC dynamic-fee (V4 hooked)",
        "kind": "v4",
        "lpKey":  toBytes32("$V4_ETH_USDC"),
        "urKey":  toBytes32("$UR_ETH_USDC"),
        "token0": "0x0000000000000000000000000000000000000000",
        "token1": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "decimals0": 18,
        "decimals1": 6,
        "fee": 8388608,
        "tickSpacing": 60,
        "hooks": "0x7cBbfF9C4fcd74B221C535F4fB4B1Db04F1B9044",
        "profile": "mid"
    }
]
with open(p, "w") as f:
    json.dump(pools, f, indent=2)
    f.write("\n")
print(f"[bootstrap] wrote {len(pools)} pools to {p}")
EOF

rm -f "$FORGE_LOG"

echo ""
echo "[bootstrap] done. anvil is still running on :8545."
echo "[bootstrap] agent/pools.local.json refreshed with current pool keys."
echo "[bootstrap] AGENT_ENV block (paste into agent/.env, then 'cd agent && pnpm local -- --force'):"
echo ""
cat <<EOF
BASE_RPC_URL=http://localhost:8545
VAULT_ADDRESS=$VAULT
REGISTRY_ADDRESS=$REGISTRY
V3_ADAPTER_ADDRESS=$V3_ADAPTER
V4_ADAPTER_ADDRESS=$V4_ADAPTER
UR_ADAPTER_ADDRESS=$UR_ADAPTER
AGENT_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
POOLS_JSON_PATH=$POOLS_JSON
EOF
echo ""
