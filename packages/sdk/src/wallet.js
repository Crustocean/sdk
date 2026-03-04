/**
 * Crustocean SDK — Non-custodial wallet layer.
 *
 * SECURITY MODEL:
 *   - Private keys NEVER leave the local process
 *   - Private keys are NEVER stored as object properties
 *   - Signing clients are hidden in WeakMaps — inaccessible to LLM agents
 *   - The only exposed surface is: public address, balances, send/approve operations
 *   - An LLM agent using this SDK cannot access, print, or leak the private key
 *
 * The developer (human) generates keys and passes them to the constructor.
 * The constructor captures the key in a closure, creates the viem signer,
 * and discards any reference. The key exists only inside viem's closure scope.
 */

import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, parseUnits } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const USDC_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const USDC_ADDRESS = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

const EXPLORER_URL = {
  base: 'https://basescan.org',
  'base-sepolia': 'https://sepolia.basescan.org',
};

function resolveChain(network) {
  return network === 'base-sepolia' ? baseSepolia : base;
}

function resolveRpcUrl(network) {
  return network === 'base-sepolia' ? 'https://sepolia.base.org' : 'https://mainnet.base.org';
}

// ─── Key Isolation ──────────────────────────────────────────────────────────
// WeakMaps hold the signing clients. They cannot be enumerated, stringified,
// or accessed from outside this module. An LLM agent that can inspect object
// properties, call JSON.stringify, or iterate with Object.keys will find nothing.

const _walletClients = new WeakMap();
const _publicClients = new WeakMap();

/**
 * Generate a new wallet locally.
 *
 * IMPORTANT: This is called by the DEVELOPER (human), not the agent.
 * The returned privateKey must be saved to a .env file or secret manager.
 * Never pass it to an LLM, log it, or include it in any message.
 *
 * @returns {{ address: string, privateKey: string }}
 */
export function generateWallet() {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    privateKey,
  };
}

/**
 * Local wallet provider — all signing happens in this process.
 *
 * The private key is consumed during construction and then exists only
 * inside viem's internal closure. It is NOT stored as a property on this
 * object or anywhere reachable by property access.
 *
 * Safe to pass to an LLM agent — they can call getBalances(), sendUSDC(),
 * and approve(), but cannot extract the key.
 */
