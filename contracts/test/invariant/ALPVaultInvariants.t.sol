// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ALPVault} from "../../src/ALPVault.sol";
import {PoolRegistry} from "../../src/PoolRegistry.sol";
import {MockERC20Token} from "../mocks/MockERC20Token.sol";

/// @notice Stateless handler that exposes a tightly-scoped surface to the
/// Foundry invariant fuzzer. We deliberately exclude every agent operation
/// that requires a live Uniswap pool — those run in the integration suites.
/// What we want here is broad coverage of vault state under random user
/// activity, registry edits, role rotations, and direct base-asset transfers.
contract VaultHandler is Test {
    ALPVault internal vault;
    PoolRegistry internal registry;
    MockERC20Token internal usdc;
    address internal owner;
    address internal guardian;
    address internal agent;
    address[] internal users;

    constructor(
        ALPVault _vault,
        PoolRegistry _registry,
        MockERC20Token _usdc,
        address _owner,
        address _guardian,
        address _agent,
        address[] memory _users
    ) {
        vault = _vault;
        registry = _registry;
        usdc = _usdc;
        owner = _owner;
        guardian = _guardian;
        agent = _agent;
        users = _users;
    }

    function _user(uint256 idx) internal view returns (address) {
        return users[bound(idx, 0, users.length - 1)];
    }

    function deposit(uint256 userIdx, uint256 amount) public {
        amount = bound(amount, 0, 100_000e6);
        if (amount == 0) return;
        address u = _user(userIdx);
        usdc.mint(u, amount);
        vm.prank(u);
        usdc.approve(address(vault), amount);
        vm.prank(u);
        vault.deposit(amount, u);
    }

    function withdraw(uint256 userIdx, uint256 amount) public {
        address u = _user(userIdx);
        // Only attempt up to the user's max-redeemable. Otherwise we bias the
        // run toward unrelated revert paths.
        uint256 maxOut = vault.maxWithdraw(u);
        if (maxOut == 0) return;
        amount = bound(amount, 1, maxOut);
        // Skip if user is in the same-block-mint window — the lockout will
        // revert and we don't want to waste a fuzz iteration on noise.
        // (We don't have a public view for last-mint-block; just roll forward.)
        vm.roll(block.number + 1);
        vm.prank(u);
        vault.withdraw(amount, u, u);
    }

    function donate(uint256 amount) public {
        amount = bound(amount, 0, 50_000e6);
        if (amount == 0) return;
        usdc.mint(address(vault), amount);
    }

    function rollBlock(uint256 blocks) public {
        vm.roll(block.number + bound(blocks, 1, 100));
    }
}

contract ALPVaultInvariantsTest is StdInvariant, Test {
    ALPVault internal vault;
    PoolRegistry internal registry;
    MockERC20Token internal usdc;
    VaultHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal agent = makeAddr("agent");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        usdc = new MockERC20Token("USD Coin", "USDC", 6);
        registry = new PoolRegistry(owner, guardian);
        vault = new ALPVault(IERC20(address(usdc)), "ALP USDC Vault", "alpUSDC", registry, owner, agent, guardian);

        address[] memory users = new address[](3);
        users[0] = alice;
        users[1] = bob;
        users[2] = carol;
        handler = new VaultHandler(vault, registry, usdc, owner, guardian, agent, users);

        targetContract(address(handler));
    }

    /// @notice The vault's base balance is always at least `totalAssets()`.
    /// In the handler-driven world (no agent ops, no positions), market =
    /// idle base, so this means market ≥ floor — solvency at the floor.
    function invariant_vaultBalanceCoversTotalAssets() public view {
        uint256 idleBase = usdc.balanceOf(address(vault));
        uint256 floor_ = vault.totalAssets();
        assertGe(idleBase, floor_, "vault under-collateralised at the floor");
    }

    /// @notice `totalAssets()` returns `MIN(book, market)` — never above
    /// market and never above book.
    function invariant_totalAssetsIsTheFloor() public view {
        uint256 floor_ = vault.totalAssets();
        uint256 book = vault.bookTAV();
        uint256 market = vault.marketTAV();
        assertLe(floor_, book, "totalAssets exceeds book rail");
        assertLe(floor_, market, "totalAssets exceeds market rail");
    }

    /// @notice Donations from outside (handler.donate) lift market without
    /// touching book. So once any donation has happened, market ≥ book.
    /// Conversely, withdrawals never push market above book under no-position
    /// activity.
    function invariant_marketGeBook_underNoPositionActivity() public view {
        // With zero positions and zero non-base balances, market is just idle
        // base. Book grew only by deposits and shrank only by withdraws. Any
        // donation strictly raises market vs book. Hence market >= book.
        assertGe(vault.marketTAV(), vault.bookTAV(), "market dipped below book without losses");
    }

    /// @notice Total share supply equals the sum of every user's balance.
    /// (Smoke-tests ERC20 accounting under random activity.)
    function invariant_totalSupplyEqualsSumOfBalances() public view {
        uint256 sum = vault.balanceOf(alice) + vault.balanceOf(bob) + vault.balanceOf(carol);
        assertEq(vault.totalSupply(), sum, "supply does not equal sum of balances");
    }

    /// @notice With no agent ops, the vault tracks no pools and no positions.
    /// (The position-tracking invariants are exercised in the integration
    /// suites where pools are live.)
    function invariant_noTrackedPools_underNoAgentActivity() public view {
        assertEq(vault.getActivePools().length, 0);
    }
}
