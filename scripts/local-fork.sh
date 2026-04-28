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

echo "[bootstrap] running LocalBootstrap.s.sol against the fork..."
cd "$CONTRACTS"
forge script script/LocalBootstrap.s.sol:LocalBootstrap \
  --rpc-url $RPC \
  --broadcast \
  --slow \
  -vvv 2>&1 | tail -60

echo ""
echo "[bootstrap] done. anvil is still running on :8545."
echo "[bootstrap] copy the AGENT_ENV block above into agent/.env and run:"
echo ""
echo "    cd agent && pnpm local -- --dry"
echo ""
