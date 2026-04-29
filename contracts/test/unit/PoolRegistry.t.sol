// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {PoolRegistry} from "../../src/PoolRegistry.sol";

contract PoolRegistryTest is Test {
    PoolRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");
    address internal adapterA = makeAddr("adapterA");
    address internal adapterB = makeAddr("adapterB");

    address internal token0 = makeAddr("token0");
    address internal token1 = makeAddr("token1");

    function setUp() public {
        // ensure token0 < token1 (registry enforces sorted order)
        if (uint160(token0) >= uint160(token1)) (token0, token1) = (token1, token0);
        registry = new PoolRegistry(owner, guardian);
    }

    function _samplePool() internal view returns (PoolRegistry.Pool memory) {
        return PoolRegistry.Pool({
            adapter: adapterA,
            token0: token0,
            token1: token1,
            fee: 500,
            tickSpacing: 10,
            hooks: address(0),
            maxAllocationBps: 5_000,
            enabled: true
        });
    }

    // -------- construction --------

    function test_constructor_setsOwnerAndGuardian() public view {
        assertEq(registry.owner(), owner);
        assertEq(registry.guardian(), guardian);
    }

    // -------- guardian rotation --------

    function test_setGuardian_byOwner_updatesGuardian() public {
        vm.prank(owner);
        registry.setGuardian(stranger);
        assertEq(registry.guardian(), stranger);
    }

    function test_setGuardian_byNonOwner_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        registry.setGuardian(stranger);
    }

    // -------- addPool --------

    function test_addPool_byGuardian_addsAndEmits() public {
        PoolRegistry.Pool memory p = _samplePool();
        bytes32 expected = registry.poolKey(p.adapter, p.token0, p.token1, p.fee, p.tickSpacing, p.hooks);

        vm.expectEmit(true, false, false, true);
        emit PoolRegistry.PoolAdded(expected, p);

        vm.prank(guardian);
        bytes32 key = registry.addPool(p);

        assertEq(key, expected);
        assertEq(registry.poolCount(), 1);
        assertTrue(registry.isWhitelisted(key));

        PoolRegistry.Pool memory got = registry.getPool(key);
        assertEq(got.adapter, p.adapter);
        assertEq(got.maxAllocationBps, p.maxAllocationBps);
    }

    function test_addPool_byNonGuardian_reverts() public {
        vm.expectRevert(PoolRegistry.NotGuardian.selector);
        registry.addPool(_samplePool());
    }

    function test_addPool_unsortedTokens_reverts() public {
        PoolRegistry.Pool memory p = _samplePool();
        (p.token0, p.token1) = (p.token1, p.token0);
        vm.prank(guardian);
        vm.expectRevert(PoolRegistry.InvalidConfig.selector);
        registry.addPool(p);
    }

    function test_addPool_zeroAdapter_reverts() public {
        PoolRegistry.Pool memory p = _samplePool();
        p.adapter = address(0);
        vm.prank(guardian);
        vm.expectRevert(PoolRegistry.InvalidConfig.selector);
        registry.addPool(p);
    }

    function test_addPool_zeroMaxAllocation_reverts() public {
        PoolRegistry.Pool memory p = _samplePool();
        p.maxAllocationBps = 0;
        vm.prank(guardian);
        vm.expectRevert(PoolRegistry.InvalidConfig.selector);
        registry.addPool(p);
    }

    function test_addPool_excessiveMaxAllocation_reverts() public {
        PoolRegistry.Pool memory p = _samplePool();
        p.maxAllocationBps = 10_001;
        vm.prank(guardian);
        vm.expectRevert(PoolRegistry.InvalidConfig.selector);
        registry.addPool(p);
    }

    function test_addPool_withHooks_reverts() public {
        PoolRegistry.Pool memory p = _samplePool();
        p.hooks = makeAddr("someHook");
        vm.prank(guardian);
        vm.expectRevert(PoolRegistry.HookedPoolsNotAllowed.selector);
        registry.addPool(p);
    }

    function test_addPool_withAllowlistedHook_succeeds() public {
        address hook = makeAddr("alphixHook");
        vm.prank(owner);
        registry.setHookAllowed(hook, true);

        PoolRegistry.Pool memory p = _samplePool();
        p.hooks = hook;
        vm.prank(guardian);
        bytes32 key = registry.addPool(p);
        assertEq(registry.getPool(key).hooks, hook);
    }

    function test_addPool_withRevokedHook_reverts() public {
        address hook = makeAddr("alphixHook");
        vm.startPrank(owner);
        registry.setHookAllowed(hook, true);
        registry.setHookAllowed(hook, false);
        vm.stopPrank();

        PoolRegistry.Pool memory p = _samplePool();
        p.hooks = hook;
        vm.prank(guardian);
        vm.expectRevert(PoolRegistry.HookedPoolsNotAllowed.selector);
        registry.addPool(p);
    }

    function test_setHookAllowed_byNonOwner_reverts() public {
        address hook = makeAddr("alphixHook");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.setHookAllowed(hook, true);
    }

    function test_setHookAllowed_zeroAddress_reverts() public {
        vm.prank(owner);
        vm.expectRevert(PoolRegistry.InvalidConfig.selector);
        registry.setHookAllowed(address(0), true);
    }

    function test_isHookAllowed_zeroAddressAlwaysAllowed() public view {
        assertTrue(registry.isHookAllowed(address(0)));
    }

    function test_isHookAllowed_unsetReturnsFalse() public {
        address hook = makeAddr("randomHook");
        assertFalse(registry.isHookAllowed(hook));
    }

    function test_v3WethUsdc_and_v4NativeEthUsdc_coexist() public {
        // V4 native-ETH/USDC (token0 = address(0)) and V3 WETH/USDC must be
        // independent registry entries even though they target conceptually
        // the same asset pair. Distinct adapters and a distinct token0 mean
        // distinct pool keys; both should register without conflict.
        address weth = makeAddr("weth");
        address usdc = makeAddr("usdc");
        address v3Adapter = makeAddr("v3Adapter");
        address v4Adapter = makeAddr("v4Adapter");
        address v4Hook = makeAddr("v4Hook");
        // Sort tokens for the V3 entry; token0=0 ordering is automatic for V4.
        (address t0, address t1) = uint160(weth) < uint160(usdc) ? (weth, usdc) : (usdc, weth);
        (address vUsdc) = uint160(weth) < uint160(usdc) ? usdc : weth;

        vm.prank(owner);
        registry.setHookAllowed(v4Hook, true);

        // V3 WETH/USDC 0.05%
        PoolRegistry.Pool memory v3Pool = PoolRegistry.Pool({
            adapter: v3Adapter,
            token0: t0,
            token1: t1,
            fee: 500,
            tickSpacing: 10,
            hooks: address(0),
            maxAllocationBps: 5_000,
            enabled: true
        });
        // V4 native-ETH/USDC, dynamic-fee hook
        PoolRegistry.Pool memory v4Pool = PoolRegistry.Pool({
            adapter: v4Adapter,
            token0: address(0),
            token1: vUsdc,
            fee: 0x800000,
            tickSpacing: 60,
            hooks: v4Hook,
            maxAllocationBps: 3_000,
            enabled: true
        });

        vm.startPrank(guardian);
        bytes32 v3Key = registry.addPool(v3Pool);
        bytes32 v4Key = registry.addPool(v4Pool);
        vm.stopPrank();

        // Distinct keys, both queryable, total count = 2.
        assertTrue(v3Key != v4Key, "keys must differ");
        assertEq(registry.poolCount(), 2);
        assertEq(registry.getPool(v3Key).adapter, v3Adapter);
        assertEq(registry.getPool(v4Key).adapter, v4Adapter);
        assertEq(registry.getPool(v4Key).token0, address(0));
        assertEq(registry.getPool(v4Key).fee, 0x800000);
    }

    function test_addPool_duplicate_reverts() public {
        PoolRegistry.Pool memory p = _samplePool();
        vm.startPrank(guardian);
        bytes32 key = registry.addPool(p);
        vm.expectRevert(abi.encodeWithSelector(PoolRegistry.PoolAlreadyExists.selector, key));
        registry.addPool(p);
        vm.stopPrank();
    }

    function test_addPool_differentAdapter_addsAsSecondPool() public {
        PoolRegistry.Pool memory p = _samplePool();
        vm.startPrank(guardian);
        registry.addPool(p);

        p.adapter = adapterB;
        registry.addPool(p);
        vm.stopPrank();

        assertEq(registry.poolCount(), 2);
    }

    // -------- removePool --------

    function test_removePool_byGuardian_removes() public {
        vm.startPrank(guardian);
        bytes32 key = registry.addPool(_samplePool());
        registry.removePool(key);
        vm.stopPrank();

        assertEq(registry.poolCount(), 0);
        assertFalse(registry.isWhitelisted(key));
    }

    function test_removePool_unknown_reverts() public {
        bytes32 key = bytes32(uint256(0xdead));
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(PoolRegistry.UnknownPool.selector, key));
        registry.removePool(key);
    }

    function test_removePool_swapAndPop_keepsArrayConsistent() public {
        PoolRegistry.Pool memory p = _samplePool();
        vm.startPrank(guardian);
        bytes32 key1 = registry.addPool(p);

        p.adapter = adapterB;
        bytes32 key2 = registry.addPool(p);
        vm.stopPrank();

        vm.prank(guardian);
        registry.removePool(key1);

        assertEq(registry.poolCount(), 1);
        assertEq(registry.poolKeys(0), key2);
        assertTrue(registry.isWhitelisted(key2));
    }

    // -------- setPoolEnabled --------

    function test_setPoolEnabled_disabledPoolNotWhitelisted() public {
        vm.startPrank(guardian);
        bytes32 key = registry.addPool(_samplePool());
        registry.setPoolEnabled(key, false);
        vm.stopPrank();

        assertFalse(registry.isWhitelisted(key));
        // but still retrievable
        PoolRegistry.Pool memory got = registry.getPool(key);
        assertEq(got.enabled, false);
    }

    // -------- setPoolMaxAllocation --------

    function test_setPoolMaxAllocation_updates() public {
        vm.startPrank(guardian);
        bytes32 key = registry.addPool(_samplePool());
        registry.setPoolMaxAllocation(key, 7_500);
        vm.stopPrank();

        assertEq(registry.getPool(key).maxAllocationBps, 7_500);
    }

    function test_setPoolMaxAllocation_invalid_reverts() public {
        vm.startPrank(guardian);
        bytes32 key = registry.addPool(_samplePool());
        vm.expectRevert(PoolRegistry.InvalidConfig.selector);
        registry.setPoolMaxAllocation(key, 0);
        vm.stopPrank();
    }
}
