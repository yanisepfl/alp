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

        // Same-block lockout means we have to advance the block before
        // redeeming from the same address that just deposited.
        vm.roll(block.number + 1);

        vm.prank(alice);
        vault.withdraw(400e6, alice, alice);

        assertEq(usdc.balanceOf(alice), 100_000e6 - 1_000e6 + 400e6);
        assertEq(vault.totalAssets(), 600e6);
    }

    function test_withdraw_sameBlockAsDeposit_reverts() public {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        vm.expectRevert(ALPVault.SameBlockMintAndRedeem.selector);
        vm.prank(alice);
        vault.withdraw(100e6, alice, alice);
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

    // -------- Dual-rail accounting --------

    function test_bookTAV_startsAtZero() public view {
        assertEq(vault.bookTAV(), 0);
    }

    function test_bookTAV_growsOnDeposit() public {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);
        assertEq(vault.bookTAV(), 1_000e6);

        vm.prank(bob);
        vault.deposit(500e6, bob);
        assertEq(vault.bookTAV(), 1_500e6);
    }

    function test_bookTAV_shrinksOnWithdraw() public {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);
        vm.roll(block.number + 1);
        vm.prank(alice);
        vault.withdraw(400e6, alice, alice);
        assertEq(vault.bookTAV(), 600e6);
    }

    function test_marketTAV_matchesIdleBaseWhenNoPositions() public {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);
        // No positions opened; market = idle base = 1_000e6.
        assertEq(vault.marketTAV(), 1_000e6);
        // book = market, so totalAssets() returns either.
        assertEq(vault.totalAssets(), 1_000e6);
    }

    function test_totalAssets_returnsMinOfBookAndMarket() public {
        // Donate 500 USDC straight into the vault — bumps market without book.
        vm.prank(alice);
        vault.deposit(1_000e6, alice);
        usdc.mint(address(vault), 500e6);

        // bookTAV stays at 1_000e6, marketTAV is 1_500e6, totalAssets returns the floor.
        assertEq(vault.bookTAV(), 1_000e6);
        assertEq(vault.marketTAV(), 1_500e6);
        assertEq(vault.totalAssets(), 1_000e6);
    }

    function test_deposit_usesMaxOfBookAndMarket() public {
        // Alice deposits, then someone donates extra USDC making market > book.
        vm.prank(alice);
        vault.deposit(1_000e6, alice);
        usdc.mint(address(vault), 500e6);

        // Bob now deposits. With market = 1_500 > book = 1_000, the share-pricing
        // rail is the higher of the two, so bob mints fewer shares than he would
        // under a book-only model.
        uint256 bobExpected = vault.previewDeposit(1_500e6);
        vm.prank(bob);
        uint256 bobShares = vault.deposit(1_500e6, bob);
        assertEq(bobShares, bobExpected);

        // The 1_500 USDC bumps both rails by the same gross amount.
        assertEq(vault.bookTAV(), 2_500e6);
        assertEq(vault.marketTAV(), 3_000e6);
        assertEq(vault.totalAssets(), 2_500e6);
    }

    function test_redeem_usesMinOfBookAndMarket() public {
        // Same setup: market > book.
        vm.prank(alice);
        vault.deposit(1_000e6, alice);
        usdc.mint(address(vault), 500e6);

        // Alice now redeems all her shares. With min(book, market) = book = 1_000,
        // she gets back her deposit but NOT the unrealised 500 donation. The
        // 500 stays in the vault for whoever exits later.
        vm.roll(block.number + 1);
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 before_ = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        uint256 received = usdc.balanceOf(alice) - before_;
        // Alice should receive at most her deposit.
        assertLe(received, 1_000e6);
        // Vault retains at least the donated 500 plus any rounding crumb.
        assertGe(usdc.balanceOf(address(vault)), 500e6);
    }

    /// @notice Simulates the "deflate spot, deposit, restore spot, redeem"
    /// multi-block flash-loan flow without any actual pool. We model
    /// market-rail manipulation as a direct USDC transfer in/out of the
    /// vault: it's the cleanest way to prove the dual-rail rule cancels
    /// the attack in isolation. (Real-pool manipulation is exercised in
    /// integration tests where the pool is live.)
    function test_dualRail_neutralisesMarketManipulation() public {
        // Honest seed: alice deposits 1_000.
        vm.prank(alice);
        vault.deposit(1_000e6, alice);
        uint256 supplyBefore = vault.totalSupply();

        // "Attacker" deflates market — pull 200 USDC out (simulating the pool
        // crashing 20%). Book stays at 1_000, market drops to 800.
        vm.prank(address(vault));
        usdc.transfer(address(0xdead), 200e6);
        assertEq(vault.bookTAV(), 1_000e6);
        assertEq(vault.marketTAV(), 800e6);

        // Bob deposits at the manipulated state. Pricing uses MAX(book, market)
        // = 1_000 (the unmanipulated rail). Bob gets the SAME shares he'd get
        // honestly — manipulation didn't help him.
        vm.prank(bob);
        uint256 bobShares = vault.deposit(500e6, bob);
        uint256 honestShares = (500e6 * (supplyBefore + 1e6)) / (1_000e6 + 1);
        assertApproxEqAbs(bobShares, honestShares, 1, "bob got more shares than honest baseline");

        // Restore the market (mint 200 back). Book is now 1_500, market 1_500.
        usdc.mint(address(vault), 200e6);

        // Bob redeems. Pricing uses MIN(book, market) = 1_500 (both equal now).
        // He gets back exactly his 500. Zero profit from the manipulation.
        vm.roll(block.number + 1);
        uint256 before_ = usdc.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob, bob);
        uint256 received = usdc.balanceOf(bob) - before_;
        assertApproxEqAbs(received, 500e6, 2, "bob extracted profit from market manipulation");
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

    function test_bootstrapAdapter_wrongNftManager_reverts() public {
        // Use an EOA-shaped adapter address that has no `nftManager()` selector
        // — calling the view should revert and we want a clear error message.
        address bogusAdapter = address(this);
        vm.prank(guardian);
        vm.expectRevert();
        vault.bootstrapAdapter(makeAddr("anyNft"), bogusAdapter);
    }

    function test_executeSwap_unknownPool_reverts() public {
        bytes32 fake = keccak256("fake");
        vm.expectRevert(abi.encodeWithSelector(ALPVault.PoolNotKnown.selector, fake));
        vm.prank(agent);
        // Pass non-zero amountOutMin so we hit the pool-known check, not the
        // SlippageMinRequired guard.
        vault.executeSwap(fake, address(usdc), 1, 1, "");
    }

    function test_executeSwap_zeroAmountOutMin_reverts() public {
        bytes32 fake = keccak256("fake");
        vm.expectRevert(ALPVault.SlippageMinRequired.selector);
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
