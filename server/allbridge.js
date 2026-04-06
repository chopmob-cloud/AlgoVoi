import {
  AllbridgeCoreSdk,
  ChainSymbol,
  Messenger,
  nodeRpcUrlsDefault,
} from "@allbridge/bridge-core-sdk";
import algosdk from "algosdk";
import { z } from "zod";

const ALG_NODE = "https://mainnet-api.algonode.cloud";

function getSdk() {
  return new AllbridgeCoreSdk({
    ...nodeRpcUrlsDefault,
    ALG: ALG_NODE,
  });
}

const success = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const failure = (msg) => ({ content: [{ type: "text", text: JSON.stringify({ error: msg }) }], isError: true });

export function registerAllbridgeTools(server) {

  // Get supported tokens on Algorand
  server.tool(
    "allbridge_get_tokens",
    "Get all tokens available for bridging from Algorand via Allbridge. Returns token addresses, symbols, and supported destination chains.",
    {},
    async () => {
      try {
        const sdk = getSdk();
        const chains = await sdk.chainDetailsMap();
        const algChain = chains[ChainSymbol.ALG];
        if (!algChain) return failure("Algorand chain not found in Allbridge");

        const tokens = algChain.tokens.map((t) => ({
          symbol: t.symbol,
          tokenAddress: t.tokenAddress,
          decimals: t.decimals,
        }));

        const destinations = {};
        for (const [chainSym, chainData] of Object.entries(chains)) {
          if (chainSym === ChainSymbol.ALG) continue;
          for (const destToken of chainData.tokens) {
            if (!destinations[destToken.symbol]) destinations[destToken.symbol] = [];
            destinations[destToken.symbol].push({ chain: chainSym, chainName: chainData.name });
          }
        }

        return success({ tokens, destinations });
      } catch (err) {
        return failure(err.message);
      }
    }
  );

  // Build unsigned bridge transactions
  server.tool(
    "allbridge_bridge_txn",
    "Build unsigned Algorand transactions for bridging USDC from Algorand to another chain via Allbridge. Returns hex-encoded unsigned transactions for wallet signing.",
    {
      fromAddress: z.string().describe("Sender Algorand address"),
      toAddress: z.string().describe("Recipient address on destination chain"),
      sourceTokenAddress: z.string().describe("Token address on Algorand (from allbridge_get_tokens)"),
      destinationChain: z.enum(["ETH","BSC","SOL","TRX","POL","ARB","AVA","CEL","OPT","BAS","SUI","SNC","STLR","SRB","STX"]).describe("Destination chain symbol"),
      destinationTokenSymbol: z.string().describe("Token symbol on destination chain e.g. USDC"),
      amount: z.string().describe("Amount to bridge as decimal string e.g. 1.5"),
    },
    async ({ fromAddress, toAddress, sourceTokenAddress, destinationChain, destinationTokenSymbol, amount }) => {
      try {
        if (!algosdk.isValidAddress(fromAddress)) return failure("Invalid fromAddress");

        const sdk = getSdk();
        const chains = await sdk.chainDetailsMap();

        const sourceChain = chains[ChainSymbol.ALG];
        if (!sourceChain) return failure("Algorand chain not available");

        const sourceToken = sourceChain.tokens.find((t) => t.tokenAddress === sourceTokenAddress);
        if (!sourceToken) return failure("Token " + sourceTokenAddress + " not found on Algorand");

        const destChainData = chains[destinationChain];
        if (!destChainData) return failure("Destination chain " + destinationChain + " not supported");

        const destinationToken = destChainData.tokens.find((t) => t.symbol === destinationTokenSymbol);
        if (!destinationToken) return failure("Token " + destinationTokenSymbol + " not found on " + destinationChain);

        const estimatedReceive = await sdk.getAmountToBeReceived(amount, sourceToken, destinationToken);

        const rawTxn = await sdk.bridge.rawTxBuilder.send({
          amount,
          fromAccountAddress: fromAddress,
          toAccountAddress: toAddress,
          sourceToken,
          destinationToken,
          messenger: Messenger.ALLBRIDGE,
        });

        return success({
          txns: rawTxn,
          sourceToken: sourceToken.symbol,
          destinationToken: destinationToken.symbol,
          destinationChain,
          amount,
          estimatedReceive,
          fromAddress,
          toAddress,
        });
      } catch (err) {
        return failure(err.message);
      }
    }
  );

  // Check transfer status
  server.tool(
    "allbridge_transfer_status",
    "Check the status of an Allbridge cross-chain transfer by Algorand transaction ID.",
    {
      txId: z.string().describe("Algorand transaction ID of the bridge transaction"),
    },
    async ({ txId }) => {
      try {
        const sdk = getSdk();
        const status = await sdk.getTransferStatus(ChainSymbol.ALG, txId);
        return success(status);
      } catch (err) {
        return failure(err.message);
      }
    }
  );
}
