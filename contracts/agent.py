"""
AI Agent client for SpendingCapVault.

The agent holds its own private key and calls the vault contract directly.
The contract enforces all spending limits on-chain — the agent cannot exceed them
even if the key is compromised.

Usage:
    python agent.py --chain algorand --status
    python agent.py --chain algorand --status --agent <address>
    python agent.py --chain algorand --receiver <address> --amount 0.5 --note "x402 payment"
    python agent.py --chain voi --receiver <address> --amount 1.0 --note "MPP charge"
    python agent.py --chain algorand --receiver <address> --asa 31566704 --amount 0.01

Environment (.env):
    AGENT_MNEMONIC=<25-word mnemonic of the agent key>
    ALGORAND_APP_ID=<app id from deployments.json>
    VOI_APP_ID=<app id from deployments.json>
"""

import argparse
import json
import os
from pathlib import Path

from algosdk import mnemonic
from algosdk.v2client import algod
from algokit_utils import ApplicationClient, ApplicationSpecification, Account
from dotenv import load_dotenv

load_dotenv()

CHAINS = {
    "algorand": {
        "algod_url":   "https://mainnet-api.algonode.cloud",
        "algod_token": "",
        "app_id_env":  "ALGORAND_APP_ID",
        "decimals":    6,
        "ticker":      "ALGO",
    },
    "voi": {
        "algod_url":   "https://mainnet-api.voi.nodely.dev",
        "algod_token": "",
        "app_id_env":  "VOI_APP_ID",
        "decimals":    6,
        "ticker":      "VOI",
    },
}

ARC32_PATH = Path(__file__).parent / "spending_cap.arc32.json"


def get_client(chain: str) -> tuple[algod.AlgodClient, ApplicationClient, str]:
    cfg = CHAINS[chain]

    agent_sk      = mnemonic.to_private_key(os.environ["AGENT_MNEMONIC"])
    agent_account = Account(private_key=agent_sk)
    agent_address = agent_account.address

    app_id = int(os.environ[cfg["app_id_env"]])
    spec   = ApplicationSpecification.from_json(ARC32_PATH.read_text())

    algod_client = algod.AlgodClient(cfg["algod_token"], cfg["algod_url"])
    app_client   = ApplicationClient(
        algod_client=algod_client,
        app=spec,
        app_id=app_id,
        signer=agent_account,
    )
    return algod_client, app_client, agent_address


def pay_native(chain: str, receiver: str, amount_decimal: float, note: str) -> str:
    """
    Pay ALGO or VOI from the vault to receiver.
    Amount in decimal units (e.g. 1.5 ALGO). Contract enforces all limits.
    """
    cfg    = CHAINS[chain]
    micro  = int(amount_decimal * 10 ** cfg["decimals"])
    _, app, _ = get_client(chain)

    print(f"[agent] pay {amount_decimal} {cfg['ticker']} → {receiver[:20]}…")
    result = app.call(
        call_abi_method="pay",
        receiver=receiver,
        amount=micro,
        note=note,
    )
    tx_id = result.tx_id
    print(f"[agent] ✓ tx: {tx_id}")
    return tx_id


def pay_asa(chain: str, receiver: str, asset_id: int, amount_decimal: float, note: str) -> str:
    """Transfer an ASA (USDC / aUSDC) from the vault."""
    cfg    = CHAINS[chain]
    micro  = int(amount_decimal * 10 ** cfg["decimals"])
    _, app, _ = get_client(chain)

    print(f"[agent] pay_asa {amount_decimal} (ASA {asset_id}) → {receiver[:20]}…")
    result = app.call(
        call_abi_method="pay_asa",
        receiver=receiver,
        asset=asset_id,
        amount=micro,
        note=note,
    )
    tx_id = result.tx_id
    print(f"[agent] ✓ tx: {tx_id}")
    return tx_id


def get_vault_status(chain: str, agent_address_override: str | None = None) -> dict:
    """
    Read global vault state and (optionally) a specific agent's state.
    If agent_address_override is None, uses the signing agent's own address.
    """
    cfg = CHAINS[chain]
    d   = 10 ** cfg["decimals"]

    _, app, signing_agent = get_client(chain)

    # Global state
    g = app.call(call_abi_method="get_global_state").return_value
    (g_max_txn, g_daily_cap, g_max_asa, al_enabled,
     total_paid, total_paid_asa, tx_count) = g

    result = {
        "chain":             chain,
        "ticker":            cfg["ticker"],
        "global": {
            "max_per_txn":     g_max_txn / d,
            "daily_cap":       g_daily_cap / d,
            "max_asa_per_txn": g_max_asa / d,
            "allowlist":       "enabled" if al_enabled else "disabled",
            "total_paid":      total_paid / d,
            "total_paid_asa":  total_paid_asa / d,
            "tx_count":        tx_count,
        },
    }

    # Agent-specific state
    query_addr = agent_address_override or signing_agent
    try:
        ac = app.call(
            call_abi_method="get_agent_state",
            agent=query_addr,
        ).return_value
        # AgentConfig: (enabled, max_per_txn, daily_cap, day_bucket, day_spent)
        enabled, a_max, a_cap, bucket, spent = ac
        # Effective limits (0 = uses global)
        eff_max = (a_max or g_max_txn) / d
        eff_cap = (a_cap or g_daily_cap) / d
        result["agent"] = {
            "address":     query_addr,
            "enabled":     bool(enabled),
            "max_per_txn": a_max / d if a_max else f"global ({eff_max})",
            "daily_cap":   a_cap / d if a_cap else f"global ({eff_cap})",
            "day_spent":   spent / d,
            "day_remaining": (eff_cap - spent / d),
        }
    except Exception as exc:
        result["agent"] = {"address": query_addr, "error": str(exc)}

    return result


def main():
    parser = argparse.ArgumentParser(description="SpendingCapVault agent client")
    parser.add_argument("--chain",    required=True, choices=["algorand", "voi"])
    parser.add_argument("--receiver", help="Recipient address")
    parser.add_argument("--amount",   type=float,    help="Amount in decimal units")
    parser.add_argument("--asa",      type=int,      help="ASA ID for ASA transfer")
    parser.add_argument("--note",     default="",    help="Transaction note")
    parser.add_argument("--status",   action="store_true", help="Print vault state and exit")
    parser.add_argument("--agent",    help="Agent address to query (default: signing agent)")
    args = parser.parse_args()

    if args.status:
        state = get_vault_status(args.chain, agent_address_override=args.agent)
        print(json.dumps(state, indent=2))
        return

    if not args.receiver or args.amount is None:
        parser.error("--receiver and --amount required for payments")

    if args.asa:
        pay_asa(args.chain, args.receiver, args.asa, args.amount, args.note)
    else:
        pay_native(args.chain, args.receiver, args.amount, args.note)


if __name__ == "__main__":
    main()
