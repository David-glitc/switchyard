// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwitchyardRouter} from "../src/SwitchyardRouter.sol";
import {IBotV3Router} from "../src/interfaces/IBotV3Router.sol";

contract Token is ERC20 {constructor(string memory s) ERC20(s,s){} function mint(address a,uint256 n) external {_mint(a,n);}}
contract WrappedBOT is Token {
    constructor() Token("WBOT"){}
    function deposit() external payable {_mint(msg.sender,msg.value);}
    function withdraw(uint256 n) external {_burn(msg.sender,n);(bool ok,)=msg.sender.call{value:n}("");require(ok);}
}
/// @dev Fixed 2:1 price, pays from its own inventory, enforces the deadline and minimum like BDEX.
contract FixedRouter is IBotV3Router {
    uint256 public lastFee;
    function exactInputSingle(Params calldata p) external payable returns(uint256 out){
        require(block.timestamp<=p.deadline,"Transaction too old");lastFee=p.fee;
        IERC20(p.tokenIn).transferFrom(msg.sender,address(this),p.amountIn);out=p.amountIn*2;
        require(out>=p.amountOutMinimum,"Too little received");IERC20(p.tokenOut).transfer(p.recipient,out);
    }
}

contract SwitchyardTest is Test {
    address alice=address(0xA11CE);address fees=address(0xFEE);
    Token usdt;WrappedBOT wbot;FixedRouter dex;SwitchyardRouter hood;
    function setUp() public {
        usdt=new Token("USDT");wbot=new WrappedBOT();dex=new FixedRouter();
        hood=new SwitchyardRouter(address(dex),address(wbot),fees,50);
        usdt.mint(address(dex),1e30);vm.deal(address(this),1e30);wbot.deposit{value:1e24}();wbot.transfer(address(dex),1e24);
        vm.deal(alice,100 ether);usdt.mint(alice,1000e6);
    }
    function test_nativeInTakesFeeInWbotAndPaysRecipient() public {
        vm.expectEmit(address(hood));emit SwitchyardRouter.Swapped(alice,address(0),address(usdt),1 ether,0.005 ether,0.995 ether*2,alice);
        vm.prank(alice);uint256 out=hood.swapExactBOT{value:1 ether}(address(usdt),3000,1,alice,block.timestamp);
        assertEq(wbot.balanceOf(fees),0.005 ether);assertEq(out,0.995 ether*2);assertEq(usdt.balanceOf(alice),1000e6+out);
        assertEq(dex.lastFee(),3000);_assertEmpty();
    }
    function test_tokenToNativeUnwrapsToRecipient() public {
        vm.startPrank(alice);usdt.approve(address(hood),100e6);
        vm.expectEmit(address(hood));emit SwitchyardRouter.Swapped(alice,address(usdt),address(0),100e6,0.5e6,99.5e6*2,alice);
        uint256 before=alice.balance;uint256 out=hood.swapExactTokensForBOT(address(usdt),3000,100e6,1,payable(alice),block.timestamp);vm.stopPrank();
        assertEq(usdt.balanceOf(fees),0.5e6);assertEq(alice.balance-before,out);assertEq(out,99.5e6*2);_assertEmpty();
    }
    function test_tokenToToken() public {
        vm.startPrank(alice);usdt.approve(address(hood),10e6);hood.swapExactTokens(address(usdt),address(wbot),3000,10e6,1,alice,block.timestamp);vm.stopPrank();
        assertEq(wbot.balanceOf(alice),9.95e6*2);_assertEmpty();
    }
    function test_rejectsMissingMinimumExpiredDeadlineAndSameToken() public {
        vm.startPrank(alice);usdt.approve(address(hood),type(uint256).max);
        vm.expectRevert(bytes("set minimum output"));hood.swapExactTokens(address(usdt),address(wbot),3000,1e6,0,alice,block.timestamp);
        vm.expectRevert(bytes("expired"));hood.swapExactTokens(address(usdt),address(wbot),3000,1e6,1,alice,block.timestamp-1);
        vm.expectRevert(bytes("invalid route"));hood.swapExactTokens(address(usdt),address(usdt),3000,1e6,1,alice,block.timestamp);
        vm.expectRevert(bytes("Too little received"));hood.swapExactTokens(address(usdt),address(wbot),3000,1e6,1e30,alice,block.timestamp);
        vm.expectRevert(bytes("no BOT"));hood.swapExactBOT(address(usdt),3000,1,alice,block.timestamp);
        vm.stopPrank();
    }
    function test_feeCapOwnershipAndDirectBOTRejected() public {
        vm.expectRevert(bytes("invalid fee"));hood.setFeeConfig(fees,501);
        vm.prank(alice);vm.expectRevert(bytes("not owner"));hood.setFeeConfig(alice,0);
        hood.setFeeConfig(fees,0);vm.prank(alice);uint256 out=hood.swapExactBOT{value:1 ether}(address(usdt),3000,1,alice,block.timestamp);assertEq(out,2 ether);
        hood.transferOwnership(alice);vm.expectRevert(bytes("not owner"));hood.setFeeConfig(fees,10);
        vm.prank(alice);(bool ok,)=address(hood).call{value:1}("");assertFalse(ok);
        vm.expectRevert(bytes("invalid fee"));new SwitchyardRouter(address(dex),address(wbot),fees,501);
    }
    function _assertEmpty() private view {
        assertEq(usdt.balanceOf(address(hood)),0);assertEq(wbot.balanceOf(address(hood)),0);assertEq(address(hood).balance,0);
        assertEq(usdt.allowance(address(hood),address(dex)),0);assertEq(wbot.allowance(address(hood),address(dex)),0);
    }
}
