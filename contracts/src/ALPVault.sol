// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC4626, ERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ILiquidityAdapter} from "./interfaces/ILiquidityAdapter.sol";
import {PoolRegistry} from "./PoolRegistry.sol";

/// @notice Single-deposit vault that holds a basket of Uniswap V3 + V4
/// liquidity positions, rebalanced by an off-chain agent. Inspired by
/// JLP/GLP — depositors receive one share that represents pro-rata exposure
/// to every position the vault holds.
///
/// Roles:
///   - owner    (Ownable2Step):     rotates other roles
///   - guardian:                    pauses, manages registry whitelist,
///                                  bootstraps adapter NFT-operator approvals
///   - agent:                       executes add/remove liquidity + swaps
///                                  against registry-known pools only
///
/// Token + NFT custody:
///   - The vault holds the base asset (idle USDC), all LP NFTs, and any
///     non-base tokens that arise mid-rebalance.
///   - For each call it grants the adapter a transient ERC20 approval for
///     the amounts being routed, then calls the adapter. The adapter pulls,
///     calls Uniswap with `recipient = vault`, and refunds any leftover.
///   - LP NFT operations require the adapter to be an approved operator on
///     the underlying NFT manager. The guardian enables this once via
///     `bootstrapAdapter`.
///
/// Valuation:
///   - `totalAssets()` is fully on-chain. It sums idle base balance, idle
///     non-base balances priced through their pool's spot, and every open
///     position's principal (also priced through spot). No off-chain
///     reporter, no oracle.
///   - Single-block flash-loan manipulation is acknowledged: any depositor
///     who can move spot price for the duration of a transaction can mint
///     mispriced shares. Production deployments should layer in a
///     deposit/redeem cooldown, an entry/exit fee, or an internal TWAP
///     before relying on this for material funds.
contract ALPVault is ERC4626, Ownable2Step, Pausable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    /// @notice Hard cap on positions tracked under a single pool. Bounds the
    /// gas cost of `totalAssets()` and `closeAllPositionsInPool` so that no
    /// agent or guardian can build up an O(N) liability that bricks the
    /// hot path or the wind-down path.
    uint256 public constant MAX_POSITIONS_PER_POOL = 4;

    /// @notice Max acceptable slippage on the auto-unwind non-base→base
    /// swap, in basis points. The unwind path is triggered by a user's
    /// withdraw shortfall; if the swap moves more than this against the
    /// vault, the swap silently fails-soft and the user's withdraw
    /// reverts with `InsufficientLiquidityAfterUnwind` rather than the
    /// vault eating an arbitrary loss.
    uint256 public constant UNWIND_SLIPPAGE_BPS = 200; // 2%

    PoolRegistry public immutable registry;

    /// @notice Per-tx swap cap, expressed in basis points of `totalAssets()`.
    /// Set to `10_000` to disable (default), tighter values shrink the agent's
    /// per-tx blast radius. Owner-tunable.
    uint256 public swapNotionalCapBps = 10_000;
    /// @notice Fee applied to deposits and withdraws, in basis points of the
    /// asset/share moved. Stays in the vault as donated value to remaining
    /// holders. Defends against single-tx flash-loan round-trips by making
    /// any value extracted by spot manipulation cost at least 2x this fee.
    /// Owner-tunable, capped at 200 bps (2%).
    uint256 public entryExitFeeBps = 0;
    uint256 public constant MAX_FEE_BPS = 200;
    uint256 public constant BPS_DENOM = 10_000;
    /// @dev address => last block in which they minted shares. Used to refuse
    /// a same-block redeem from the same address — the cheapest defence
    /// against the deposit-then-withdraw flash-loan flow.
    mapping(address => uint256) internal _lastMintBlock;

    /// @notice Cost-basis tally — the "book" rail of the dual-rail accounting
    /// model. Grows on user deposits and on base-asset fee inflows from
    /// `executeCollectFees`; shrinks on user withdraws. Never moves with pool
    /// spot, so flash-loan price manipulation cannot shift it. Combined with
    /// the spot-priced "market" rail in `_marketTAV()` for asymmetric
    /// settlement: deposits charge MAX(book, market), redeems pay
    /// MIN(book, market). This makes multi-block manipulation profitless
    /// because the unmanipulable rail always pins the disadvantaged side.
    uint256 public bookTAV;

    address public agent;
    address public guardian;

    /// @dev Snapshot of pool data captured the first time the vault interacts
    /// with a pool, so removeLiquidity / valuation continue to work even if
    /// the pool is later dropped from the registry.
    mapping(bytes32 => PoolRegistry.Pool) internal _trackedPools;
    /// @dev Pools the guardian has marked as broken: their valuation is
    /// excluded from `totalAssets()` so a single bad pool can't brick the
    /// vault's accounting. The pool's positions and balances remain on
    /// chain; the guardian can investigate and re-enable later.
    mapping(bytes32 => bool) internal _orphanedPool;
    /// @dev Position IDs the vault holds, grouped by pool.
    mapping(bytes32 => uint256[]) internal _positionIdsByPool;
    /// @dev (poolKey, positionId) => 1-based index into `_positionIdsByPool`.
    mapping(bytes32 => mapping(uint256 => uint256)) internal _positionIndex;
    /// @dev Pools where the vault currently holds at least one position.
    bytes32[] internal _activePoolKeys;
    /// @dev poolKey => 1-based index into `_activePoolKeys`.
    mapping(bytes32 => uint256) internal _activePoolKeyIndex;
    /// @dev nonBaseToken => poolKey designated as that token's "valuation
    /// pool". The first pool tracked that contains the token wins; any later
    /// pool that also contains it is skipped during idle-non-base accounting
    /// to avoid double-counting. Cleared in `_untrackPool` if the orphaned
    /// pool was the valuation source. O(1) lookup — replaces an earlier
    /// O(N²) scan.
    mapping(address => bytes32) internal _valuationPoolByToken;

    event AgentUpdated(address indexed previous, address indexed current);
    event GuardianUpdated(address indexed previous, address indexed current);
    event AdapterBootstrapped(address indexed nftManager, address indexed adapter);
    event AdapterRevoked(address indexed nftManager, address indexed adapter);
    event RedeemedInKind(address indexed owner, address indexed receiver, uint256 shares);
    event InKindToken(address indexed token, uint256 amount);
    event Swept(address indexed token, address indexed recipient, uint256 amount);
    event SwapNotionalCapBpsUpdated(uint256 previous, uint256 current);
    event EntryExitFeeBpsUpdated(uint256 previous, uint256 current);
    event PoolTracked(bytes32 indexed poolKey, address indexed nonBaseToken);
    event PoolUntracked(bytes32 indexed poolKey);
    event PoolOrphaned(bytes32 indexed poolKey, bool orphaned);
    event PositionTracked(bytes32 indexed poolKey, uint256 indexed positionId);
    event PositionUntracked(bytes32 indexed poolKey, uint256 indexed positionId);
    event LiquidityAdded(bytes32 indexed poolKey, uint256 positionId, uint256 amount0Used, uint256 amount1Used);
    event LiquidityRemoved(bytes32 indexed poolKey, uint256 positionId, uint256 amount0Out, uint256 amount1Out);
    event FeesCollected(bytes32 indexed poolKey, uint256 positionId, uint256 amount0, uint256 amount1);
    event Swapped(bytes32 indexed poolKey, address indexed tokenIn, uint256 amountIn, uint256 amountOut);

    error NotAgent();
    error NotGuardian();
    error NotAgentOrGuardian();
    error PoolNotAddAllowed(bytes32 key);
    error PoolNotKnown(bytes32 key);
    error PoolNotTracked(bytes32 key);
    error BaseAssetNotInPool(bytes32 key);
    error MaxAllocationExceeded(bytes32 key);
    error HookedPoolsNotAllowed(bytes32 key);
    error PoolStillHasPositions(bytes32 key);
    error PositionNotTracked(bytes32 key, uint256 positionId);
    error AdapterNftManagerMismatch(address expected, address provided);
    error MaxPositionsPerPoolExceeded(bytes32 key);
    error SlippageExceeded(uint256 actual, uint256 limit);
    error InKindArrayMismatch();
    error CannotSweepProtectedToken(address token);
    error SlippageMinRequired();
    error SwapNotionalCapExceeded(uint256 amountIn, uint256 cap);
    error InsufficientLiquidityAfterUnwind(uint256 needed, uint256 available);
    error SameBlockMintAndRedeem();
    error InvalidFeeBps(uint256 bps);
    error EthTransferFailed();

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(
        IERC20 baseAsset,
        string memory name_,
        string memory symbol_,
        PoolRegistry _registry,
        address initialOwner,
        address initialAgent,
        address initialGuardian
    ) ERC4626(baseAsset) ERC20(name_, symbol_) Ownable(initialOwner) {
        registry = _registry;
        agent = initialAgent;
        guardian = initialGuardian;
        emit AgentUpdated(address(0), initialAgent);
        emit GuardianUpdated(address(0), initialGuardian);
    }

    /// @notice Accept native ETH transfers. V4 native-ETH pools deliver ETH
    /// directly to `msg.sender` of `modifyLiquidities` (the adapter), which
    /// forwards it here. Also lets agent-routed swaps that bottom out in
    /// native ETH credit the vault.
    receive() external payable {}

    /// @notice Balance of `token` held by `holder`. Native ETH (the V4
    /// sentinel `address(0)`) resolves to `holder.balance`; ERC20s use
    /// `balanceOf`. Called with `address(this)` for the vault's own
    /// balances and with `receiver` for redeem slippage delta checks.
    function _balanceOf(address token, address holder) internal view returns (uint256) {
        return token == address(0) ? holder.balance : IERC20(token).balanceOf(holder);
    }

    // -------- Role management --------

    function setAgent(address newAgent) external onlyOwner {
        emit AgentUpdated(agent, newAgent);
        agent = newAgent;
    }

    function setGuardian(address newGuardian) external onlyOwner {
        emit GuardianUpdated(guardian, newGuardian);
        guardian = newGuardian;
    }

    function setSwapNotionalCapBps(uint256 newCap) external onlyOwner {
        if (newCap == 0 || newCap > BPS_DENOM) revert InvalidFeeBps(newCap);
        emit SwapNotionalCapBpsUpdated(swapNotionalCapBps, newCap);
        swapNotionalCapBps = newCap;
    }

    function setEntryExitFeeBps(uint256 newFee) external onlyOwner {
        if (newFee > MAX_FEE_BPS) revert InvalidFeeBps(newFee);
        emit EntryExitFeeBpsUpdated(entryExitFeeBps, newFee);
        entryExitFeeBps = newFee;
    }

    function pause() external onlyGuardian {
        _pause();
    }

    function unpause() external onlyGuardian {
        _unpause();
    }

    /// @notice Authorise `adapter` to operate the vault's LP NFTs held in
    /// `nftManager` (V3 NonfungiblePositionManager or V4 PositionManager).
    /// Required before the agent can call removeLiquidity or collectFees.
    /// We cross-check that `nftManager` matches the adapter's own
    /// `nftManager()` so a mistyped guardian call can't grant the operator
    /// approval on an unrelated ERC721.
    function bootstrapAdapter(address nftManager_, address adapter) external onlyGuardian {
        address expected = ILiquidityAdapter(adapter).nftManager();
        if (expected != nftManager_) revert AdapterNftManagerMismatch(expected, nftManager_);
        IERC721(nftManager_).setApprovalForAll(adapter, true);
        emit AdapterBootstrapped(nftManager_, adapter);
    }

    /// @notice Symmetric off-switch for `bootstrapAdapter`. Same NFT-manager
    /// validation applies.
    function revokeAdapter(address nftManager_, address adapter) external onlyGuardian {
        address expected = ILiquidityAdapter(adapter).nftManager();
        if (expected != nftManager_) revert AdapterNftManagerMismatch(expected, nftManager_);
        IERC721(nftManager_).setApprovalForAll(adapter, false);
        emit AdapterRevoked(nftManager_, adapter);
    }

    /// @notice Mark a tracked pool as orphaned so `totalAssets()` skips it.
    /// Use when the pool's adapter or non-base token is misbehaving and
    /// would otherwise brick the entire vault's valuation. Positions in the
    /// pool stay on chain; the agent can still call `executeRemoveLiquidity`
    /// or `closeAllPositionsInPool` to wind them down. Reversible.
    function setPoolOrphaned(bytes32 poolKey, bool orphaned) external onlyGuardian {
        _orphanedPool[poolKey] = orphaned;
        emit PoolOrphaned(poolKey, orphaned);
    }

    function isPoolOrphaned(bytes32 poolKey) external view returns (bool) {
        return _orphanedPool[poolKey];
    }

    /// @notice Sweep an ERC20 the vault accidentally received but doesn't
    /// participate in. Refuses the base asset and any token that appears
    /// as `token0` or `token1` in any registry-known pool (so positions
    /// and idle non-base balances can never be drained this way).
    function guardianSweep(address token, address recipient, uint256 amount) external onlyGuardian {
        if (token == asset()) revert CannotSweepProtectedToken(token);
        uint256 numPools = registry.poolCount();
        for (uint256 i; i < numPools;) {
            PoolRegistry.Pool memory p = registry.getPool(registry.poolKeys(i));
            if (p.token0 == token || p.token1 == token) revert CannotSweepProtectedToken(token);
            unchecked {
                ++i;
            }
        }
        IERC20(token).safeTransfer(recipient, amount);
        emit Swept(token, recipient, amount);
    }

    // -------- ERC-4626 valuation --------

    /// @notice Virtual-share offset used by ERC4626 to mitigate the inflate-
    /// the-share-price donation attack. A 6-decimal offset means a malicious
    /// first depositor can't price subsequent deposits down to zero shares
    /// without paying a proportional cost.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// @inheritdoc ERC4626
    /// @dev Returns `MIN(bookTAV, marketTAV)` — the always-redeemable floor.
    /// This is what depositors and redeemers see through every standard
    /// ERC4626 query (`previewDeposit`, `previewRedeem`, etc.). It is the
    /// pessimistic rail; the optimistic rail is exposed separately as
    /// `marketTAV()` for UI-only display of unrealised PnL.
    function totalAssets() public view override returns (uint256) {
        uint256 mkt = _marketTAV();
        return bookTAV < mkt ? bookTAV : mkt;
    }

    /// @notice Spot-priced view of vault holdings — idle base + idle non-base
    /// (priced through pool spot) + every open position decomposed into
    /// token amounts at current spot. Manipulable by flash-loan attackers;
    /// the dual-rail model uses it only as one side of the asymmetric
    /// settlement rule, never as the sole source of truth.
    function marketTAV() external view returns (uint256) {
        return _marketTAV();
    }

    function _marketTAV() internal view returns (uint256 total) {
        address base = asset();
        total = IERC20(base).balanceOf(address(this));

        uint256 numPools = _activePoolKeys.length;
        for (uint256 i; i < numPools;) {
            // Skip pools the guardian has marked orphaned. They contribute
            // zero to TAV until manually rehabilitated.
            bytes32 key = _activePoolKeys[i];
            if (_orphanedPool[key]) {
                unchecked {
                    ++i;
                }
                continue;
            }
            // A misbehaving non-base token, broken adapter, or pre-init pool
            // would otherwise brick deposits/redemptions. Skip and continue;
            // the guardian can `setPoolOrphaned` to surface and fix the
            // root cause if needed.
            try this.poolValueExternal(key) returns (uint256 v) {
                total += v;
            } catch {
                // intentionally swallowed — see comment above
            }
            unchecked {
                ++i;
            }
        }
    }

    /// @notice External wrapper around `_poolValueWithIdle` so `totalAssets`
    /// can wrap the per-pool block in `try/catch` without using `call`.
    /// Marked external + view so it can only be invoked statically.
    function poolValueExternal(bytes32 key) external view returns (uint256) {
        return _poolValueWithIdle(key);
    }

    /// @dev Per-pool value contribution to TAV: idle non-base balance (only
    /// charged once per token, attributed to the lowest-index pool that
    /// contains it) + sum of position values. Always priced through the
    /// pool's own spot. The slot0 read is amortised across every position
    /// in the pool (one read per call, not one per position).
    function _poolValueWithIdle(bytes32 key) internal view returns (uint256 value) {
        PoolRegistry.Pool memory pool = _trackedPools[key];
        if (pool.adapter == address(0)) return 0;
        ILiquidityAdapter adapter_ = ILiquidityAdapter(pool.adapter);
        address base = asset();
        bool baseIsToken0 = (pool.token0 == base);
        address nonBase = baseIsToken0 ? pool.token1 : pool.token0;

        uint160 sqrtPriceX96 = adapter_.getSpotSqrtPriceX96(pool);

        // O(1) attribution: only the designated valuation pool for `nonBase`
        // attributes idle non-base. Matches the historic semantics of
        // _alreadyCounted but without the per-call O(N) scan.
        if (_valuationPoolByToken[nonBase] == key) {
            uint256 idleNonBase = _balanceOf(nonBase, address(this));
            if (idleNonBase > 0) {
                value += _convertToBase(idleNonBase, sqrtPriceX96, !baseIsToken0);
            }
        }

        uint256[] storage ids = _positionIdsByPool[key];
        uint256 numPositions = ids.length;
        for (uint256 j; j < numPositions;) {
            (uint256 amount0, uint256 amount1) = adapter_.getPositionAmountsAtPrice(pool, ids[j], sqrtPriceX96);
            uint256 baseAmount = baseIsToken0 ? amount0 : amount1;
            uint256 nonBaseAmount = baseIsToken0 ? amount1 : amount0;
            value += baseAmount;
            if (nonBaseAmount > 0) {
                value += _convertToBase(nonBaseAmount, sqrtPriceX96, !baseIsToken0);
            }
            unchecked {
                ++j;
            }
        }
    }

    // -------- Agent entry points --------

    function executeAddLiquidity(
        bytes32 poolKey,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        bytes calldata extra
    )
        external
        onlyAgent
        whenNotPaused
        nonReentrant
        returns (uint256 positionId, uint128 liquidity, uint256 amount0Used, uint256 amount1Used)
    {
        if (!registry.isAddAllowed(poolKey)) revert PoolNotAddAllowed(poolKey);
        PoolRegistry.Pool memory pool = registry.getPool(poolKey);
        address base = asset();
        if (pool.token0 != base && pool.token1 != base) revert BaseAssetNotInPool(poolKey);
        // Hook contracts can fire callbacks inside V4's `modifyLiquidities`
        // that read or steer the vault's state mid-transaction. We require
        // the registry to have explicitly allowlisted the hook (V3 always
        // passes via `hooks == address(0)`). The registry view consults the
        // same map that gates `addPool`, so revoking a hook there blocks
        // both new registrations and live calls.
        if (!registry.isHookAllowed(pool.hooks)) revert HookedPoolsNotAllowed(poolKey);

        // Bind any agent-supplied existingPositionId (last word of `extra`)
        // to the supplied poolKey. Without this a buggy or malicious agent
        // could route increase-liquidity through a position belonging to a
        // different pool and corrupt tracking.
        uint256 existingPositionId = _decodeExistingPositionId(extra);
        if (existingPositionId != 0 && _positionIndex[poolKey][existingPositionId] == 0) {
            revert PositionNotTracked(poolKey, existingPositionId);
        }

        _trackPoolIfNew(poolKey, pool);

        // V4 native-ETH leg (token = address(0)) is paid with msg.value
        // forwarded to the adapter; no ERC20 approval. ERC20 legs use the
        // standard transient-approval pattern.
        uint256 ethValue = 0;
        if (pool.token0 == address(0)) {
            ethValue = amount0Desired;
        } else {
            IERC20(pool.token0).forceApprove(pool.adapter, amount0Desired);
        }
        if (pool.token1 == address(0)) {
            ethValue = amount1Desired;
        } else {
            IERC20(pool.token1).forceApprove(pool.adapter, amount1Desired);
        }

        (positionId, liquidity, amount0Used, amount1Used) = ILiquidityAdapter(pool.adapter)
        .addLiquidity{value: ethValue}(
            pool, amount0Desired, amount1Desired, amount0Min, amount1Min, extra
        );

        if (pool.token0 != address(0)) IERC20(pool.token0).forceApprove(pool.adapter, 0);
        if (pool.token1 != address(0)) IERC20(pool.token1).forceApprove(pool.adapter, 0);

        _trackPositionIfNew(poolKey, positionId);

        // Per-pool max allocation cap measured against the manipulation-proof
        // book rail (or the post-trade `totalAssets()` floor when book happens
        // to exceed the floor — pick the smaller, more conservative value).
        // Using bookTAV here means a flash-loan attacker cannot inflate the
        // denominator to bypass the cap.
        uint256 capDenom = bookTAV;
        uint256 floor_ = totalAssets();
        if (floor_ < capDenom) capDenom = floor_;
        if (capDenom > 0) {
            uint256 poolValue = _poolValue(poolKey);
            if (poolValue * 10_000 > pool.maxAllocationBps * capDenom) {
                revert MaxAllocationExceeded(poolKey);
            }
        }

        emit LiquidityAdded(poolKey, positionId, amount0Used, amount1Used);
    }

    /// @dev Lift the trailing `existingPositionId` field out of the agent's
    /// `extra` payload without re-implementing the entire adapter encoding.
    /// Both V3 and V4 adapters use
    /// `abi.encode(int24, int24, uint256, uint256)` so the last word is the
    /// id. Returns 0 for empty / malformed extra so the call still mints
    /// fresh positions.
    function _decodeExistingPositionId(bytes calldata extra) internal pure returns (uint256) {
        if (extra.length < 128) return 0;
        return uint256(bytes32(extra[96:128]));
    }

    function executeRemoveLiquidity(
        bytes32 poolKey,
        uint256 positionId,
        uint128 liquidity,
        uint256 amount0Min,
        uint256 amount1Min,
        bytes calldata extra
    ) external onlyAgent whenNotPaused nonReentrant returns (uint256 amount0Out, uint256 amount1Out, bool burned) {
        PoolRegistry.Pool memory pool = _requireTrackedPool(poolKey);
        if (_positionIndex[poolKey][positionId] == 0) revert PositionNotTracked(poolKey, positionId);
        // Harvest accrued fees across every tracked position before the
        // remove. Otherwise Uniswap's decrease-liquidity action bundles
        // principal + pending fees into a single transfer and the base
        // portion of the fees would never reach the book rail. Iterating
        // all pools is slightly more gas than harvesting just this one,
        // but it keeps the bytecode footprint within EIP-170 and ensures
        // book/market stay aligned across the agent's full surface.
        _harvestAllPositions();
        (amount0Out, amount1Out, burned) =
            ILiquidityAdapter(pool.adapter).removeLiquidity(pool, positionId, liquidity, amount0Min, amount1Min, extra);
        // Tracking cleanup runs after the adapter call because we need its
        // `burned` signal. Safe under `nonReentrant` (no cross-fn re-entry
        // possible) and because adapters are vetted contracts wired in via
        // the guardian-managed registry. `_untrackPosition` performs only
        // local mapping deletes — no external calls.
        if (burned) {
            _untrackPosition(poolKey, positionId);
        }
        emit LiquidityRemoved(poolKey, positionId, amount0Out, amount1Out);
    }

    function executeCollectFees(bytes32 poolKey, uint256 positionId)
        external
        onlyAgent
        whenNotPaused
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        PoolRegistry.Pool memory pool = _requireTrackedPool(poolKey);
        if (_positionIndex[poolKey][positionId] == 0) revert PositionNotTracked(poolKey, positionId);
        (amount0, amount1) = ILiquidityAdapter(pool.adapter).collectFees(pool, positionId);
        // Promote the base-side fee inflow into the book rail. The non-base
        // side stays as idle non-base — it's only "realised" once the agent
        // swaps it back to base, at which point it shows up on a future
        // collect or simply increases marketTAV without book.
        address base = asset();
        if (pool.token0 == base) bookTAV += amount0;
        else if (pool.token1 == base) bookTAV += amount1;
        emit FeesCollected(poolKey, positionId, amount0, amount1);
    }

    function executeSwap(bytes32 poolKey, address tokenIn, uint256 amountIn, uint256 amountOutMin, bytes calldata extra)
        external
        onlyAgent
        whenNotPaused
        nonReentrant
        returns (uint256 amountOut)
    {
        if (amountOutMin == 0) revert SlippageMinRequired();
        if (!registry.isPoolKnown(poolKey)) revert PoolNotKnown(poolKey);
        PoolRegistry.Pool memory pool = registry.getPool(poolKey);
        // Hooked V4 pools are blocked here as well as on the add path
        // unless the registry's hook allowlist authorises them. A hook can
        // fire callbacks during the V4 swap router's unlock/settle cycle
        // and reach back into the vault's read path, so we re-check at
        // every entry point.
        if (!registry.isHookAllowed(pool.hooks)) revert HookedPoolsNotAllowed(poolKey);

        // Per-tx notional cap. The agent can move at most `swapNotionalCapBps`
        // of TAV in any single swap call. We measure `amountIn` in base-asset
        // units: if `tokenIn` is the base asset use it directly; otherwise
        // value it through the pool's spot.
        if (swapNotionalCapBps < BPS_DENOM) {
            uint256 tav = totalAssets();
            uint256 cap = (tav * swapNotionalCapBps) / BPS_DENOM;
            uint256 amountInBase;
            if (tokenIn == asset()) {
                amountInBase = amountIn;
            } else {
                uint160 sqrtPriceX96 = ILiquidityAdapter(pool.adapter).getSpotSqrtPriceX96(pool);
                amountInBase = _convertToBase(amountIn, sqrtPriceX96, tokenIn == pool.token0);
            }
            if (amountInBase > cap) revert SwapNotionalCapExceeded(amountInBase, cap);
        }

        // Native ETH input: forward via msg.value, no approval. ERC20 input:
        // standard transient approval.
        uint256 ethValue = 0;
        if (tokenIn == address(0)) {
            ethValue = amountIn;
        } else {
            IERC20(tokenIn).forceApprove(pool.adapter, amountIn);
        }
        amountOut =
            ILiquidityAdapter(pool.adapter).swapExactIn{value: ethValue}(pool, tokenIn, amountIn, amountOutMin, extra);
        if (tokenIn != address(0)) IERC20(tokenIn).forceApprove(pool.adapter, 0);

        emit Swapped(poolKey, tokenIn, amountIn, amountOut);
    }

    /// @notice Wind down every position the vault holds in `poolKey`. Each
    /// position is removed at its current liquidity with `burnIfEmpty = true`,
    /// so the NFT is burned and the pool is automatically untracked when the
    /// last position closes. Callable by the agent (normal operation) or the
    /// guardian (emergency override). Runs even while the vault is paused so
    /// emergency wind-downs aren't blocked by the kill switch.
    ///
    /// After this returns, the guardian may safely call
    /// `registry.removePool(poolKey)` to drop the pool from the whitelist
    /// entirely.
    ///
    /// Slippage protection is intentionally `min = 0` per position. Callers
    /// who need strict per-position slippage should iterate
    /// `getPositionIds(poolKey)` and invoke `executeRemoveLiquidity` directly.
    function closeAllPositionsInPool(bytes32 poolKey, uint256 deadline) external nonReentrant {
        if (msg.sender != agent && msg.sender != guardian) revert NotAgentOrGuardian();
        PoolRegistry.Pool memory pool = _requireTrackedPool(poolKey);
        ILiquidityAdapter adapter_ = ILiquidityAdapter(pool.adapter);

        uint256[] memory ids = _positionIdsByPool[poolKey];
        uint256 idsLen = ids.length;
        bytes memory extra = abi.encode(deadline, true);

        // Single harvest across every tracked position. Same rationale as
        // executeRemoveLiquidity: keeps bookTAV aligned with the base-side
        // fees that the per-position remove would otherwise bundle and hide.
        _harvestAllPositions();
        for (uint256 i; i < idsLen;) {
            uint128 liquidity = adapter_.getPositionLiquidity(pool, ids[i]);
            // A zero reading can mean the position was already burned OR
            // that the adapter view itself reverted and was caught upstream.
            // Skip the position without untracking; a real burn will surface
            // via the next `executeRemoveLiquidity` and untrack cleanly.
            if (liquidity > 0) {
                // try/catch so a single broken position (paused pool,
                // malicious hook, NFT-state oddity) doesn't DoS the rest
                // of the wind-down. Skipped positions can be investigated
                // via PositionTracked events or swept manually.
                try adapter_.removeLiquidity(pool, ids[i], liquidity, 0, 0, extra) returns (
                    uint256 amount0Out, uint256 amount1Out, bool burned
                ) {
                    if (burned) _untrackPosition(poolKey, ids[i]);
                    emit LiquidityRemoved(poolKey, ids[i], amount0Out, amount1Out);
                } catch {}
            }
            unchecked {
                ++i;
            }
        }
    }

    // -------- Views into tracking state --------

    function trackedPool(bytes32 key) external view returns (PoolRegistry.Pool memory) {
        return _trackedPools[key];
    }

    function getActivePools() external view returns (bytes32[] memory) {
        return _activePoolKeys;
    }

    function getPositionIds(bytes32 poolKey) external view returns (uint256[] memory) {
        return _positionIdsByPool[poolKey];
    }

    function positionCount(bytes32 poolKey) external view returns (uint256) {
        return _positionIdsByPool[poolKey].length;
    }

    // -------- User-facing slippage-protected wrappers --------

    /// @notice Same as `deposit` but reverts if the depositor would receive
    /// fewer than `minSharesOut` shares. Protects against marketTAV being
    /// pumped between transaction sign and execution.
    function depositWithMin(uint256 assets, address receiver, uint256 minSharesOut) external returns (uint256 shares) {
        shares = deposit(assets, receiver);
        if (shares < minSharesOut) revert SlippageExceeded(shares, minSharesOut);
    }

    /// @notice Same as `mint` but reverts if the depositor would have to pay
    /// more than `maxAssetsIn` assets. Protects against marketTAV being
    /// pumped between transaction sign and execution.
    function mintWithMax(uint256 shares, address receiver, uint256 maxAssetsIn) external returns (uint256 assets) {
        assets = mint(shares, receiver);
        if (assets > maxAssetsIn) revert SlippageExceeded(assets, maxAssetsIn);
    }

    /// @notice Same as `withdraw` but reverts if the redeemer would have to
    /// burn more than `maxSharesIn` shares. Protects against marketTAV being
    /// dumped between transaction sign and execution.
    function withdrawWithMax(uint256 assets, address receiver, address owner, uint256 maxSharesIn)
        external
        returns (uint256 shares)
    {
        shares = withdraw(assets, receiver, owner);
        if (shares > maxSharesIn) revert SlippageExceeded(shares, maxSharesIn);
    }

    /// @notice Same as `redeem` but reverts if the redeemer would receive
    /// fewer than `minAssetsOut` assets. Protects against marketTAV being
    /// dumped between transaction sign and execution AND against the
    /// auto-unwind realising less than the previewed amount.
    function redeemWithMin(uint256 shares, address receiver, address owner, uint256 minAssetsOut)
        external
        returns (uint256 assets)
    {
        assets = redeem(shares, receiver, owner);
        if (assets < minAssetsOut) revert SlippageExceeded(assets, minAssetsOut);
    }

    // -------- In-kind redemption (illiquid-pool escape hatch) --------

    /// @notice Burn `shares` from `owner` and pay `receiver` a pro-rata
    /// slice of every token the vault holds — including the underlying
    /// tokens of every open LP position. Bypasses the auto-unwind's
    /// reliance on swap liquidity, so it works even when on-chain swap
    /// venues are dry. Slippage is enforced via `expectedTokens` /
    /// `minAmounts`: every entry in `expectedTokens` must be paid at
    /// least the matching `minAmounts` value or the call reverts.
    /// @dev Standard same-block-mint-and-redeem lockout still applies.
    function redeemInKind(
        uint256 shares,
        address receiver,
        address owner,
        address[] calldata expectedTokens,
        uint256[] calldata minAmounts
    ) external nonReentrant whenNotPaused {
        if (expectedTokens.length != minAmounts.length) revert InKindArrayMismatch();
        if (_lastMintBlock[owner] == block.number || _lastMintBlock[msg.sender] == block.number) {
            revert SameBlockMintAndRedeem();
        }
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }

        uint256 supply = totalSupply();
        require(supply > 0 && shares > 0, "ALP: zero shares");

        // Crystallize accrued LP fees into idle balance + bookTAV BEFORE
        // snapshotting. Without this, Uniswap's decrease-liquidity action
        // (called inside the per-position peel below) would settle 100%
        // of pending fees on every touched position; `_settleInKind` would
        // then route 100% of that fee inflow to the redeemer regardless of
        // their share — a one-shot fee-extraction path. Harvest first → the
        // peel only releases ratio*principal → fees get distributed strictly
        // pro-rata.
        _harvestAllPositions();

        // Snapshot pre-peel idle balances. The base is snapshotted directly;
        // every non-base token reachable via an active pool gets one entry
        // in the parallel arrays so phase 2 can use the same delta+ratio
        // formula `_settleInKind` uses for the base, instead of paying out
        // ratio of the post-peel balance (which would silently dilute the
        // redeemer's slice of the peeled portion).
        address base = asset();
        uint256 baseIdleBefore = IERC20(base).balanceOf(address(this));
        uint256 numPools = _activePoolKeys.length;
        // Over-snapshot: one entry per active pool, valuation/orphan gate
        // applied in the distribution loop. Cheaper bytecode than gating
        // here too.
        address[] memory nonBaseTokens = new address[](numPools);
        uint256[] memory nonBaseIdleBefore = new uint256[](numPools);
        for (uint256 i; i < numPools; ++i) {
            PoolRegistry.Pool memory pool = _trackedPools[_activePoolKeys[i]];
            address nb = (pool.token0 == base) ? pool.token1 : pool.token0;
            nonBaseTokens[i] = nb;
            nonBaseIdleBefore[i] = _balanceOf(nb, address(this));
        }
        // Snapshot receiver's pre-call balances for every expectedTokens
        // entry so the slippage check can compare a real delta instead of
        // the receiver's absolute holdings.
        uint256[] memory receiverBalBefore = new uint256[](expectedTokens.length);
        for (uint256 k; k < expectedTokens.length; ++k) {
            receiverBalBefore[k] = _balanceOf(expectedTokens[k], receiver);
        }

        // Phase 1: peel ratio × current liquidity from every tracked
        // position. This puts the user's slice of position-held tokens into
        // the vault as idle balance.
        bytes memory removeExtra = abi.encode(block.timestamp, false);
        for (uint256 i; i < numPools; ++i) {
            bytes32 key = _activePoolKeys[i];
            if (_orphanedPool[key]) continue;
            PoolRegistry.Pool memory pool = _trackedPools[key];
            ILiquidityAdapter adapter_ = ILiquidityAdapter(pool.adapter);
            uint256[] storage ids = _positionIdsByPool[key];
            for (uint256 j; j < ids.length; ++j) {
                uint128 currentLiq = adapter_.getPositionLiquidity(pool, ids[j]);
                if (currentLiq == 0) continue;
                uint128 toPeel = uint128((uint256(currentLiq) * shares) / supply);
                if (toPeel == 0) continue;
                try adapter_.removeLiquidity(pool, ids[j], toPeel, 0, 0, removeExtra) returns (
                    uint256, uint256, bool burned
                ) {
                    if (burned) _untrackPosition(key, ids[j]);
                } catch {
                    // Skip a position whose remove reverts (e.g. paused
                    // pool); user still gets ratio of all idle balances.
                }
            }
        }

        // Phase 2: settle. Burn shares first, decrement bookTAV
        // proportionally, then transfer the user's slice of every relevant
        // token. Slice math (per token):
        //   user_amount = (now_balance - idleBefore) + ratio * idleBefore
        // i.e. ALL of the peeled inflow (sized to user share) plus ratio of
        // the pre-peel idle. Same formula on base and non-base rails so the
        // user is never under-paid the slice they just earned.
        _burn(owner, shares);
        uint256 bookSlice = Math.mulDiv(bookTAV, shares, supply, Math.Rounding.Floor);
        bookTAV = bookTAV > bookSlice ? bookTAV - bookSlice : 0;

        emit RedeemedInKind(owner, receiver, shares);

        // Distribute the base asset.
        _settleInKind(base, baseIdleBefore, shares, supply, receiver);
        // Distribute every non-base token whose valuation slot belongs to
        // an active, non-orphaned pool. Same snapshot-aware delta+ratio
        // formula as the base rail, so non-base redeemers aren't
        // under-paid their peeled slice.
        for (uint256 i; i < numPools; ++i) {
            bytes32 key = _activePoolKeys[i];
            if (_orphanedPool[key]) continue;
            address nb = nonBaseTokens[i];
            if (_valuationPoolByToken[nb] != key) continue;
            _settleInKind(nb, nonBaseIdleBefore[i], shares, supply, receiver);
        }

        // Verify caller-supplied per-token minimums against the actual
        // delta paid this call (not the receiver's absolute balance).
        // address(0) routes through `.balance` so the slippage check works
        // for native-ETH receivers too.
        for (uint256 k; k < expectedTokens.length; ++k) {
            uint256 paid = _balanceOf(expectedTokens[k], receiver) - receiverBalBefore[k];
            if (paid < minAmounts[k]) revert SlippageExceeded(paid, minAmounts[k]);
        }
    }

    function _settleInKind(address token, uint256 idleBefore, uint256 shares, uint256 supply, address receiver)
        internal
        returns (uint256 amount)
    {
        uint256 nowBalance = _balanceOf(token, address(this));
        // Pre-existing idle: user gets ratio. Peeled-this-call: user gets
        // all (sized to their share already). Combined:
        //   ratio_idle + peeled = ratio*idle + (now - idle)
        //                       = now - idle*(1 - ratio)
        amount = nowBalance > idleBefore
            ? (nowBalance - idleBefore) + Math.mulDiv(idleBefore, shares, supply)
            : Math.mulDiv(nowBalance, shares, supply);
        if (amount > 0) {
            if (token == address(0)) {
                (bool ok,) = receiver.call{value: amount}("");
                if (!ok) revert EthTransferFailed();
            } else {
                IERC20(token).safeTransfer(receiver, amount);
            }
            emit InKindToken(token, amount);
        }
    }

    // -------- ERC721 receiver --------

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // -------- Pause + reentrancy hooks + anti-MEV layer --------

    /// @dev Raw fee-free share math against the deposit-direction rail
    /// `MAX(book, market)`. Used by both ERC4626's public `convertToShares`
    /// and as the math primitive behind `previewDeposit`/`previewWithdraw`.
    /// Direction-specific fee handling lives in the four `preview*`
    /// overrides below so that mint and withdraw cannot bypass the fee.
    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {
        uint256 mkt = _marketTAV();
        uint256 effectiveTAV = bookTAV > mkt ? bookTAV : mkt;
        return Math.mulDiv(assets, totalSupply() + 10 ** _decimalsOffset(), effectiveTAV + 1, rounding);
    }

    /// @dev Raw fee-free asset math against the redeem-direction rail
    /// `MIN(book, market)` (returned by `totalAssets()`). Mirror of
    /// `_convertToShares`.
    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {
        return Math.mulDiv(shares, totalAssets() + 1, totalSupply() + 10 ** _decimalsOffset(), rounding);
    }

    // -------- ERC-4626 preview overrides with correct fee direction --------

    /// @inheritdoc ERC4626
    /// @dev `assets` flow IN; user pays the fee, vault keeps it. Net assets
    /// price the share math so the depositor effectively buys fewer shares
    /// than they would gross.
    function previewDeposit(uint256 assets) public view virtual override returns (uint256) {
        uint256 net = assets - _entryFee(assets);
        return _convertToShares(net, Math.Rounding.Floor);
    }

    /// @inheritdoc ERC4626
    /// @dev User specifies a target share count. We compute the net assets
    /// needed to mint that many shares, then gross-up so the user pays
    /// `gross = net / (1 - fee)`. Vault keeps `gross - net` as fee revenue.
    function previewMint(uint256 shares) public view virtual override returns (uint256) {
        uint256 net = _convertToAssetsAtDepositRail(shares, Math.Rounding.Ceil);
        if (entryExitFeeBps == 0) return net;
        // Gross-up: gross * (BPS_DENOM - fee) / BPS_DENOM = net
        return Math.mulDiv(net, BPS_DENOM, BPS_DENOM - entryExitFeeBps, Math.Rounding.Ceil);
    }

    /// @inheritdoc ERC4626
    /// @dev User specifies a target asset count to receive. We gross-up the
    /// asset count so the share burn covers `assets + fee`; the fee stays
    /// in the vault. Math is pinned to the redeem-direction rail
    /// (`totalAssets() = MIN(book, market)`) so withdraw cannot be a
    /// cheaper exit than the equivalent redeem when the rails are split.
    function previewWithdraw(uint256 assets) public view virtual override returns (uint256) {
        uint256 grossNeeded = entryExitFeeBps == 0
            ? assets
            : Math.mulDiv(assets, BPS_DENOM, BPS_DENOM - entryExitFeeBps, Math.Rounding.Ceil);
        return Math.mulDiv(grossNeeded, totalSupply() + 10 ** _decimalsOffset(), totalAssets() + 1, Math.Rounding.Ceil);
    }

    /// @inheritdoc ERC4626
    /// @dev `shares` flow IN, assets flow OUT. Fee charged on the outflow.
    function previewRedeem(uint256 shares) public view virtual override returns (uint256) {
        uint256 gross = _convertToAssets(shares, Math.Rounding.Floor);
        return gross - _entryFee(gross);
    }

    function _entryFee(uint256 assets) internal view returns (uint256) {
        return (assets * entryExitFeeBps) / BPS_DENOM;
    }

    /// @dev Mint pricing uses the deposit-direction rail (MAX); we can't
    /// reuse `_convertToAssets` directly because that one is pinned to
    /// `totalAssets()` (= MIN, the redeem rail).
    function _convertToAssetsAtDepositRail(uint256 shares, Math.Rounding rounding) internal view returns (uint256) {
        uint256 mkt = _marketTAV();
        uint256 effectiveTAV = bookTAV > mkt ? bookTAV : mkt;
        return Math.mulDiv(shares, effectiveTAV + 1, totalSupply() + 10 ** _decimalsOffset(), rounding);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
        nonReentrant
    {
        // Auto-harvest before pricing the deposit — flushes accrued LP fees
        // into idle base + bookTAV, so the depositor pays a price that
        // reflects realised yield rather than missing it on the bookTAV side.
        // Honest-user UX: the asymmetric MAX(book, market) penalty almost
        // disappears because book moves up to meet market.
        _harvestAllPositions();
        // Book rail bumps before the actual transfer/mint, mirroring how
        // value flows through the boundary. The fee component (charged
        // implicitly via _convertToShares) stays in the vault, so the full
        // gross `assets` is what crossed the door.
        bookTAV += assets;
        super._deposit(caller, receiver, assets, shares);
        // Same-block lockout stamps the caller (the funding source) only.
        // Letting third-party deposits poison a victim's slot is a free
        // same-block-redeem grief vector; the receiver's slot is updated
        // through `_update` below, so any shares they end up holding still
        // propagate the caller's stamp via the share transfer.
        _lastMintBlock[caller] = block.number;
    }

    /// @dev Override OpenZeppelin's ERC20 transfer hook so the same-block
    /// lockout follows the shares. Without this, an attacker could deposit
    /// in block N, transfer the shares to a fresh address, and redeem in
    /// the same block from the unstamped address — fully bypassing the
    /// flash-loan defence.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && to != address(0)) {
            uint256 fromStamp = _lastMintBlock[from];
            if (fromStamp > _lastMintBlock[to]) _lastMintBlock[to] = fromStamp;
        }
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
        nonReentrant
    {
        if (_lastMintBlock[owner_] == block.number || _lastMintBlock[caller] == block.number) {
            revert SameBlockMintAndRedeem();
        }
        // Auto-harvest before settling the withdraw — flushes accrued fees
        // into idle base + bookTAV so the redeemer captures their fair share
        // of yield even if the agent hasn't run a fee sweep recently.
        _harvestAllPositions();
        // Auto-unwind: if idle base is short of `assets`, peel pro-rata from
        // every tracked position until either the gap is closed or the loop
        // exhausts itself. Reverts only if the vault genuinely doesn't hold
        // enough underlying value.
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (idle < assets) {
            _unwindForWithdraw(assets - idle);
            idle = IERC20(asset()).balanceOf(address(this));
            if (idle < assets) revert InsufficientLiquidityAfterUnwind(assets, idle);
        }
        // Decrement bookTAV by the actual NET assets paid out (which is what
        // crossed the boundary), not by `bookTAV * shares / supply`. With a
        // non-zero entry/exit fee the share burn corresponds to gross =
        // assets + fee; using the proportional formula would drop bookTAV by
        // the full gross, hiding the retained fee from book and forcing
        // late redeemers to settle on a stale rail. The retained fee stays
        // as donated value to the remaining holders, with bookTAV catching
        // up to the new per-share value automatically.
        bookTAV = bookTAV > assets ? bookTAV - assets : 0;
        super._withdraw(caller, receiver, owner_, assets, shares);
    }

    // -------- Internal: auto-harvest fees on every user interaction --------

    /// @dev Calls `collectFees` on every tracked position so any accrued LP
    /// fees flow into the vault as idle balance (and the base-side bumps
    /// `bookTAV`). Best-effort — a failing position is skipped instead of
    /// reverting the whole user interaction; the guardian can investigate
    /// via the events.
    function _harvestAllPositions() internal {
        uint256 numPools = _activePoolKeys.length;
        if (numPools == 0) return;
        address base = asset();
        for (uint256 i; i < numPools;) {
            bytes32 key = _activePoolKeys[i];
            if (!_orphanedPool[key]) {
                PoolRegistry.Pool memory pool = _trackedPools[key];
                ILiquidityAdapter adapter_ = ILiquidityAdapter(pool.adapter);
                uint256[] storage ids = _positionIdsByPool[key];
                uint256 idsLen = ids.length;
                for (uint256 j; j < idsLen;) {
                    try adapter_.collectFees(pool, ids[j]) returns (uint256 a0, uint256 a1) {
                        if (pool.token0 == base) bookTAV += a0;
                        else if (pool.token1 == base) bookTAV += a1;
                    } catch {
                        // intentionally swallowed — see comment above
                    }
                    unchecked {
                        ++j;
                    }
                }
            }
            unchecked {
                ++i;
            }
        }
    }

    // -------- Internal: auto unwind on withdraw shortfall --------

    /// @dev Peel pro-rata liquidity from every tracked position and convert
    /// any non-base proceeds back into the base asset until at least
    /// `shortfall` base units are available. The fraction peeled per
    /// position is `shortfall / totalAssets()` so we touch every position
    /// once. Best-effort: partial peels run with min=0 (caller is the user
    /// who is exiting; they accept market price). The same-block lockout
    /// already ensures this can't be the second leg of a sandwich.
    function _unwindForWithdraw(uint256 shortfall) internal {
        uint256 numPools = _activePoolKeys.length;
        if (numPools == 0) return;
        address base = asset();
        // Target idle balance once we're done. Comparisons throughout the
        // loop check against this absolute target — much less error-prone
        // than tracking a "still-short" delta as positions get peeled and
        // non-base balances get swapped.
        uint256 startIdle = IERC20(base).balanceOf(address(this));
        uint256 targetIdle = startIdle + shortfall;
        bytes memory removeExtra = abi.encode(block.timestamp, false);
        bytes memory swapExtra = abi.encode(block.timestamp);

        for (uint256 i; i < numPools && IERC20(base).balanceOf(address(this)) < targetIdle; ++i) {
            bytes32 key = _activePoolKeys[i];
            if (_orphanedPool[key]) continue;
            PoolRegistry.Pool memory pool = _trackedPools[key];
            ILiquidityAdapter adapter_ = ILiquidityAdapter(pool.adapter);
            bool baseIsToken0 = (pool.token0 == base);
            uint160 sqrtPriceX96 = adapter_.getSpotSqrtPriceX96(pool);

            uint256[] storage ids = _positionIdsByPool[key];
            for (uint256 j; j < ids.length; ++j) {
                uint256 idleNow = IERC20(base).balanceOf(address(this));
                if (idleNow >= targetIdle) break;
                uint256 stillShort = targetIdle - idleNow;

                uint128 currentLiq = adapter_.getPositionLiquidity(pool, ids[j]);
                if (currentLiq == 0) continue;

                // Size the peel against THIS position's value, not vault TAV.
                // Sizing against TAV under-peels when a position is only a
                // fraction of total value.
                (uint256 amount0, uint256 amount1) = adapter_.getPositionAmountsAtPrice(pool, ids[j], sqrtPriceX96);
                uint256 baseAmt = baseIsToken0 ? amount0 : amount1;
                uint256 nonBaseAmt = baseIsToken0 ? amount1 : amount0;
                uint256 positionValue = baseAmt;
                if (nonBaseAmt > 0) positionValue += _convertToBase(nonBaseAmt, sqrtPriceX96, !baseIsToken0);
                if (positionValue == 0) continue;

                uint128 toPeel;
                if (stillShort >= positionValue) {
                    toPeel = currentLiq;
                } else {
                    // Overshoot by 10% to absorb swap slippage on the
                    // non-base side conversion below.
                    uint256 scaled = (uint256(currentLiq) * stillShort * 11) / (positionValue * 10);
                    toPeel = scaled > currentLiq ? currentLiq : uint128(scaled);
                    if (toPeel == 0) toPeel = 1;
                }

                // Wrap removeLiquidity in try/catch so a single broken pool
                // (paused, malicious hook, NFT-state oddity) doesn't DoS
                // every user's withdraw — the loop continues to other
                // positions / pools and the outer `idle < assets` check at
                // the call site surfaces the shortfall cleanly.
                try adapter_.removeLiquidity(pool, ids[j], toPeel, 0, 0, removeExtra) returns (
                    uint256, uint256, bool burned
                ) {
                    if (burned) _untrackPosition(key, ids[j]);
                } catch {}
            }

            // Swap any non-base proceeds in this pool back to base. Slippage
            // floor derived from this pool's spot ± UNWIND_SLIPPAGE_BPS so a
            // third-party MEV bot can't sandwich the auto-unwind swap and
            // siphon value from remaining holders. Skipped silently on
            // revert (dust below router minimum, slippage trip, etc.).
            address nonBase = baseIsToken0 ? pool.token1 : pool.token0;
            uint256 nonBaseBal = _balanceOf(nonBase, address(this));
            if (nonBaseBal > 0) {
                uint256 expected = _convertToBase(nonBaseBal, sqrtPriceX96, !baseIsToken0);
                uint256 minOut = expected == 0 ? 1 : (expected * (BPS_DENOM - UNWIND_SLIPPAGE_BPS)) / BPS_DENOM;
                if (minOut == 0) minOut = 1;
                uint256 ethValue = 0;
                if (nonBase == address(0)) {
                    ethValue = nonBaseBal;
                } else {
                    IERC20(nonBase).forceApprove(pool.adapter, nonBaseBal);
                }
                try adapter_.swapExactIn{value: ethValue}(pool, nonBase, nonBaseBal, minOut, swapExtra) {} catch {}
                if (nonBase != address(0)) IERC20(nonBase).forceApprove(pool.adapter, 0);
            }
        }
    }

    // -------- Internal: tracking --------

    function _requireTrackedPool(bytes32 key) internal view returns (PoolRegistry.Pool memory pool) {
        pool = _trackedPools[key];
        if (pool.adapter == address(0)) revert PoolNotTracked(key);
    }

    function _trackPoolIfNew(bytes32 key, PoolRegistry.Pool memory pool) internal {
        if (_activePoolKeyIndex[key] != 0) return;
        _trackedPools[key] = pool;
        _activePoolKeys.push(key);
        _activePoolKeyIndex[key] = _activePoolKeys.length;
        address base = asset();
        address nonBase = pool.token0 == base ? pool.token1 : pool.token0;
        if (_valuationPoolByToken[nonBase] == bytes32(0)) {
            _valuationPoolByToken[nonBase] = key;
        }
        emit PoolTracked(key, nonBase);
    }

    function _trackPositionIfNew(bytes32 key, uint256 positionId) internal {
        if (_positionIndex[key][positionId] != 0) return;
        if (_positionIdsByPool[key].length >= MAX_POSITIONS_PER_POOL) revert MaxPositionsPerPoolExceeded(key);
        _positionIdsByPool[key].push(positionId);
        _positionIndex[key][positionId] = _positionIdsByPool[key].length;
        emit PositionTracked(key, positionId);
    }

    function _untrackPosition(bytes32 key, uint256 positionId) internal {
        uint256 idx = _positionIndex[key][positionId];
        if (idx == 0) return;

        uint256[] storage ids = _positionIdsByPool[key];
        uint256 last = ids.length - 1;
        if (idx - 1 != last) {
            uint256 lastId = ids[last];
            ids[idx - 1] = lastId;
            _positionIndex[key][lastId] = idx;
        }
        ids.pop();
        delete _positionIndex[key][positionId];
        emit PositionUntracked(key, positionId);

        if (ids.length == 0) {
            _untrackPool(key);
        }
    }

    function _untrackPool(bytes32 key) internal {
        uint256 idx = _activePoolKeyIndex[key];
        if (idx == 0) return;

        // If the pool we're dropping was the valuation source for its
        // non-base token, try to hand the slot to a surviving pool that
        // still pairs with the same token — otherwise the token's idle
        // balance silently disappears from `_marketTAV` until/unless a
        // fresh pool with that token gets registered.
        PoolRegistry.Pool memory pool = _trackedPools[key];
        address base = asset();
        address nonBase = pool.token0 == base ? pool.token1 : pool.token0;
        if (_valuationPoolByToken[nonBase] == key) {
            delete _valuationPoolByToken[nonBase];
            // Scan remaining active pools (excluding the one being dropped,
            // which is at index `idx-1` and will be removed below) for any
            // that contains nonBase, and reassign the slot.
            uint256 numActive = _activePoolKeys.length;
            for (uint256 i; i < numActive; ++i) {
                bytes32 candidate = _activePoolKeys[i];
                if (candidate == key) continue;
                PoolRegistry.Pool memory p = _trackedPools[candidate];
                if (p.token0 == nonBase || p.token1 == nonBase) {
                    _valuationPoolByToken[nonBase] = candidate;
                    break;
                }
            }
        }

        uint256 last = _activePoolKeys.length - 1;
        if (idx - 1 != last) {
            bytes32 lastKey = _activePoolKeys[last];
            _activePoolKeys[idx - 1] = lastKey;
            _activePoolKeyIndex[lastKey] = idx;
        }
        _activePoolKeys.pop();
        delete _activePoolKeyIndex[key];
        delete _trackedPools[key];
        emit PoolUntracked(key);
    }

    // -------- Internal: valuation --------

    /// @dev Value held in `key` (positions only, not idle non-base), used to
    /// enforce per-pool max allocation caps. Idle non-base is excluded so the
    /// cap measures committed liquidity rather than transient balances mid-
    /// rebalance. Single slot0 read amortised across all positions in the
    /// pool.
    function _poolValue(bytes32 key) internal view returns (uint256 value) {
        PoolRegistry.Pool memory pool = _trackedPools[key];
        if (pool.adapter == address(0)) return 0;
        ILiquidityAdapter adapter_ = ILiquidityAdapter(pool.adapter);
        bool baseIsToken0 = (pool.token0 == asset());
        uint160 sqrtPriceX96 = adapter_.getSpotSqrtPriceX96(pool);

        uint256[] storage ids = _positionIdsByPool[key];
        for (uint256 j; j < ids.length; ++j) {
            (uint256 amount0, uint256 amount1) = adapter_.getPositionAmountsAtPrice(pool, ids[j], sqrtPriceX96);
            uint256 baseAmount = baseIsToken0 ? amount0 : amount1;
            uint256 nonBaseAmount = baseIsToken0 ? amount1 : amount0;
            value += baseAmount;
            if (nonBaseAmount > 0) {
                value += _convertToBase(nonBaseAmount, sqrtPriceX96, !baseIsToken0);
            }
        }
    }

    /// @dev Convert `amount` (in the non-base currency) to base units using
    /// `sqrtPriceX96`. `nonBaseIsToken0` indicates which side of the pool the
    /// `amount` corresponds to.
    ///
    /// Implementation note: we apply the sqrt price twice in sequence rather
    /// than squaring it first. Squaring produces a large intermediate that
    /// either truncates to zero (very low spot prices) or overflows (very
    /// high ones); the two-step form keeps every intermediate inside the
    /// safe range of `mulDiv` and never divides by zero when `sqrtPriceX96`
    /// is itself non-zero.
    function _convertToBase(uint256 amount, uint160 sqrtPriceX96, bool nonBaseIsToken0)
        internal
        pure
        returns (uint256)
    {
        if (amount == 0 || sqrtPriceX96 == 0) return 0;
        uint256 q96 = 1 << 96;
        if (nonBaseIsToken0) {
            // base value = amount * (sqrtPriceX96 / 2^96)^2
            //            = amount * sqrtPriceX96 / 2^96 * sqrtPriceX96 / 2^96
            return FullMath.mulDiv(FullMath.mulDiv(amount, sqrtPriceX96, q96), sqrtPriceX96, q96);
        } else {
            // base value = amount / (sqrtPriceX96 / 2^96)^2
            //            = amount * 2^96 / sqrtPriceX96 * 2^96 / sqrtPriceX96
            return FullMath.mulDiv(FullMath.mulDiv(amount, q96, sqrtPriceX96), q96, sqrtPriceX96);
        }
    }
}
