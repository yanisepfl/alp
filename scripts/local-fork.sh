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
forge script script/LocalBootstrap.s.sol:LocalBootstrap \
  --rpc-url $RPC \
  --broadcast \
  --slow \
  -vvv 2>&1 | tail -60

# -------- Read deployed addresses from forge's broadcast JSON --------
# Robust against forge stdout formatting changes — we go to the canonical
# broadcast file which forge writes deterministically. Pool keys are then
# computed from canonical (adapter, token0, token1, fee, tickSpacing, hooks)
# tuples, mirroring `PoolRegistry.poolKey()`.
BROADCAST="$CONTRACTS/broadcast/LocalBootstrap.s.sol/8453/run-latest.json"
addr_of() {
  jq -r --arg n "$1" '.transactions[] | select(.transactionType=="CREATE" and .contractName==$n) | .contractAddress' "$BROADCAST" | head -1
}
VAULT=$(cast --to-checksum-address $(addr_of "ALPVault"))
REGISTRY=$(cast --to-checksum-address $(addr_of "PoolRegistry"))
V3_ADAPTER=$(cast --to-checksum-address $(addr_of "UniV3Adapter"))
V4_ADAPTER=$(cast --to-checksum-address $(addr_of "UniV4Adapter"))
UR_ADAPTER=$(cast --to-checksum-address $(addr_of "UniversalRouterAdapter"))

# Token + V4 hook constants (mirror LocalBootstrap.s.sol).
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
CBBTC=0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf
USDT=0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2
ETH=0x0000000000000000000000000000000000000000
ZERO_HOOK=0x0000000000000000000000000000000000000000
V4_HOOK=0x7cBbfF9C4fcd74B221C535F4fB4B1Db04F1B9044

pool_key() {
  # poolKey(adapter, token0, token1, fee, tickSpacing, hooks) per PoolRegistry.
  cast keccak "$(cast abi-encode 'f(address,address,address,uint24,int24,address)' "$1" "$2" "$3" "$4" "$5" "$6")"
}

LP_CBBTC=$(pool_key $V3_ADAPTER $USDC $CBBTC 500 10 $ZERO_HOOK)
LP_USDT=$(pool_key  $V3_ADAPTER $USDC $USDT 100 1 $ZERO_HOOK)
LP_V4=$(pool_key    $V4_ADAPTER $ETH  $USDC 8388608 60 $V4_HOOK)
UR_CBBTC=$(pool_key $UR_ADAPTER $USDC $CBBTC 500 10 $ZERO_HOOK)
UR_USDT=$(pool_key  $UR_ADAPTER $USDC $USDT 100 1 $ZERO_HOOK)
UR_V4ETH=$(pool_key $UR_ADAPTER $ETH  $USDC 500 10 $ZERO_HOOK)

# -------- Write agent/pools.local.json --------
POOLS_JSON="$REPO_ROOT/agent/pools.local.json"
cat > "$POOLS_JSON" <<JSONEOF
[
  {
    "label": "USDC/cbBTC 0.05% (V3)",
    "kind": "v3",
    "lpKey": "$LP_CBBTC",
    "urKey": "$UR_CBBTC",
    "token0": "$USDC",
    "token1": "$CBBTC",
    "decimals0": 6,
    "decimals1": 8,
    "fee": 500,
    "tickSpacing": 10,
    "hooks": "$ZERO_HOOK",
    "profile": "mid"
  },
  {
    "label": "USDC/USDT 0.01% (V3)",
    "kind": "v3",
    "lpKey": "$LP_USDT",
    "urKey": "$UR_USDT",
    "token0": "$USDC",
    "token1": "$USDT",
    "decimals0": 6,
    "decimals1": 6,
    "fee": 100,
    "tickSpacing": 1,
    "hooks": "$ZERO_HOOK",
    "profile": "stable"
  },
  {
    "label": "ETH/USDC dynamic-fee (V4 hooked)",
    "kind": "v4",
    "lpKey": "$LP_V4",
    "urKey": "$UR_V4ETH",
    "token0": "$ETH",
    "token1": "$USDC",
    "decimals0": 18,
    "decimals1": 6,
    "fee": 8388608,
    "tickSpacing": 60,
    "hooks": "$V4_HOOK",
    "profile": "mid"
  }
]
JSONEOF
echo "[bootstrap] wrote 3 pools to $POOLS_JSON"

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
