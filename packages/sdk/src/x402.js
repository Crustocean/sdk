/**
 * x402 — Internet-native payments for Crustocean.
 * Use when calling paid APIs (LLMs, data, etc.) that return HTTP 402.
 * Supports Base (eip155:8453) and Base Sepolia (eip155:84532).
 *
 * @see https://x402.org
 * @see https://docs.x402.org
 */

import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http } from 'viem';
import { base, baseSepolia } from 'viem/chains';

const BASE_MAINNET = 'eip155:8453';
const BASE_SEPOLIA = 'eip155:84532';

/**
 * Create a fetch function that automatically pays for HTTP 402 responses using USDC on Base.
 * Use this when your agent or backend calls paid APIs (LLM inference, market data, etc.).
 *
 * @param {Object} options
 * @param {string} options.privateKey - Hex private key (0x-prefixed) for the payer wallet. Must hold USDC on Base.
 * @param {string} [options.network='base'] - 'base' (mainnet) or 'base-sepolia' (testnet)
 * @param {typeof fetch} [options.fetchFn=globalThis.fetch] - Fetch implementation to wrap
 * @returns {typeof fetch} A fetch function that handles 402 by paying and retrying
 *
 * @example
 * // In your agent's response webhook or SDK script:
 * import { createX402Fetch } from '@crustocean/sdk/x402';
 *
 * const fetchWithPayment = createX402Fetch({
 *   privateKey: process.env.X402_PAYER_PRIVATE_KEY,
 *   network: 'base',
 * });
 *
 * const res = await fetchWithPayment('https://paid-api.example.com/inference', {
 *   method: 'POST',
 *   body: JSON.stringify({ prompt: 'Hello' }),
 * });
 * const data = await res.json();
 */
export function createX402Fetch({
  privateKey,
  network = 'base',
  fetchFn = globalThis.fetch,
}) {
  if (!privateKey || typeof privateKey !== 'string') {
    throw new Error('createX402Fetch requires a privateKey (hex string with 0x prefix)');
  }

  const chain = network === 'base-sepolia' ? baseSepolia : base;
  const networkId = network === 'base-sepolia' ? BASE_SEPOLIA : BASE_MAINNET;

  const account = privateKeyToAccount(
    privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`
  );

  const publicClient = createPublicClient({
    chain,
    transport: http(),
  });

  const signer = toClientEvmSigner(account, publicClient);
  const scheme = new ExactEvmScheme(signer);

  return wrapFetchWithPaymentFromConfig(fetchFn, {
    schemes: [{ network: networkId, client: scheme }],
  });
}

/**
 * Re-export for advanced usage.
 */
export { wrapFetchWithPayment, wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';
export { ExactEvmScheme, toClientEvmSigner } from '@x402/evm';
