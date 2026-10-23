import {parseAbi} from 'viem';
import {$,config,abis,state,client,net,esc,fmt,link,form,amount,read,tx,approve,wallet,tokenAbi,wrapForms,chainTime,asset,start} from '../core.js';
const poolFee=config.infrastructure.fee,decimals={BOT:18,WBOT:18,USDT:6};let feeBps=50;
// BDEX has one deep USDT/WBOT pool, so every route pairs USDT with BOT or WBOT.
const pairs={BOT:['USDT'],WBOT:['USDT'],USDT:['BOT','WBOT']};
const tokenAddress=t=>t==='USDT'?config.infrastructure.USDT:config.infrastructure.WBOT;
const quoterAbi=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256 amountOut,uint160,uint32,uint256)']);
const trim=v=>{const [a,b='']=v.split('.');return b?`${a}.${b.slice(0,6).replace(/0+$/,'')||'0'}`.replace(/\.0$/,''):a;};
function slippage(v){if(!/^\d+(\.\d{1,2})?$/.test(v)||Number(v)<0.01||Number(v)>5)throw Error('Use a slippage between 0.01% and 5%.');return Math.round(Number(v)*100);}
async function quote(pay,get,value){const n=amount(value,decimals[pay]),fee=n*BigInt(feeBps)/10000n;
 const {result}=await client.simulateContract({address:config.infrastructure.quoter,abi:quoterAbi,functionName:'quoteExactInputSingle',args:[{tokenIn:tokenAddress(pay),tokenOut:tokenAddress(get),amountIn:n-fee,fee:poolFee,sqrtPriceLimitX96:0n}]});
 return {amount:n,fee,out:result[0]};}
