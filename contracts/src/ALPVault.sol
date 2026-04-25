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

    event AgentUpdated(address indexed previous, address indexed current);
    event GuardianUpdated(address indexed previous, address indexed current);
    event AdapterBootstrapped(address indexed nftManager, address indexed adapter);
    event AdapterRevoked(address indexed nftManager, address indexed adapter);
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
    error CannotSweepProtectedToken(address token);
    error SlippageMinRequired();
    error SwapNotionalCapExceeded(uint256 amountIn, uint256 cap);
    error InsufficientLiquidityAfterUnwind(uint256 needed, uint256 available);
    error SameBlockMintAndRedeem();
    error InvalidFeeBps(uint256 bps);

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
        for (uint256 i; i < numPools; ++i) {
            PoolRegistry.Pool memory p = registry.getPool(registry.poolKeys(i));
            if (p.token0 == token || p.token1 == token) revert CannotSweepProtectedToken(token);
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
    function totalAssets() public view override returns (uint256 total) {
        address base = asset();
        total = IERC20(base).balanceOf(address(this));

        uint256 numPools = _activePoolKeys.length;
        for (uint256 i; i < numPools; ++i) {
            // Skip pools the guardian has marked orphaned. They contribute
            // zero to TAV until manually rehabilitated.
            bytes32 key = _activePoolKeys[i];
            if (_orphanedPool[key]) continue;
            // A misbehaving non-base token, broken adapter, or pre-init pool
            // would otherwise brick deposits/redemptions. Skip and continue;
            // the guardian can `forceUntrackPool` to surface and fix the
            // root cause if needed.
            try this.poolValueExternal(key) returns (uint256 v) {
                total += v;
            } catch {
                // intentionally swallowed — see comment above
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
    /// pool's own spot.
    function _poolValueWithIdle(bytes32 key) internal view returns (uint256 value) {
        PoolRegistry.Pool memory pool = _trackedPools[key];
        if (pool.adapter == address(0)) return 0;
        ILiquidityAdapter adapter_ = ILiquidityAdapter(pool.adapter);
        address base = asset();
        bool baseIsToken0 = (pool.token0 == base);
        address nonBase = baseIsToken0 ? pool.token1 : pool.token0;

        uint160 sqrtPriceX96 = adapter_.getSpotSqrtPriceX96(pool);

        if (!_alreadyCounted(nonBase, base, _activePoolKeyIndex[key] - 1)) {
            uint256 idleNonBase = IERC20(nonBase).balanceOf(address(this));
            if (idleNonBase > 0) {
                value += _convertToBase(idleNonBase, sqrtPriceX96, !baseIsToken0);
            }
        }

        uint256[] storage ids = _positionIdsByPool[key];
        uint256 numPositions = ids.length;
        for (uint256 j; j < numPositions; ++j) {
            (uint256 amount0, uint256 amount1) = adapter_.getPositionAmounts(pool, ids[j]);
            uint256 baseAmount = baseIsToken0 ? amount0 : amount1;
            uint256 nonBaseAmount = baseIsToken0 ? amount1 : amount0;
            value += baseAmount;
            if (nonBaseAmount > 0) {
                value += _convertToBase(nonBaseAmount, sqrtPriceX96, !baseIsToken0);
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
        // that read or steer the vault's state mid-transaction. We block
        // hooked pools entirely until each hook is reviewed and explicitly
        // allowlisted; V3 always passes (`hooks == address(0)`).
        if (pool.hooks != address(0)) revert HookedPoolsNotAllowed(poolKey);

        _trackPoolIfNew(poolKey, pool);

        IERC20(pool.token0).forceApprove(pool.adapter, amount0Desired);
        IERC20(pool.token1).forceApprove(pool.adapter, amount1Desired);

        (positionId, liquidity, amount0Used, amount1Used) = ILiquidityAdapter(pool.adapter)
            .addLiquidity(pool, amount0Desired, amount1Desired, amount0Min, amount1Min, extra);

        IERC20(pool.token0).forceApprove(pool.adapter, 0);
        IERC20(pool.token1).forceApprove(pool.adapter, 0);

        _trackPositionIfNew(poolKey, positionId);

        // Per-pool max allocation cap, enforced after the position is added so
        // we measure against the post-trade allocation.
        uint256 totalNow = totalAssets();
        if (totalNow > 0) {
            uint256 poolValue = _poolValue(poolKey);
            if (poolValue * 10_000 > pool.maxAllocationBps * totalNow) {
                revert MaxAllocationExceeded(poolKey);
            }
        }

        emit LiquidityAdded(poolKey, positionId, amount0Used, amount1Used);
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
        // Hooked V4 pools are blocked here as well as on the add path,
        // because a hook can fire callbacks during the V4 swap router's
        // unlock/settle cycle and reach back into the vault's read path.
        if (pool.hooks != address(0)) revert HookedPoolsNotAllowed(poolKey);

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

        IERC20(tokenIn).forceApprove(pool.adapter, amountIn);
        amountOut = ILiquidityAdapter(pool.adapter).swapExactIn(pool, tokenIn, amountIn, amountOutMin, extra);
        IERC20(tokenIn).forceApprove(pool.adapter, 0);

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
        bytes memory extra = abi.encode(deadline, true);

        for (uint256 i; i < ids.length; ++i) {
            uint128 liquidity = adapter_.getPositionLiquidity(pool, ids[i]);
            // A zero reading can mean the position was already burned OR
            // that the adapter view itself reverted and was caught upstream.
            // Skip the position without untracking; a real burn will surface
            // via the next `executeRemoveLiquidity` and untrack cleanly.
            if (liquidity == 0) continue;
            (uint256 amount0Out, uint256 amount1Out, bool burned) =
                adapter_.removeLiquidity(pool, ids[i], liquidity, 0, 0, extra);
            if (burned) {
                _untrackPosition(poolKey, ids[i]);
            }
            emit LiquidityRemoved(poolKey, ids[i], amount0Out, amount1Out);
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

    // -------- ERC721 receiver --------

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // -------- Pause + reentrancy hooks + anti-MEV layer --------

    /// @dev Apply the entry/exit fee at the share-pricing layer so it
    /// influences both `previewDeposit` quotes and the actual mint amount
    /// consistently. Fee bps haircut on incoming asset value: shares minted
    /// reflect (assets - fee). The fee stays in the vault as donated TAV.
    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {
        uint256 fee = (assets * entryExitFeeBps) / BPS_DENOM;
        return super._convertToShares(assets - fee, rounding);
    }

    /// @dev Symmetric fee on the redeem path: shares burnt return
    /// `assets * (1 - fee)` to the user; the haircut stays as TAV.
    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {
        uint256 grossAssets = super._convertToAssets(shares, rounding);
        uint256 fee = (grossAssets * entryExitFeeBps) / BPS_DENOM;
        return grossAssets - fee;
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
        nonReentrant
    {
        super._deposit(caller, receiver, assets, shares);
        // Same-block lockout: stamp the receiver's last-mint block so a
        // subsequent same-block redeem from the same address reverts.
        // This kills the canonical mint-and-redeem-in-one-transaction
        // flash-loan flow at near-zero cost to honest users.
        _lastMintBlock[receiver] = block.number;
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
        nonReentrant
    {
        if (_lastMintBlock[owner_] == block.number) revert SameBlockMintAndRedeem();
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
        super._withdraw(caller, receiver, owner_, assets, shares);
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
        uint256 tav = totalAssets();
        if (tav == 0) return;
        uint256 numPools = _activePoolKeys.length;
        bytes memory removeExtra = abi.encode(block.timestamp, false);
        bytes memory swapExtra = abi.encode(block.timestamp);
        for (uint256 i; i < numPools && IERC20(asset()).balanceOf(address(this)) < shortfall + 1; ++i) {
            bytes32 key = _activePoolKeys[i];
            if (_orphanedPool[key]) continue;
            PoolRegistry.Pool memory pool = _trackedPools[key];
            ILiquidityAdapter adapter_ = ILiquidityAdapter(pool.adapter);
            uint256[] storage ids = _positionIdsByPool[key];
            for (uint256 j; j < ids.length; ++j) {
                uint128 currentLiq = adapter_.getPositionLiquidity(pool, ids[j]);
                if (currentLiq == 0) continue;
                uint128 toPeel = uint128((uint256(currentLiq) * shortfall) / tav);
                if (toPeel == 0) toPeel = 1; // round up so dust positions still contribute
                if (toPeel > currentLiq) toPeel = currentLiq;

                IERC20(pool.token0).forceApprove(pool.adapter, 0); // belt-and-braces
                IERC20(pool.token1).forceApprove(pool.adapter, 0);
                (,, bool burned) = adapter_.removeLiquidity(pool, ids[j], toPeel, 0, 0, removeExtra);
                if (burned) {
                    _untrackPosition(key, ids[j]);
                }
            }

            // Convert non-base side back to base in this pool so the withdraw
            // can settle in the vault's asset.
            address nonBase = (pool.token0 == asset()) ? pool.token1 : pool.token0;
            uint256 nonBaseBal = IERC20(nonBase).balanceOf(address(this));
            if (nonBaseBal > 0) {
                IERC20(nonBase).forceApprove(pool.adapter, nonBaseBal);
                adapter_.swapExactIn(pool, nonBase, nonBaseBal, 1, swapExtra);
                IERC20(nonBase).forceApprove(pool.adapter, 0);
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
        emit PoolTracked(key, pool.token0 == base ? pool.token1 : pool.token0);
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

    /// @dev Cheap O(i) check to avoid double-counting an idle non-base
    /// balance through multiple pools that share the same non-base token.
    function _alreadyCounted(address nonBase, address base, uint256 currentIndex) internal view returns (bool) {
        for (uint256 k; k < currentIndex; ++k) {
            PoolRegistry.Pool memory p = _trackedPools[_activePoolKeys[k]];
            address other = (p.token0 == base) ? p.token1 : p.token0;
            if (other == nonBase) return true;
        }
        return false;
    }

    /// @dev Value held in `key` (positions only, not idle non-base), used to
    /// enforce per-pool max allocation caps. Idle non-base is excluded so the
    /// cap measures committed liquidity rather than transient balances mid-
    /// rebalance.
    function _poolValue(bytes32 key) internal view returns (uint256 value) {
        PoolRegistry.Pool memory pool = _trackedPools[key];
        if (pool.adapter == address(0)) return 0;
        ILiquidityAdapter adapter_ = ILiquidityAdapter(pool.adapter);
        bool baseIsToken0 = (pool.token0 == asset());
        uint160 sqrtPriceX96 = adapter_.getSpotSqrtPriceX96(pool);

        uint256[] storage ids = _positionIdsByPool[key];
        for (uint256 j; j < ids.length; ++j) {
            (uint256 amount0, uint256 amount1) = adapter_.getPositionAmounts(pool, ids[j]);
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
