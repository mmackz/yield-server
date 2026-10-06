const sdk = require('@defillama/sdk');
const utils = require('../utils');

// Rabbithole computes rewards off chain (time-weighted accrual published as merkle
// roots), so the reward APY and the capital earning it come from the public
// campaigns API. Docs: https://api-tbi.boost.xyz/docs
const API_URL = 'https://api-tbi.boost.xyz/v1/campaigns/active';
const PAGE_SIZE = 100;

const PROJECT = 'rabbithole';

// Keyed by the chain the incentivized position lives on, which can differ from
// the chain the campaign pays out on.
const CHAINS = {
  1: { sdk: 'ethereum', name: 'Ethereum' },
  10: { sdk: 'optimism', name: 'OP Mainnet' },
  137: { sdk: 'polygon', name: 'Polygon' },
  480: { sdk: 'wc', name: 'World Chain' },
  4663: { sdk: 'robinhood', name: 'Robinhood Chain' },
  8453: { sdk: 'base', name: 'Base' },
  42161: { sdk: 'arbitrum', name: 'Arbitrum' },
};

// Target kinds that are deposit positions. Prediction-market (ERC1155) campaigns
// are not yield pools and are left out.
const POOL_STANDARDS = new Set(['ERC20', 'UniswapV4LP', 'Ledger']);

const fetchCampaigns = async () => {
  const campaigns = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data } = await utils.withRetry(() =>
      utils.getData(
        `${API_URL}?limit=${PAGE_SIZE}&offset=${offset}&includeForwarderRequired=true`
      )
    );
    campaigns.push(...data);
    if (data.length < PAGE_SIZE) return campaigns;
  }
};

// The position a depositor holds: the V4 pool, the Ledger market, or the token.
const positionKey = ({ target }) => {
  if (target.tokenStandard === 'UniswapV4LP') return target.poolId;
  if (target.tokenStandard === 'Ledger')
    return `${target.address}-${target.marketKey}`;
  return target.address;
};

// A Beefy CLM target is the reward pool's share token; its staked token is the
// CLM, whose `wants()` are the two pool tokens a depositor provides.
const beefyClmPairs = async (campaigns) => {
  const targetsByChain = {};
  for (const c of campaigns) {
    if (c.target.protocol === 'beefy-clm')
      (targetsByChain[c.target.chainId] ??= new Set()).add(c.target.address);
  }

  const pairs = {};
  for (const [chainId, addresses] of Object.entries(targetsByChain)) {
    const chain = CHAINS[chainId].sdk;
    const targets = [...addresses];
    const { output: clms } = await sdk.api.abi.multiCall({
      chain,
      abi: 'address:stakedToken',
      calls: targets.map((target) => ({ target })),
      permitFailure: true,
    });
    const { output: wants } = await sdk.api.abi.multiCall({
      chain,
      abi: 'function wants() view returns (address token0, address token1)',
      calls: clms.map(({ output }) => ({ target: output })),
      permitFailure: true,
    });
    wants.forEach(({ output }, i) => {
      if (output)
        pairs[`${chainId}:${targets[i]}`] = [output.token0, output.token1];
    });
  }
  return pairs;
};

const underlyingOf = ({ target }, clmPairs) => {
  if (target.tokenStandard === 'UniswapV4LP')
    return [target.token0, target.token1];
  if (target.tokenStandard === 'Ledger') return [target.asset];
  return clmPairs[`${target.chainId}:${target.address}`] ?? [target.address];
};

const symbolsByChain = async (campaigns, clmPairs) => {
  const addressesByChain = {};
  for (const c of campaigns) {
    const set = (addressesByChain[c.target.chainId] ??= new Set());
    underlyingOf(c, clmPairs).forEach((a) => set.add(a.toLowerCase()));
  }

  const symbols = {};
  for (const [chainId, addresses] of Object.entries(addressesByChain)) {
    const targets = [...addresses];
    const { output } = await sdk.api.abi.multiCall({
      chain: CHAINS[chainId].sdk,
      abi: 'erc20:symbol',
      calls: targets.map((target) => ({ target })),
      permitFailure: true,
    });
    output.forEach(({ input, output: symbol }) => {
      if (symbol) symbols[`${chainId}:${input.target.toLowerCase()}`] = symbol;
    });
  }
  return symbols;
};

const apy = async () => {
  const campaigns = (await fetchCampaigns()).filter(
    (c) =>
      POOL_STANDARDS.has(c.target.tokenStandard) &&
      CHAINS[c.target.chainId] &&
      CHAINS[c.id.chainId] &&
      c.budgetExhausted !== true &&
      Number(c.boostApyBps) > 0
  );

  const clmPairs = await beefyClmPairs(campaigns);
  const symbols = await symbolsByChain(campaigns, clmPairs);

  // Campaigns on the same position are one opportunity: their reward APYs add up.
  // Forwarder-routed campaigns stay separate, since only deposits made through
  // Rabbithole earn them.
  const pools = {};
  for (const c of campaigns) {
    const chainId = c.target.chainId;
    const gated = c.requiresForwarderDeposit;
    const id = `${positionKey(c)}-${CHAINS[chainId].sdk}${
      gated ? '-forwarder' : ''
    }-${PROJECT}`.toLowerCase();

    const underlyingTokens = underlyingOf(c, clmPairs);
    const symbol = underlyingTokens
      .map((a) => symbols[`${chainId}:${a.toLowerCase()}`])
      .filter(Boolean)
      .join('-');

    const poolMeta = [
      gated && 'Deposit via Rabbithole',
      c.modes?.newCapitalOnly && 'New deposits only',
    ]
      .filter(Boolean)
      .join(', ');

    const pool = (pools[id] ??= {
      pool: id,
      chain: CHAINS[chainId].name,
      project: PROJECT,
      symbol,
      // USD value of the positions currently earning rewards (6 decimals)
      tvlUsd: 0,
      apyReward: 0,
      rewardTokens: [],
      underlyingTokens,
      token: c.target.tokenStandard === 'ERC20' ? c.target.address : null,
      ...(poolMeta && { poolMeta }),
      url: `https://rabbithole.gg/?tbi=${c.id.chainId}:${c.id.campaignIndex}`,
    });

    // A campaign can pay out on a different chain than the position; the
    // DefiLlama coin key names that chain explicitly.
    const rewardToken =
      c.id.chainId === chainId
        ? c.rewardToken.address
        : `${CHAINS[c.id.chainId].sdk}:${c.rewardToken.address}`;

    pool.tvlUsd = Math.max(pool.tvlUsd, Number(c.tvl) / 1e6);
    pool.apyReward += Number(c.boostApyBps) / 100;
    if (!pool.rewardTokens.includes(rewardToken))
      pool.rewardTokens.push(rewardToken);
  }

  return Object.values(pools)
    .filter((p) => p.symbol)
    .filter(utils.keepFinite);
};

module.exports = {
  protocolId: 'TBD', // TODO: Add protocol ID
  timetravel: false,
  apy,
  url: 'https://rabbithole.gg',
};
