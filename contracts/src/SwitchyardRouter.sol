// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBotV3Router} from "./interfaces/IBotV3Router.sol";

interface IWBOT {function deposit() external payable; function withdraw(uint256) external;}

/// @notice Switchyard's fee router ported to BDEX on BOT Chain. Takes a capped input fee, then swaps through one V3 pool.
/// @dev Holds no user balances between calls. Native BOT legs are wrapped and unwrapped here, so no router multicall is needed.
contract SwitchyardRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint16 public constant MAX_FEE_BPS = 500;
    address public immutable router;
    address public immutable wbot;
    address public owner;
    address public feeRecipient;
    uint16 public feeBps;
    /// @dev tokenIn/tokenOut are address(0) for native BOT legs; recipient is the final receiver.
    event Swapped(address indexed sender,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 fee,uint256 amountOut,address recipient);
    event FeeConfigUpdated(address recipient,uint16 feeBps);
    event OwnershipTransferred(address indexed previousOwner,address indexed newOwner);
    modifier onlyOwner(){require(msg.sender==owner,"not owner");_;}
    constructor(address router_,address wbot_,address feeRecipient_,uint16 feeBps_){
        require(router_.code.length>0&&wbot_.code.length>0,"missing infrastructure");
        require(feeRecipient_!=address(0)&&feeBps_<=MAX_FEE_BPS,"invalid fee");
        router=router_;wbot=wbot_;owner=msg.sender;feeRecipient=feeRecipient_;feeBps=feeBps_;
    }
    /// @dev Only WBOT unwraps may send native BOT here; stray deposits would otherwise be stuck.
    receive() external payable {require(msg.sender==wbot,"direct BOT");}
    function setFeeConfig(address recipient,uint16 bps) external onlyOwner {
        require(recipient!=address(0)&&bps<=MAX_FEE_BPS,"invalid fee");feeRecipient=recipient;feeBps=bps;emit FeeConfigUpdated(recipient,bps);
    }
    function transferOwnership(address next) external onlyOwner {require(next!=address(0),"zero owner");emit OwnershipTransferred(owner,next);owner=next;}
    function quoteFee(uint256 amountIn) public view returns(uint256 fee,uint256 swapAmount){fee=amountIn*feeBps/10_000;swapAmount=amountIn-fee;}

    /// @notice ERC-20 to ERC-20, including WBOT.
    function swapExactTokens(address tokenIn,address tokenOut,uint24 poolFee,uint256 amountIn,uint256 minOut,address recipient,uint256 deadline) external nonReentrant returns(uint256 amountOut){
        uint256 received=_pull(tokenIn,amountIn);
        uint256 fee;(fee,amountOut)=_swap(tokenIn,tokenOut,poolFee,received,minOut,recipient,deadline);
        emit Swapped(msg.sender,tokenIn,tokenOut,received,fee,amountOut,recipient);
    }
    /// @notice Native BOT in. The fee is taken in WBOT after wrapping.
    function swapExactBOT(address tokenOut,uint24 poolFee,uint256 minOut,address recipient,uint256 deadline) external payable nonReentrant returns(uint256 amountOut){
        require(msg.value>0,"no BOT");IWBOT(wbot).deposit{value:msg.value}();
        uint256 fee;(fee,amountOut)=_swap(wbot,tokenOut,poolFee,msg.value,minOut,recipient,deadline);
        emit Swapped(msg.sender,address(0),tokenOut,msg.value,fee,amountOut,recipient);
    }
    /// @notice ERC-20 in, native BOT out.
    function swapExactTokensForBOT(address tokenIn,uint24 poolFee,uint256 amountIn,uint256 minOut,address payable recipient,uint256 deadline) external nonReentrant returns(uint256 amountOut){
        uint256 received=_pull(tokenIn,amountIn);
        require(recipient!=address(0),"invalid route");uint256 fee;(fee,amountOut)=_swap(tokenIn,wbot,poolFee,received,minOut,address(this),deadline);
        IWBOT(wbot).withdraw(amountOut);
        (bool ok,)=recipient.call{value:amountOut}("");require(ok,"BOT transfer failed");
        emit Swapped(msg.sender,tokenIn,address(0),received,fee,amountOut,recipient);
    }
    function _pull(address token,uint256 amount) private returns(uint256){
        require(amount>0,"no input");uint256 before=IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender,address(this),amount);return IERC20(token).balanceOf(address(this))-before;
    }
    function _swap(address tokenIn,address tokenOut,uint24 poolFee,uint256 amountIn,uint256 minOut,address recipient,uint256 deadline) private returns(uint256 fee,uint256 amountOut){
        require(tokenIn!=tokenOut&&recipient!=address(0),"invalid route");
        require(minOut>0,"set minimum output");require(deadline>=block.timestamp,"expired");
        uint256 swapAmount;(fee,swapAmount)=quoteFee(amountIn);require(swapAmount>0,"amount too small");
        if(fee>0)IERC20(tokenIn).safeTransfer(feeRecipient,fee);
        IERC20(tokenIn).forceApprove(router,swapAmount);
        amountOut=IBotV3Router(router).exactInputSingle(IBotV3Router.Params(tokenIn,tokenOut,poolFee,recipient,deadline,swapAmount,minOut,0));
        IERC20(tokenIn).forceApprove(router,0);
    }
}
