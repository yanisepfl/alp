// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ALPVault} from "../../src/ALPVault.sol";
import {PoolRegistry} from "../../src/PoolRegistry.sol";
import {MockERC20Token} from "../mocks/MockERC20Token.sol";

contract ALPVaultUnitTest is Test {
    ALPVault internal vault;
    PoolRegistry internal registry;
    MockERC20Token internal usdc;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal agent = makeAddr("agent");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        usdc = new MockERC20Token("USD Coin", "USDC", 6);
        registry = new PoolRegistry(owner, guardian);
        vault = new ALPVault(IERC20(address(usdc)), "ALP USDC Vault", "alpUSDC", registry, owner, agent, guardian);

        usdc.mint(alice, 100_000e6);
        usdc.mint(bob, 100_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
    }

    // -------- construction --------

    function test_constructor_setsAllRoles() public view {
        assertEq(vault.owner(), owner);
        assertEq(vault.agent(), agent);
        assertEq(vault.guardian(), guardian);
        assertEq(vault.asset(), address(usdc));
        assertEq(address(vault.registry()), address(registry));
        assertEq(vault.name(), "ALP USDC Vault");
        assertEq(vault.symbol(), "alpUSDC");
    }

    // -------- role rotation --------

    function test_setAgent_byOwner_works() public {
        vm.prank(owner);
        vault.setAgent(bob);
        assertEq(vault.agent(), bob);
    }

    function test_setAgent_byStranger_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.setAgent(bob);
    }

    function test_setGuardian_byOwner_works() public {
        vm.prank(owner);
        vault.setGuardian(bob);
        assertEq(vault.guardian(), bob);
    }

    function test_setGuardian_byStranger_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.setGuardian(bob);
    }

    // -------- pausing --------

    function test_pause_byGuardian_pauses() public {
        vm.prank(guardian);
        vault.pause();
        assertTrue(vault.paused());
    }

    function test_pause_byNonGuardian_reverts() public {
        vm.expectRevert(ALPVault.NotGuardian.selector);
        vault.pause();
    }

    function test_unpause_byGuardian_unpauses() public {
        vm.startPrank(guardian);
        vault.pause();
        vault.unpause();
        vm.stopPrank();
        assertFalse(vault.paused());
    }

    // -------- deposit / withdraw --------

    function test_deposit_firstDeposit_mintsExpectedShares() public {
        // ERC4626 with a 6-dp virtual offset: first deposit of N base-asset
        // units mints N * 10**offset shares. We assert symbolically via
        // previewDeposit so future offset tweaks don't cascade into test
        // breakage.
        uint256 expected = vault.previewDeposit(1_000e6);
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000e6, alice);
        assertEq(shares, expected);
        assertEq(vault.balanceOf(alice), expected);
        assertEq(vault.totalAssets(), 1_000e6);
    }

    function test_deposit_paused_reverts() public {
        vm.prank(guardian);
        vault.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(alice);
        vault.deposit(100e6, alice);
    }

    function test_withdraw_returnsAssets() public {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        vm.prank(alice);
        vault.withdraw(400e6, alice, alice);

        assertEq(usdc.balanceOf(alice), 100_000e6 - 1_000e6 + 400e6);
        assertEq(vault.totalAssets(), 600e6);
    }

    function test_withdraw_paused_reverts() public {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        vm.prank(guardian);
        vault.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(alice);
        vault.withdraw(100e6, alice, alice);
    }

    // -------- valuation --------

    /// @dev With no open positions and no idle non-base, totalAssets is just
    /// the idle base balance. The full on-chain valuation path that includes
    /// open positions and non-base balances is exercised in the V3 fork and
    /// V4 local integration suites.
    function test_totalAssets_idleOnly_matchesBaseBalance() public {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);
        assertEq(vault.totalAssets(), 1_000e6);

        vm.prank(bob);
        vault.deposit(500e6, bob);
        assertEq(vault.totalAssets(), 1_500e6);
    }

    function test_sharePrice_proportional_whenNoPositionsExist() public {
        vm.prank(alice);
        uint256 sharesA = vault.deposit(1_000e6, alice);

        vm.prank(bob);
        uint256 sharesB = vault.deposit(2_000e6, bob);

        // Bob's shares should be exactly 2x Alice's (deposit ratio matches share
        // ratio when totalAssets only reflects idle balance).
        assertEq(sharesB, sharesA * 2);
        assertEq(vault.totalAssets(), 3_000e6);
    }

    // -------- agent entry-point gating --------

    function test_executeAddLiquidity_byNonAgent_reverts() public {
        vm.expectRevert(ALPVault.NotAgent.selector);
        vault.executeAddLiquidity(bytes32(0), 0, 0, 0, 0, "");
    }

    function test_executeRemoveLiquidity_byNonAgent_reverts() public {
        vm.expectRevert(ALPVault.NotAgent.selector);
        vault.executeRemoveLiquidity(bytes32(0), 0, 0, 0, 0, "");
    }

    function test_executeCollectFees_byNonAgent_reverts() public {
        vm.expectRevert(ALPVault.NotAgent.selector);
        vault.executeCollectFees(bytes32(0), 0);
    }

    function test_executeSwap_byNonAgent_reverts() public {
        vm.expectRevert(ALPVault.NotAgent.selector);
        vault.executeSwap(bytes32(0), address(0), 0, 0, "");
    }

    function test_executeAddLiquidity_unwhitelistedPool_reverts() public {
        bytes32 fake = keccak256("fake");
        vm.expectRevert(abi.encodeWithSelector(ALPVault.PoolNotAddAllowed.selector, fake));
        vm.prank(agent);
        vault.executeAddLiquidity(fake, 0, 0, 0, 0, "");
    }

    function test_executeRemoveLiquidity_untrackedPool_reverts() public {
        bytes32 fake = keccak256("fake");
        vm.expectRevert(abi.encodeWithSelector(ALPVault.PoolNotTracked.selector, fake));
        vm.prank(agent);
        vault.executeRemoveLiquidity(fake, 0, 0, 0, 0, "");
    }

    function test_executeSwap_unknownPool_reverts() public {
        bytes32 fake = keccak256("fake");
        vm.expectRevert(abi.encodeWithSelector(ALPVault.PoolNotKnown.selector, fake));
        vm.prank(agent);
        vault.executeSwap(fake, address(usdc), 1, 0, "");
    }

    function test_executeAddLiquidity_paused_reverts() public {
        vm.prank(guardian);
        vault.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(agent);
        vault.executeAddLiquidity(bytes32(0), 0, 0, 0, 0, "");
    }

    // -------- bootstrapAdapter --------

    function test_bootstrapAdapter_byNonGuardian_reverts() public {
        vm.expectRevert(ALPVault.NotGuardian.selector);
        vault.bootstrapAdapter(makeAddr("nft"), makeAddr("adapter"));
    }
}
