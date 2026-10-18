import {parseAbi} from 'viem';
import {$,config,abis,state,client,esc,fmt,link,field,form,amount,read,tx,approve,wallet,tokenAbi,wrapForms,start} from '../core.js';
const poolFee=config.infrastructure.fee,decimals={BOT:18,WBOT:18,USDT:6};let feeBps=50;
const routes={'BOT-USDT':{label:'BOT → USDT',in:'BOT',out:'USDT'},'USDT-BOT':{label:'USDT → BOT',in:'USDT',out:'BOT'},'WBOT-USDT':{label:'WBOT → USDT',in:'WBOT',out:'USDT'},'USDT-WBOT':{label:'USDT → WBOT',in:'USDT',out:'WBOT'}};
const tokenAddress=t=>t==='USDT'?config.infrastructure.USDT:config.infrastructure.WBOT;
const quoterAbi=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256 amountOut,uint160,uint32,uint256)']);
const trim=v=>{const [a,b='']=v.split('.');return b?`${a}.${b.slice(0,6).replace(/0+$/,'')||'0'}`.replace(/\.0$/,''):a;};
function slippage(v){if(!/^\d+(\.\d{1,2})?$/.test(v)||Number(v)<0.01||Number(v)>5)throw Error('Use a slippage between 0.01% and 5%.');return Math.round(Number(v)*100);}
async function quote(key,value){const r=routes[key];if(!r)throw Error('Choose a route.');const n=amount(value,decimals[r.in]),fee=n*BigInt(feeBps)/10000n;
 const {result}=await client.simulateContract({address:config.infrastructure.quoter,abi:quoterAbi,functionName:'quoteExactInputSingle',args:[{tokenIn:tokenAddress(r.in),tokenOut:tokenAddress(r.out),amountIn:n-fee,fee:poolFee,sqrtPriceLimitX96:0n}]});
 return {amount:n,fee,out:result[0]};}
async function swap(f){
 await wallet();const slip=slippage(f.slippage),q=await quote(f.route,f['swap-amount']),r=routes[f.route],c=config.contracts.OpenHoodRouter;
 const min=q.out*BigInt(10000-slip)/10000n,deadline=BigInt(Math.floor(Date.now()/1000)+600),to=state.account;if(min<=0n)throw Error('Quote too small to swap.');
 if(r.in==='BOT')return tx('OpenHoodRouter','swapExactBOT',[tokenAddress(r.out),poolFee,min,to,deadline],q.amount);
 await approve(tokenAddress(r.in),c,q.amount);
 if(r.out==='BOT')return tx('OpenHoodRouter','swapExactTokensForBOT',[tokenAddress(r.in),poolFee,q.amount,min,to,deadline]);
 return tx('OpenHoodRouter','swapExactTokens',[tokenAddress(r.in),tokenAddress(r.out),poolFee,q.amount,min,to,deadline]);
}
function controls(){
 $('list-title').textContent='Market';
 const pairs=Object.entries(routes).map(([k,r])=>`<option value="${k}">${r.label}</option>`).join('');
 $('controls').innerHTML='<h2>Swap</h2>'+form('swap',`<label for="route">Route</label><select id="route" name="route">${pairs}</select>`+field('swap-amount','You pay','1','text','inputmode="decimal" aria-describedby="quote"')+field('slippage','Max slippage (%)','0.5','text','inputmode="decimal"'),'Review & swap',swap)+'<p id="quote" class="tiny" aria-live="polite">Enter an amount to see a live BDEX quote.</p>'+wrapForms();
 let timer;const preview=()=>{clearTimeout(timer);timer=setTimeout(async()=>{const out=$('quote');try{const q=await quote($('route').value,$('swap-amount').value);const r=routes[$('route').value];out.textContent=`≈ ${trim(fmt(q.out,decimals[r.out]))} ${r.out} after a ${trim(fmt(q.fee,decimals[r.in]))} ${r.in} fee. Minimum received is set by your slippage.`;out.classList.remove('error');}catch(e){out.textContent=e.shortMessage||e.message;out.classList.add('error');}},350);};
 for(const id of ['route','swap-amount'])$(id).addEventListener('input',preview);preview();
 $('rules').innerHTML=`<ul><li>Swaps route through the BDEX USDT/WBOT pool (0.3% pool fee). Native BOT is wrapped and unwrapped in the same transaction.</li><li>OpenHood takes a ${(feeBps/100).toFixed(2)}% fee on the amount you pay, capped onchain at 5%. The fee is shown in every quote.</li><li>Every swap carries your minimum output and a 10-minute deadline. If the price moves past your slippage, it reverts and nothing is spent but gas.</li><li>The router holds no balances between transactions and has no withdrawal function.</li><li>Quotes come from the BDEX QuoterV2. This is not investment advice; prices can move quickly.</li></ul>`;
}
async function render(){
 const [botPrice,usdtPrice]=await Promise.all([quote('BOT-USDT','1'),quote('USDT-BOT','1')]);
 let html=`<div class="row"><span>1 BOT</span><strong>≈ ${trim(fmt(botPrice.out,6))} USDT</strong></div><div class="row"><span>1 USDT</span><strong>≈ ${trim(fmt(usdtPrice.out))} BOT</strong></div><div class="row"><span>OpenHood fee</span><strong>${(feeBps/100).toFixed(2)}%</strong></div><p class="tiny">Quotes include the OpenHood fee and BDEX's 0.3% pool fee.</p>`;
 if(state.account){const [bot,wb,usd]=await Promise.all([client.getBalance({address:state.account}),...['WBOT','USDT'].map(t=>client.readContract({address:tokenAddress(t),abi:tokenAbi,functionName:'balanceOf',args:[state.account]}))]);html+=`<h3>Your wallet</h3><div class="row"><span>BOT</span><strong>${trim(fmt(bot))}</strong></div><div class="row"><span>WBOT</span><strong>${trim(fmt(wb))}</strong></div><div class="row"><span>USDT</span><strong>${trim(fmt(usd,6))}</strong></div>`;}
 html+='<h3>Recent OpenHood swaps</h3>';
 try{const latest=await client.getBlockNumber();const logs=(await client.getContractEvents({address:config.contracts.OpenHoodRouter,abi:abis.OpenHoodRouter,eventName:'Swapped',fromBlock:latest>5000n?latest-5000n:0n,toBlock:latest})).slice(-15).reverse();
  const sym=a=>/^0x0{40}$/i.test(a)?'BOT':a.toLowerCase()===config.infrastructure.USDT.toLowerCase()?'USDT':'WBOT';
  html+=logs.map(l=>{const a=l.args,i=sym(a.tokenIn),o=sym(a.tokenOut);return `<div class="row"><span>${link(a.sender)} · <a href="https://scan.botchain.ai/tx/${esc(l.transactionHash)}" target="_blank" rel="noopener noreferrer">tx</a></span><strong>${trim(fmt(a.amountIn,decimals[i]))} ${i} → ${trim(fmt(a.amountOut,decimals[o]))} ${o}</strong></div>`;}).join('')||'<p class="tiny">No swaps in the last 5,000 blocks.</p>';}
 catch{html+='<p class="tiny">Swap history is unavailable from this RPC right now.</p>';}
 return html;
}
start({controls,render,async onVerified(){feeBps=Number(await read('OpenHoodRouter','feeBps'));controls();}});
