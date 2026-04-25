// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Guardian-managed whitelist of (Uniswap-version, pool) pairs the
/// vault is allowed to interact with.
///
/// Two kill-switch granularities are exposed:
///   - `enabled = false` (soft): the pool stays in the registry, but new
///     liquidity adds are rejected. Existing positions can still be wound
///     down by the agent because the vault routes removals against its own
///     snapshot rather than the registry. Use this to safely retire a pool.
///   - `removePool` (hard): drop the pool from the registry entirely. The
///     entry vanishes; only suitable once the vault holds no positions in
///     the pool. Operational discipline (or off-chain checks against the
///     vault's `getActivePools`) is required before this is called.
contract PoolRegistry is Ownable2Step {
    /// @dev Adapter address discriminates V3 vs V4 (and any future versions).
    /// For V3: `hooks = address(0)`, `tickSpacing` unused, `fee` is the V3
    /// fee tier.
    /// For V4: `fee + tickSpacing + hooks` come from the V4 PoolKey.
    struct Pool {
        address adapter;
        address token0;
        address token1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        // Cap on the share of vault TVL that may sit in this pool, in basis
        // points (max 10_000). Enforced at the vault layer.
        uint256 maxAllocationBps;
        bool enabled;
    }

    address public guardian;

    mapping(bytes32 => Pool) internal _pools;
    bytes32[] public poolKeys;
    mapping(bytes32 => uint256) internal _poolKeyIndex; // 1-based; 0 = absent

    event GuardianUpdated(address indexed previous, address indexed current);
    event PoolAdded(bytes32 indexed key, Pool pool);
    event PoolRemoved(bytes32 indexed key);
    event PoolMaxAllocationUpdated(bytes32 indexed key, uint256 maxAllocationBps);
    event PoolEnabledSet(bytes32 indexed key, bool enabled);

    error NotGuardian();
    error UnknownPool(bytes32 key);
    error PoolAlreadyExists(bytes32 key);
    error InvalidConfig();

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(address initialOwner, address initialGuardian) Ownable(initialOwner) {
        guardian = initialGuardian;
        emit GuardianUpdated(address(0), initialGuardian);
    }

    function setGuardian(address newGuardian) external onlyOwner {
        emit GuardianUpdated(guardian, newGuardian);
        guardian = newGuardian;
    }

    /// @notice Compute the canonical key for a pool. `token0 < token1` is
    /// enforced at registration so callers don't need to remember the
    /// ordering convention.
    function poolKey(address adapter, address token0, address token1, uint24 fee, int24 tickSpacing, address hooks)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(adapter, token0, token1, fee, tickSpacing, hooks));
    }

    function addPool(Pool calldata p) external onlyGuardian returns (bytes32 key) {
        if (p.adapter == address(0) || p.token0 == address(0) || p.token1 == address(0)) revert InvalidConfig();
        if (p.token0 >= p.token1) revert InvalidConfig();
        if (p.maxAllocationBps == 0 || p.maxAllocationBps > 10_000) revert InvalidConfig();

        key = poolKey(p.adapter, p.token0, p.token1, p.fee, p.tickSpacing, p.hooks);
        if (_poolKeyIndex[key] != 0) revert PoolAlreadyExists(key);

        _pools[key] = p;
        poolKeys.push(key);
        _poolKeyIndex[key] = poolKeys.length;

        emit PoolAdded(key, p);
    }

    function removePool(bytes32 key) external onlyGuardian {
        uint256 idx = _poolKeyIndex[key];
        if (idx == 0) revert UnknownPool(key);

        uint256 last = poolKeys.length - 1;
        if (idx - 1 != last) {
            bytes32 lastKey = poolKeys[last];
            poolKeys[idx - 1] = lastKey;
            _poolKeyIndex[lastKey] = idx;
        }
        poolKeys.pop();
        delete _poolKeyIndex[key];
        delete _pools[key];

        emit PoolRemoved(key);
    }

    function setPoolMaxAllocation(bytes32 key, uint256 maxAllocationBps) external onlyGuardian {
        if (_poolKeyIndex[key] == 0) revert UnknownPool(key);
        if (maxAllocationBps == 0 || maxAllocationBps > 10_000) revert InvalidConfig();
        _pools[key].maxAllocationBps = maxAllocationBps;
        emit PoolMaxAllocationUpdated(key, maxAllocationBps);
    }

    function setPoolEnabled(bytes32 key, bool enabled) external onlyGuardian {
        if (_poolKeyIndex[key] == 0) revert UnknownPool(key);
        _pools[key].enabled = enabled;
        emit PoolEnabledSet(key, enabled);
    }

    function getPool(bytes32 key) external view returns (Pool memory) {
        if (_poolKeyIndex[key] == 0) revert UnknownPool(key);
        return _pools[key];
    }

    /// @notice Pool exists in the registry and is enabled for new liquidity
    /// adds. The vault uses this when routing `executeAddLiquidity`.
    function isAddAllowed(bytes32 key) external view returns (bool) {
        return _poolKeyIndex[key] != 0 && _pools[key].enabled;
    }

    /// @notice Pool exists in the registry, regardless of `enabled`. The
    /// vault uses this for swaps so the agent can route through a pool that
    /// is disabled for adds while a wind-down is in progress.
    function isPoolKnown(bytes32 key) external view returns (bool) {
        return _poolKeyIndex[key] != 0;
    }

    /// @dev Backwards-compatible alias for `isAddAllowed`.
    function isWhitelisted(bytes32 key) external view returns (bool) {
        return _poolKeyIndex[key] != 0 && _pools[key].enabled;
    }

    function poolCount() external view returns (uint256) {
        return poolKeys.length;
    }
}
