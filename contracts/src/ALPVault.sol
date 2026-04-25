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

    PoolRegistry public immutable registry;

    address public agent;
    address public guardian;

    /// @dev Snapshot of pool data captured the first time the vault interacts
    /// with a pool, so removeLiquidity / valuation continue to work even if
    /// the pool is later dropped from the registry.
    mapping(bytes32 => PoolRegistry.Pool) internal _trackedPools;
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
    event PoolTracked(bytes32 indexed poolKey, address indexed nonBaseToken);
    event PoolUntracked(bytes32 indexed poolKey);
    event PositionTracked(bytes32 indexed poolKey, uint256 indexed positionId);
    event PositionUntracked(bytes32 indexed poolKey, uint256 indexed positionId);
    event LiquidityAdded(bytes32 indexed poolKey, uint256 positionId, uint256 amount0Used, uint256 amount1Used);
    event LiquidityRemoved(bytes32 indexed poolKey, uint256 positionId, uint256 amount0Out, uint256 amount1Out);
    event FeesCollected(bytes32 indexed poolKey, uint256 positionId, uint256 amount0, uint256 amount1);
    event Swapped(bytes32 indexed poolKey, address indexed tokenIn, uint256 amountIn, uint256 amountOut);

    error NotAgent();
    error NotGuardian();
    error PoolNotAddAllowed(bytes32 key);
    error PoolNotKnown(bytes32 key);
    error PoolNotTracked(bytes32 key);
    error BaseAssetNotInPool(bytes32 key);
    error MaxAllocationExceeded(bytes32 key);

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

    function pause() external onlyGuardian {
        _pause();
    }

    function unpause() external onlyGuardian {
        _unpause();
    }

    /// @notice Authorise `adapter` to operate the vault's LP NFTs held in
    /// `nftManager` (V3 NonfungiblePositionManager or V4 PositionManager).
    /// Required before the agent can call removeLiquidity or collectFees.
    function bootstrapAdapter(address nftManager, address adapter) external onlyGuardian {
        IERC721(nftManager).setApprovalForAll(adapter, true);
        emit AdapterBootstrapped(nftManager, adapter);
    }

    /// @notice Symmetric off-switch for `bootstrapAdapter`.
    function revokeAdapter(address nftManager, address adapter) external onlyGuardian {
        IERC721(nftManager).setApprovalForAll(adapter, false);
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
            bytes32 key = _activePoolKeys[i];
            PoolRegistry.Pool memory pool = _trackedPools[key];
            ILiquidityAdapter adapter_ = ILiquidityAdapter(pool.adapter);

            bool baseIsToken0 = (pool.token0 == base);
            address nonBase = baseIsToken0 ? pool.token1 : pool.token0;

            uint160 sqrtPriceX96 = adapter_.getSpotSqrtPriceX96(pool);

            // Idle non-base balance held by the vault, valued through this
            // pool's spot. We attribute it to the first active pool that
            // contains it; later pools containing the same non-base would
            // double-count, which is why each non-base balance is added
            // only once (we skip if already credited in this iteration).
            if (!_alreadyCounted(nonBase, base, i)) {
                uint256 idleNonBase = IERC20(nonBase).balanceOf(address(this));
                if (idleNonBase > 0) {
                    total += _convertToBase(idleNonBase, sqrtPriceX96, !baseIsToken0);
                }
            }

            uint256[] storage ids = _positionIdsByPool[key];
            uint256 numPositions = ids.length;
            for (uint256 j; j < numPositions; ++j) {
                (uint256 amount0, uint256 amount1) = adapter_.getPositionAmounts(pool, ids[j]);
                uint256 baseAmount = baseIsToken0 ? amount0 : amount1;
                uint256 nonBaseAmount = baseIsToken0 ? amount1 : amount0;
                total += baseAmount;
                if (nonBaseAmount > 0) {
                    total += _convertToBase(nonBaseAmount, sqrtPriceX96, !baseIsToken0);
                }
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
        if (!registry.isPoolKnown(poolKey)) revert PoolNotKnown(poolKey);
        PoolRegistry.Pool memory pool = registry.getPool(poolKey);

        IERC20(tokenIn).forceApprove(pool.adapter, amountIn);
        amountOut = ILiquidityAdapter(pool.adapter).swapExactIn(pool, tokenIn, amountIn, amountOutMin, extra);
        IERC20(tokenIn).forceApprove(pool.adapter, 0);

        emit Swapped(poolKey, tokenIn, amountIn, amountOut);
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

    // -------- Pause + reentrancy hooks --------

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
        nonReentrant
    {
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
        nonReentrant
    {
        super._withdraw(caller, receiver, owner_, assets, shares);
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

    /// @dev Value held in `key` (positions + idle non-base attributed to that
    /// pool, but not double-counted across pools), used to enforce
    /// per-pool max allocation caps.
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
    function _convertToBase(uint256 amount, uint160 sqrtPriceX96, bool nonBaseIsToken0)
        internal
        pure
        returns (uint256)
    {
        if (amount == 0 || sqrtPriceX96 == 0) return 0;
        uint256 priceX96 = FullMath.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), 1 << 96);
        if (nonBaseIsToken0) {
            // amount is token0; base is token1; price token0/token1 = priceX96 / 2^96
            return FullMath.mulDiv(amount, priceX96, 1 << 96);
        } else {
            // amount is token1; base is token0; price token1/token0 = 2^96 / priceX96
            return FullMath.mulDiv(amount, 1 << 96, priceX96);
        }
    }
}