async function swap(f){
 await wallet();const slip=slippage(f.slippage),pay=f.pay,get=f.get;if(!pairs[pay]?.includes(get))throw Error('Choose a supported pair.');
 const q=await quote(pay,get,f['swap-amount']),c=config.contracts.SwitchyardRouter;
 const min=q.out*BigInt(10000-slip)/10000n,deadline=BigInt(await chainTime()+600),to=state.account;if(min<=0n)throw Error('Quote too small to swap.');
 if(pay==='BOT')return tx('SwitchyardRouter','swapExactBOT',[tokenAddress(get),poolFee,min,to,deadline],q.amount);
 await approve(tokenAddress(pay),c,q.amount);
 if(get==='BOT')return tx('SwitchyardRouter','swapExactTokensForBOT',[tokenAddress(pay),poolFee,q.amount,min,to,deadline]);
 return tx('SwitchyardRouter','swapExactTokens',[tokenAddress(pay),tokenAddress(get),poolFee,q.amount,min,to,deadline]);
}
// About 24 hours of BOT Chain blocks (0.75 s each).
const DAY=115200n;
const balances={};let price=null,swaps24=0,volume=0n;
const opts=(list,sel)=>list.map(t=>`<option value="${t}"${t===sel?' selected':''}>${t}</option>`).join('');
const flipIcon='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/></svg>';
function controls(){
 $('list-title').textContent='Departures';
 $('controls').innerHTML='<div class="section-head"><h2>Swap</h2><span class="badge live">BDEX live</span></div>'+form('swap',
  `<div class="swap-leg"><label for="swap-amount">You pay</label><div class="leg-row"><input id="swap-amount" name="swap-amount" value="1" inputmode="decimal" autocomplete="off" required aria-describedby="quote-note"><select id="pay" name="pay" aria-label="Token you pay">${opts(Object.keys(pairs),'BOT')}</select></div><p class="leg-meta"><span id="pay-bal">Connect a wallet to see your balance</span><button type="button" id="max" class="quiet" hidden>Max</button></p></div>`
  +`<button type="button" class="flip" id="flip" aria-label="Reverse direction">${flipIcon}</button>`
  +`<div class="swap-leg"><span class="leg-label" id="get-label">You receive (estimate)</span><div class="leg-row"><output id="receive" aria-labelledby="get-label" aria-live="polite">—</output><select id="get" name="get" aria-label="Token you receive">${opts(pairs.BOT,'USDT')}</select></div><p class="leg-meta"><span id="get-bal"></span></p></div>`
  +`<dl class="quote" id="quote"><div><dt>Rate</dt><dd id="q-rate">—</dd></div><div><dt>Switchyard fee</dt><dd id="q-fee">—</dd></div><div><dt>Minimum received</dt><dd id="q-min">—</dd></div><div><dt>Route</dt><dd>BDEX USDT/WBOT · 0.3%</dd></div></dl>`
  +`<fieldset class="chips" aria-label="Max slippage"><span class="tiny">Max slippage</span>${['0.1','0.5','1'].map(v=>`<button type="button" data-slip="${v}" aria-pressed="${v==='0.5'}">${v}%</button>`).join('')}<input id="slippage" name="slippage" value="0.5" inputmode="decimal" aria-label="Custom slippage percent"></fieldset>`
  +'<p id="quote-note" class="hint" aria-live="polite">Enter an amount to see a live BDEX quote.</p>','Review & swap',swap)+wrapForms();
 const sel=()=>({pay:$('pay').value,get:$('get').value});
 let timer;const preview=()=>{clearTimeout(timer);timer=setTimeout(async()=>{const {pay,get}=sel(),note=$('quote-note');
  try{const q=await quote(pay,get,$('swap-amount').value),slip=slippage($('slippage').value),min=q.out*BigInt(10000-slip)/10000n;
   const out=Number(fmt(q.out,decimals[get])),inp=Number(fmt(q.amount,decimals[pay]));
   $('receive').textContent=trim(fmt(q.out,decimals[get]));$('q-rate').textContent=`1 ${pay} ≈ ${trim(String(out/inp))} ${get}`;
   $('q-fee').textContent=`${trim(fmt(q.fee,decimals[pay]))} ${pay} (${(feeBps/100).toFixed(2)}%)`;$('q-min').textContent=`${trim(fmt(min,decimals[get]))} ${get}`;
   note.textContent='Quote from the BDEX QuoterV2. It refreshes as you type; the swap reverts if the price moves past your slippage.';note.classList.remove('error');}
  catch(e){$('receive').textContent='—';for(const id of ['q-rate','q-fee','q-min'])$(id).textContent='—';note.textContent=e.shortMessage||e.message;note.classList.add('error');}
  showBalances();},300);};
 const setPay=pay=>{const keep=$('get').value;$('pay').value=pay;$('get').innerHTML=opts(pairs[pay],pairs[pay].includes(keep)?keep:pairs[pay][0]);preview();};
 $('pay').addEventListener('change',()=>setPay($('pay').value));
 $('flip').addEventListener('click',()=>{const {pay,get}=sel();setPay(get);$('get').innerHTML=opts(pairs[get],pay);preview();});
 for(const id of ['get','swap-amount','slippage'])$(id).addEventListener('input',preview);
 $('slippage').addEventListener('input',()=>{for(const b of document.querySelectorAll('[data-slip]'))b.setAttribute('aria-pressed',String(b.dataset.slip===$('slippage').value));});
 for(const b of document.querySelectorAll('[data-slip]'))b.addEventListener('click',()=>{$('slippage').value=b.dataset.slip;$('slippage').dispatchEvent(new Event('input'));});
 $('max').addEventListener('click',()=>{const pay=$('pay').value;let n=balances[pay]??0n;if(pay==='BOT')n=n>10n**16n?n-10n**16n:0n;$('swap-amount').value=trim(fmt(n,decimals[pay]));preview();});
 preview();
 $('rules').innerHTML=`<ul><li>Swaps route through the BDEX USDT/WBOT pool (0.3% pool fee). Native BOT is wrapped and unwrapped in the same transaction.</li><li>Switchyard takes a ${(feeBps/100).toFixed(2)}% fee on the amount you pay, capped onchain at 5%. The fee is shown in every quote.</li><li>Every swap carries your minimum output and a 10-minute deadline. If the price moves past your slippage, it reverts and nothing is spent but gas.</li><li>The router holds no balances between transactions and has no withdrawal function.</li><li>Quotes come from the BDEX QuoterV2. This is not investment advice; prices can move quickly.</li></ul>`;
}
function showBalances(){const pay=$('pay')?.value,get=$('get')?.value;if(!pay||!state.account||balances[pay]===undefined)return;
 $('pay-bal').textContent=`Balance ${trim(fmt(balances[pay],decimals[pay]))} ${pay}`;$('get-bal').textContent=`Balance ${trim(fmt(balances[get],decimals[get]))} ${get}`;$('max').hidden=false;}
