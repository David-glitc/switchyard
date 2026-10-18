import assert from 'node:assert/strict';
import {parseEther,parseAbi} from 'viem';
const quoter=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)']);
export default {
 slug:'switchyard',name:'Switchyard',repo:'switchyard',contract:'SwitchyardRouter',color:'#7cf0ff',eyebrow:'OPEN TRADING',symbol:'↔',
 line:'Open trading on BOT Chain.',
 description:'Swap BOT, WBOT and USDT through BDEX with live quotes, a slippage limit and one transparent fee.',
 abis:['SwitchyardRouter'],
 contracts:['src/SwitchyardRouter.sol','src/interfaces/IBotV3Router.sol'],tests:['test/Switchyard.t.sol'],
 landing:{
  steps:[['Pick a route','BOT, WBOT or USDT in either direction through the BDEX USDT/WBOT pool.'],['See the real quote','The BDEX QuoterV2 prices your trade live, with the Switchyard fee already taken out.'],['Swap in one transaction','Your minimum output and a 10-minute deadline travel with the swap. Native BOT wraps and unwraps automatically.']],
  features:[['Live BDEX pricing','Quotes come straight from the onchain QuoterV2, not a cached API.'],['Slippage protection','Every swap requires a nonzero minimum output; bad fills revert.'],['One visible fee','A 0.5% input fee, capped onchain at 5%, shown in every quote.'],['Nothing held','The router keeps no balances between transactions and has no withdraw function.']],
  faq:[['Which tokens can I trade?','Native BOT, WBOT and USDT, through BDEX\'s 0.3% USDT/WBOT pool.'],['What does Switchyard charge?','0.5% of the amount you pay, on top of the BDEX pool fee. The contract caps it at 5%.'],['What if the price moves?','If you would receive less than your minimum, the swap reverts and you only pay gas.'],['Is Switchyard custodial?','No. Tokens move from your wallet to BDEX and back to you in a single transaction.']],
 },
 async deploy({deploy,account,i}){await deploy('SwitchyardRouter',[i.router,i.WBOT,account.address,50]);},
 async fork({c,abi,i,tx,write,read,contract,owner}){
  const hood=contract.SwitchyardRouter,fee=BigInt(await read('SwitchyardRouter','feeBps')),deadline=BigInt((await c.getBlock()).timestamp)+600n;
  const quote=async(tokenIn,tokenOut,n)=>{const {result}=await c.simulateContract({address:i.quoter,abi:quoter,functionName:'quoteExactInputSingle',args:[{tokenIn,tokenOut,amountIn:n-n*fee/10000n,fee:i.fee,sqrtPriceLimitX96:0n}]});return result[0]*995n/1000n;};
  const balance=t=>c.readContract({address:t,abi,functionName:'balanceOf',args:[owner.address]});
  const before=await balance(i.USDT);
  await write('SwitchyardRouter','swapExactBOT',[i.USDT,i.fee,await quote(i.WBOT,i.USDT,parseEther('0.01')),owner.address,deadline],parseEther('0.01'));
  const got=await balance(i.USDT)-before;assert(got>0n);
  await tx(abi,i.USDT,'approve',[hood,got]);const botBefore=await c.getBalance({address:owner.address});
  const back=await write('SwitchyardRouter','swapExactTokensForBOT',[i.USDT,i.fee,got/2n,await quote(i.USDT,i.WBOT,got/2n),owner.address,deadline]);
  assert(await c.getBalance({address:owner.address})+back.gasUsed*back.effectiveGasPrice>botBefore);
  await write('SwitchyardRouter','swapExactTokens',[i.USDT,i.WBOT,i.fee,got-got/2n,await quote(i.USDT,i.WBOT,got-got/2n),owner.address,deadline]);
  for(const t of [i.USDT,i.WBOT])assert.equal(await c.readContract({address:t,abi,functionName:'balanceOf',args:[hood]}),0n);assert.equal(await c.getBalance({address:hood}),0n);
  return {feeBps:String(fee),usdtFromBOT:String(got),flow:'BOT → USDT → BOT and USDT → WBOT through real BDEX; router left empty'};
 },
};