export class LocalWalletProvider {
  /**
   * @param {string} privateKey - Hex private key. Consumed here, then unreachable.
   * @param {Object} [options]
   * @param {string} [options.network='base']
   * @param {string} [options.rpcUrl]
   */
  constructor(privateKey, options = {}) {
    const { network = 'base', rpcUrl } = options;
    const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const account = privateKeyToAccount(key);

    const chain = resolveChain(network);
    const transport = http(rpcUrl || resolveRpcUrl(network));

    const publicClient = createPublicClient({ chain, transport });
    const walletClient = createWalletClient({ account, chain, transport });

    // Store signing client in WeakMap — invisible to property enumeration
    _walletClients.set(this, walletClient);
    _publicClients.set(this, publicClient);

    // Only the public address is stored as a property
    Object.defineProperty(this, 'address', {
      value: account.address,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, 'type', {
      value: 'local',
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, '_network', {
      value: network,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    // Freeze to prevent adding properties that could leak key material
    Object.freeze(this);
  }

  async getBalances() {
    const publicClient = _publicClients.get(this);
    const usdcAddr = USDC_ADDRESS[this._network] || USDC_ADDRESS.base;
    const [usdcRaw, ethRaw] = await Promise.all([
      publicClient.readContract({
        address: usdcAddr,
        abi: USDC_ABI,
        functionName: 'balanceOf',
        args: [this.address],
      }),
      publicClient.getBalance({ address: this.address }),
    ]);
    return {
      usdc: formatUnits(usdcRaw, 6),
      eth: formatUnits(ethRaw, 18),
    };
  }

  /**
   * Send USDC on-chain. Signed locally — no key material is accessible.
   * @param {string} toAddress - Recipient 0x address
   * @param {number|string} amount - Human-readable USDC amount
   * @returns {Promise<{ txHash: string, explorerUrl: string, from: string, to: string, amount: string }>}
   */
  async sendUSDC(toAddress, amount) {
    const walletClient = _walletClients.get(this);
    const publicClient = _publicClients.get(this);
    const usdcAddr = USDC_ADDRESS[this._network] || USDC_ADDRESS.base;
    const parsedAmount = parseUnits(String(amount), 6);

    const balance = await publicClient.readContract({
      address: usdcAddr,
      abi: USDC_ABI,
      functionName: 'balanceOf',
      args: [this.address],
    });
    if (balance < parsedAmount) {
      throw new Error(`Insufficient USDC. Have ${formatUnits(balance, 6)}, need ${amount}`);
    }

    const hash = await walletClient.writeContract({
      address: usdcAddr,
      abi: USDC_ABI,
      functionName: 'transfer',
      args: [toAddress, parsedAmount],
    });

    await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });

    const explorerBase = EXPLORER_URL[this._network] || EXPLORER_URL.base;
    return {
      txHash: hash,
      explorerUrl: `${explorerBase}/tx/${hash}`,
      from: this.address,
      to: toAddress,
      amount: String(amount),
    };
  }

  async approve(spender, amount) {
    const walletClient = _walletClients.get(this);
    const publicClient = _publicClients.get(this);
    const usdcAddr = USDC_ADDRESS[this._network] || USDC_ADDRESS.base;
    const parsedAmount = parseUnits(String(amount), 6);

    const hash = await walletClient.writeContract({
      address: usdcAddr,
      abi: USDC_ABI,
      functionName: 'approve',
      args: [spender, parsedAmount],
    });

    await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    return { txHash: hash };
  }

  /**
   * Read-only access to the public chain client.
   * Safe — contains no key material.
   */
  getPublicClient() {
    return _publicClients.get(this);
  }
}

/**
 * External signer wallet provider — wraps an existing viem WalletClient.
 * For MetaMask, Safe, hardware wallets, or any custom signer.
 * Keys are managed by the external signer — never exposed here.
 */
export class ExternalSignerWalletProvider {
  constructor(walletClient, publicClient, network = 'base') {
    _walletClients.set(this, walletClient);
    _publicClients.set(this, publicClient || createPublicClient({
      chain: resolveChain(network),
      transport: http(resolveRpcUrl(network)),
    }));

    Object.defineProperty(this, 'type', {
      value: 'external',
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, '_network', {
      value: network,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  async getAddress() {
    const walletClient = _walletClients.get(this);
    const [address] = await walletClient.getAddresses();
    return address;
  }

  async getBalances() {
    const address = await this.getAddress();
    const publicClient = _publicClients.get(this);
    const usdcAddr = USDC_ADDRESS[this._network] || USDC_ADDRESS.base;
    const [usdcRaw, ethRaw] = await Promise.all([
      publicClient.readContract({
        address: usdcAddr,
        abi: USDC_ABI,
        functionName: 'balanceOf',
        args: [address],
      }),
      publicClient.getBalance({ address }),
    ]);
    return {
      usdc: formatUnits(usdcRaw, 6),
      eth: formatUnits(ethRaw, 18),
    };
  }

  async sendUSDC(toAddress, amount) {
    const walletClient = _walletClients.get(this);
    const publicClient = _publicClients.get(this);
    const usdcAddr = USDC_ADDRESS[this._network] || USDC_ADDRESS.base;
    const parsedAmount = parseUnits(String(amount), 6);

    const hash = await walletClient.writeContract({
      address: usdcAddr,
      abi: USDC_ABI,
      functionName: 'transfer',
      args: [toAddress, parsedAmount],
    });

    await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });

    const explorerBase = EXPLORER_URL[this._network] || EXPLORER_URL.base;
    return {
      txHash: hash,
      explorerUrl: `${explorerBase}/tx/${hash}`,
      from: await this.getAddress(),
      to: toAddress,
      amount: String(amount),
    };
  }

  getPublicClient() {
    return _publicClients.get(this);
  }
}

/**
 * Create a wallet provider. Keys are captured in closures and WeakMaps,
 * never stored as accessible properties.
 *
 * @param {Object} walletOpt
 * @param {string} [walletOpt.privateKey] — Consumed and hidden. Never stored.
 * @param {Object} [walletOpt.signer] — External viem WalletClient
 * @param {Object} [context]
 * @param {string} [context.network='base']
 * @param {string} [context.rpcUrl]
 * @param {Object} [context.publicClient]
 * @returns {LocalWalletProvider|ExternalSignerWalletProvider}
 */
export function createWalletProvider(walletOpt, context = {}) {
  const { network = 'base', rpcUrl, publicClient } = context;

  if (!walletOpt || typeof walletOpt !== 'object') {
    throw new Error('Wallet config required: { privateKey } or { signer }');
  }

  if (walletOpt.privateKey) {
    return new LocalWalletProvider(walletOpt.privateKey, { network, rpcUrl });
  }

  if (walletOpt.signer) {
    return new ExternalSignerWalletProvider(walletOpt.signer, publicClient, network);
  }

  throw new Error('Wallet config must include privateKey or signer.');
}

export { USDC_ADDRESS, USDC_ABI, EXPLORER_URL };