const sym=a=>/^0x0{40}$/i.test(a)?'BOT':a.toLowerCase()===config.infrastructure.USDT.toLowerCase()?'USDT':'WBOT';
async function render(){
 // Market price: add the Switchyard fee back so the figure is the pool price, not the net quote.
 price=(await quote('BOT','USDT','1')).out*10000n/BigInt(10000-feeBps);
 if(state.account){const [bot,wb,usd]=await Promise.all([client.getBalance({address:state.account}),...['WBOT','USDT'].map(t=>client.readContract({address:tokenAddress(t),abi:tokenAbi,functionName:'balanceOf',args:[state.account]}))]);Object.assign(balances,{BOT:bot,WBOT:wb,USDT:usd});showBalances();}
 let html='';
 try{const latest=await client.getBlockNumber(),from=latest>DAY?latest-DAY:0n;
  const logs=(await client.getContractEvents({address:config.contracts.SwitchyardRouter,abi:abis.SwitchyardRouter,eventName:'Swapped',fromBlock:from,toBlock:latest})).reverse();
  swaps24=logs.length;volume=logs.reduce((s,l)=>s+(sym(l.args.tokenIn)==='USDT'?l.args.amountIn:sym(l.args.tokenOut)==='USDT'?l.args.amountOut:0n),0n);
  const rows=logs.slice(0,20).map(l=>{const a=l.args,i=sym(a.tokenIn),o=sym(a.tokenOut);return `<tr><td>${link(a.sender)}</td><td class="num">${trim(fmt(a.amountIn,decimals[i]))} ${asset(i)}</td><td class="num">${trim(fmt(a.amountOut,decimals[o]))} ${asset(o)}</td><td class="num"><a href="${net.explorer}/tx/${esc(l.transactionHash)}" target="_blank" rel="noopener noreferrer">Block ${l.blockNumber}</a></td></tr>`;}).join('');
  html+=rows?`<div class="table-wrap"><table class="board stack"><caption class="sr-only">Recent Switchyard swaps</caption><thead><tr><th scope="col">Wallet</th><th scope="col" class="num">Paid</th><th scope="col" class="num">Received</th><th scope="col" class="num">Transaction</th></tr></thead><tbody>${rows}</tbody></table></div>`
   :'<p class="empty">No swaps in the last 24 hours. Yours can be the first departure on the board.</p>';}
 catch{html+='<p class="empty">Swap history is unavailable from this RPC right now. Swaps still work.</p>';}
 html+=`<h3 class="sub">Rates</h3><div class="row"><span>1 ${asset('BOT')}</span><strong class="mono">≈ ${trim(fmt(price,6))} ${asset('USDT')}</strong></div><div class="row"><span>Switchyard fee</span><strong class="mono">${(feeBps/100).toFixed(2)}%</strong></div><p class="tiny">Quotes include the Switchyard fee and the <a href="${net.explorer}/address/${config.infrastructure.router}" target="_blank" rel="noopener noreferrer">BDEX</a> 0.3% pool fee.</p>`;
 return html;
}
function stats(empty){return [['BOT price',empty||price===null?'—':`$${trim(fmt(price,6)).replace(/(\.\d{2})\d+/,'$1')}`],['Swaps · 24h',empty?'—':String(swaps24)],['Volume · 24h',empty?'—':`$${Number(fmt(volume,6)).toLocaleString(undefined,{maximumFractionDigits:2})}`]];}
start({controls,render,stats,async onVerified(){feeBps=Number(await read('SwitchyardRouter','feeBps'));controls();}});
